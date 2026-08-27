// The cycle runner's failure detection, and the two shapes it must not miss.
//
// scripts/cos-cycle.ts merges every JSON line a step prints into ONE object and
// then looks for `failed: true`. Two things broke that on 2026-08-11, both
// introduced by wiring a second subsystem into the same step:
//
//   1. Spreading the Reader's counters at the top level made `remaining` and
//      `failures` collide with goal enrichment's. The report then showed one
//      subsystem's number under both names, and nothing said which.
//   2. Nesting them under `reader` fixed the collision and immediately hid
//      `failed: true` from a top-level-only check — a silent failure created by
//      the fix for a misleading one.
//
// The runner's whole purpose is that a step which half-ran must not look like a
// clean one, so both shapes are pinned here rather than trusted to review.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectProblems } from '../cos/cycle-problems.js'

/** The merge scripts/cos-cycle.ts performs on a step's stdout, applied to
 *  fixture lines, then handed to the REAL detector.
 *
 *  The merge is still re-implemented here (the script is an entry point that
 *  spawns thirteen processes on import), but the DETECTION no longer is: it was
 *  extracted to src/cos/cycle-problems.ts on 2026-08-27, after a third silent
 *  failure got past it. A local copy of the rule under test is the copy that
 *  drifts, and this file's own header used to admit as much. */
function detect(lines: string[]): string[] {
  let parsed: Record<string, unknown> | null = null
  for (const line of lines) {
    const brace = line.indexOf('{')
    if (brace < 0) continue
    try {
      parsed = { ...(parsed ?? {}), ...JSON.parse(line.slice(brace)) as Record<string, unknown> }
    } catch { /* not this line */ }
  }
  return collectProblems('step', parsed)
}

