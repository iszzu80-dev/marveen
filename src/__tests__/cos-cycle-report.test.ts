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

/** The merge + detection logic of scripts/cos-cycle.ts, applied to fixture
 *  lines. Kept as a local re-implementation on purpose: the script is a
 *  top-level-await entry point that spawns four child processes on import, so
 *  importing it here would run a live cycle. The SHAPE it must handle is what
 *  these tests own; the last test pins that the script still contains the
 *  nested check itself. */
function detect(lines: string[]): string[] {
  let parsed: Record<string, unknown> | null = null
  for (const line of lines) {
    const brace = line.indexOf('{')
    if (brace < 0) continue
    try {
      parsed = { ...(parsed ?? {}), ...JSON.parse(line.slice(brace)) as Record<string, unknown> }
    } catch { /* not this line */ }
  }
  const problems: string[] = []
  const failedIn = (o: unknown): { failed?: boolean; error?: string } | null =>
    (o && typeof o === 'object' && (o as { failed?: unknown }).failed === true)
      ? (o as { failed?: boolean; error?: string }) : null
  if (parsed) {
    const self = failedIn(parsed)
    if (self) problems.push(`step: ${self.error ?? 'reported failed:true'}`)
    for (const [k, v] of Object.entries(parsed)) {
      const nested = failedIn(v)
      if (nested) problems.push(`step/${k}: ${nested.error ?? 'reported failed:true'}`)
    }
  }
  return problems
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

  it('STANDING CHECK: the script itself still inspects nested payloads', () => {
    const src = readFileSync(resolve(process.cwd(), 'scripts/cos-cycle.ts'), 'utf8')
    expect(src).toMatch(/Object\.entries\(p\)/)
    expect(src).toMatch(/failedIn/)
  })
})
