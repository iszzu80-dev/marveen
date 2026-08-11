// APG 0.4 review: F-3, F-8, F-9, F-10 — four ways a projection lied quietly.
//
// The common shape: the UI is a projection of the sidecar (§1.4), and every one
// of these turned a fact the sidecar knew into a different fact on screen —
// without an error anywhere. A dead endpoint that answers `{events: []}`, a
// renamed enum that maps "never ran" onto "running", an unreadable table that
// looks like an empty one, and a blocking gate that opens when the thing it
// gates on is unreachable.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { deriveDisplayState, APG_CHECKPOINT_RESULTS } from '../apg/ui-projection.js'

// The REAL DeriveDisplayStateInput. The first version of this fixture invented
// field names; vitest passed it happily (it does not typecheck) and tsc caught
// it — a green test that was not exercising the branch it claimed to.
const base = {
  latestTransitionState: null,
  latestCheckpointResult: 'PASS',
  latestCheckpoint: 'build',
  hasAssistedRecommendation: false,
  recommendationEvidenceCompleteness: null,
}

describe('F-8: the kernel result vocabulary is one contract, not two', () => {
  it('HEADLINE: the UI list matches the kernel RESULT_VALUES', () => {
    // Two repos, one contract. The kernel renamed NOT_APPLICABLE to EXCLUDED
    // and added ERROR; the UI still matched the old name, so both new values
    // fell through to "executing".
    const kernel = join(homedir(), 'marveen-local', 'apg-kernel', 'src', 'checkpoints.py')
    if (!existsSync(kernel)) return // kernel not checked out here — nothing to compare against
    const line = readFileSync(kernel, 'utf8').split('\n').find(l => l.includes('RESULT_VALUES'))
    expect(line).toBeTruthy()
    const kernelValues = [...line!.matchAll(/"([A-Z_]+)"/g)].map(m => m[1]).sort()
    expect([...APG_CHECKPOINT_RESULTS].sort()).toEqual(kernelValues)
  })

  it('EXCLUDED is not "executing" — a gate that never ran is not work in progress', () => {
    expect(deriveDisplayState({ ...base, latestCheckpointResult: 'EXCLUDED' })).toBe('clarification')
  })

  it('ERROR is surfaced as blocked, not as progress', () => {
    // An executor that returned nothing valid needs a human; showing it as a
    // running process is how it sits there for a week.
    expect(deriveDisplayState({ ...base, latestCheckpointResult: 'ERROR' })).toBe('blocked')
  })

  it('the OLD name still maps correctly — history is not rewritten by a rename', () => {
    // The kernel migration puts no CHECK on `result`, so pre-rename rows are
    // still in the store and still mean what they meant.
    expect(deriveDisplayState({ ...base, latestCheckpointResult: 'NOT_APPLICABLE' })).toBe('clarification')
  })

  it('a genuinely running gate is still "executing" — the counter-case', () => {
    expect(deriveDisplayState({ ...base, latestCheckpointResult: 'PASS' })).toBe('executing')
  })
})

describe('F-3: the Activity endpoint uses the driver, not a global nobody sets', () => {
  it('HEADLINE: no globalThis.BetterSqlite3 lookup remains', () => {
    // It waited on a global that NOTHING in the repo ever assigns — not the
    // app, not the tests — so §13's feed returned an error string on every
    // production call while looking like "no activity".
    const src = readFileSync(join(process.cwd(), 'src/apg/ui-projection.ts'), 'utf8')
    expect(src).not.toMatch(/globalThis as Record<string, unknown>\)\.BetterSqlite3/)
    // ...and the endpoint opens the sidecar the same way the rest of the file does.
    const fn = src.slice(src.indexOf('): ApgEventsResult | { error: string }'))
    expect(fn.slice(0, 900)).toMatch(/openApgKernelReadonly\(\)/)
  })
})

describe('F-9: an unreadable table is not an empty table', () => {
  it('HEADLINE: read failures are captured and surfaced, not swallowed', () => {
    const src = readFileSync(join(process.cwd(), 'src/apg/ui-projection.ts'), 'utf8')
    // The catch must record something before returning the empty array.
    const fn = src.slice(src.indexOf('function rowsOrEmpty'))
    expect(fn.slice(0, 700)).toMatch(/projectionReadErrors\.push/)
    // ...and the summary must put it in the response.
    expect(src).toMatch(/partial projection: \$\{readErrors\.length\}/)
  })
})

describe('F-10: the enforced archive gate holds when the sidecar is down', () => {
  it('HEADLINE: enforced mode no longer fails open on a fetch error', () => {
    const src = readFileSync(join(process.cwd(), 'web/apg.js'), 'utf8')
    // Anchor on the archive gate's OWN fetch — the same URL is fetched
    // elsewhere for display, and those catches are correctly fail-soft. Two
    // earlier versions of this assertion picked the wrong catch block, which is
    // exactly the kind of thing a source-reading test gets wrong quietly.
    const gate = src.slice(src.lastIndexOf('/api/apg/work-items?kanban_card_id='))
    // The old code was a bare `catch { return /* fail-open */ }`.
    expect(gate).not.toMatch(/catch \{ return \/\* fail-open \*\//)
    // Enforced must block; the advisory modes may still let it through.
    // Scope to the CATCH block — the success path has its own preventDefault,
    // and comparing offsets across both is what made the first version of this
    // assertion compare the wrong pair.
    const catchStart = gate.indexOf('} catch {')
    const catchBlock = gate.slice(catchStart, catchStart + 900)
    expect(catchBlock).toMatch(/if \(state\.mode !== 'enforced'\) return/)
    expect(catchBlock.indexOf("state.mode !== 'enforced'")).toBeLessThan(catchBlock.indexOf('event.preventDefault()'))
  })
})