describe('cycle report failure detection', () => {
  it('catches a top-level failed:true (the no-interpreter case)', () => {
    const problems = detect([
      'Heartbeat: {"personal":0,"skippedNoTrigger":90}',
      'GoalEnrichment: {"enriched":0,"failed":true,"error":"no interpreter configured"}',
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/no interpreter configured/)
  })

  it('HEADLINE: catches failed:true nested one level down', () => {
    // Exit code 0, three of four steps fine, and the Reader dead. Before the
    // nested check this produced `problems: []`.
    const problems = detect([
      'Heartbeat: {"personal":1}',
      'Reader: {"reader":{"read":0,"failed":true,"error":"model exploded"}}',
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/step\/reader: model exploded/)
  })

  it('two subsystems keep their own counters through the merge', () => {
    // The collision, stated as a test: both report a `remaining`, and the
    // reader's is nested, so neither overwrites the other.
    const merged = [
      'GoalEnrichment: {"enriched":2,"remaining":11,"failures":[]}',
      'Reader: {"reader":{"read":3,"remaining":95,"failures":[]}}',
    ]
    let parsed: Record<string, any> = {}
    for (const l of merged) parsed = { ...parsed, ...JSON.parse(l.slice(l.indexOf('{'))) }
    expect(parsed.remaining).toBe(11)
    expect(parsed.reader.remaining).toBe(95)
    expect(parsed.enriched).toBe(2)
    expect(parsed.reader.read).toBe(3)
  })

  it('a healthy cycle produces no problems', () => {
    // The counter-case: a detector that fires on everything is not a detector.
    expect(detect([
      'Heartbeat: {"personal":0,"skippedNoTrigger":90}',
      'Reader: {"reader":{"read":3,"refused":0,"conflicts":0}}',
    ])).toEqual([])
  })

  it('HEADLINE 2: a non-empty failures array is a problem (live 2026-08-11)', () => {
    // The exact line this runner printed while calling itself clean: the channel
    // step could not deliver an owner question, said so in `failures`, exited 0
    // — and `problems` was empty. A question that never reached Istvan was filed
    // under "cycle fine".
    const problems = detect([
      'CosChannel: {"channel":"telegram:cos","pending":1,"sent":0,'
        + '"failures":[{"caseId":"case-private-19f4c2ec1256e723","error":"telegram sendMessage failed: fetch failed"}]}',
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/1 failed: case-private-19f4c2ec1256e723: telegram sendMessage failed/)
  })

  it('catches per-item failures nested under a subsystem too', () => {
    // The reader and goal enrichment report theirs one level down, for the same
    // reason the `failed` flag had to be checked at both depths.
    const problems = detect([
      'Reader: {"reader":{"read":2,"failures":[{"caseId":"personal/c1","error":"model timeout"},'
        + '{"caseId":"personal/c2","error":"model timeout"}]}}',
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/step\/reader: 2 failed: personal\/c1: model timeout \(\+1 more\)/)
  })

  it('an EMPTY failures array is not a problem', () => {
    // The counter-case, and the reason the check tests length rather than
    // presence: every one of these steps reports `failures: []` on a good run.
    expect(detect([
      'GoalEnrichment: {"enriched":2,"remaining":11,"failures":[]}',
      'Reader: {"reader":{"read":3,"failures":[]}}',
      'CosChannel: {"pending":0,"sent":0,"failures":[]}',
    ])).toEqual([])
  })

  it('STANDING CHECK: the runner still routes its payloads through the real detector', () => {
    // A grep, and a weak one on its own -- so it checks the WIRING, which is the
    // part a test cannot otherwise reach, and leaves the RULE to the tests above
    // that call collectProblems directly.
    const src = readFileSync(resolve(process.cwd(), 'scripts/cos-cycle.ts'), 'utf8')
    expect(src).toMatch(/collectProblems\(s\.name, parsed\)/)
    expect(src).toMatch(/from '\.\.\/src\/cos\/cycle-problems\.js'/)
  })
})

// ── The third door, found live on 2026-08-27 ────────────────────────────────
//
// During the P2 post-cutover acceptance, two cycles run concurrently produced
// SQLite contention. The progression step reported it honestly. The runner did
// not read it:
//
//   "progression": { "cycleErrors": 1, "errors": ["…: database is locked"] }
//   "problems": []
//
// The contention was a test artefact. The blindness was not: `errors` and
// `cycleErrors` are simply different words for what `failures` and `failed`
// already meant, and the detector only knew the older two.
describe('cycle report — a step that says it failed, in any of its words', () => {
  it('HEADLINE: a non-empty `errors` array is a problem (live 2026-08-27)', () => {
    const problems = detect([
      'Heartbeat: {"personalProgressed":0,"cycleErrors":1,'
        + '"errors":["personal/case-private-1a03ebafc5167240: database is locked"]}',
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/database is locked/)
  })

  it('a bare-string entry is described, not rendered as [object Object]', () => {
    // `failures` carries objects, `errors` carries strings. A list nobody can
    // read is a list nobody reads.
    const problems = detect(['S: {"errors":["a: boom","b: bang"]}'])
    expect(problems[0]).toBe('step: 2 failed: a: boom (+1 more)')
  })

  it('a COUNT with no detail is still a failure, and says so', () => {
    // cycleErrors:3 with an empty errors array is not "no problem" -- it is a
    // step that failed three times and cannot say how, which is the shape a
    // truncated payload takes.
    const problems = detect(['S: {"cycleErrors":3,"errors":[]}'])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/cycleErrors: 3, but the payload carries no detail/)
  })

  it('a count is NOT reported twice when the list already spoke', () => {
    // The counter-case: duplicate reporting of every real failure teaches the
    // reader to skim, which is how the one that matters gets missed.
    const problems = detect(['S: {"cycleErrors":1,"errors":["x: boom"]}'])
    expect(problems).toHaveLength(1)
  })

  it('cycleErrors: 0 alongside an empty errors array is clean', () => {
    // Every healthy progression payload looks exactly like this.
    expect(detect(['S: {"personalProgressed":0,"cycleErrors":0,"errors":[]}'])).toEqual([])
  })

  it('an `errors` array nested one level down is caught too', () => {
    expect(detect(['S: {"reader":{"read":0,"errors":["model exploded"]}}'])[0])
      .toMatch(/step\/reader: 1 failed: model exploded/)
  })
})
