// P2-B: the checkpoint artifact -- short, reference-based, durable, and REUSING
// the existing HANDOFF.md machinery rather than inventing a second one.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  renderCheckpoint,
  validateCheckpoint,
  REQUIRED_HANDOFF_SECTIONS,
  type SessionCheckpoint,
} from '../session-checkpoint.js'
import { artifactRefFromContent, hashContent, MAX_EXCERPT_CHARS, MAX_NOTE_CHARS, TARGET_FRESH_TOKENS } from '../context-packet.js'
import { handoffPrompt, resumePrompt } from '../web/context-guard-runner.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..')

const FULL_DIFF = [
  'diff --git a/src/x.ts b/src/x.ts',
  '--- a/src/x.ts',
  '+++ b/src/x.ts',
  '@@ -1,4 +1,9 @@',
  ...Array.from({ length: 200 }, (_, i) => `+  const line${i} = ${i}`),
].join('\n')

function cp(over: Partial<SessionCheckpoint> = {}): SessionCheckpoint {
  return {
    agent: 'dev1',
    cardId: 'a1b2c3d4',
    dispatchId: '11111111-2222-3333-4444-555555555555',
    generatedAt: '2026-07-20T09:00:00Z',
    goal: 'Add per-model token aggregation to the dashboard usage page.',
    workDone: ['Aggregation query written and unit-tested', 'Route wired, UI column added'],
    filesChanged: ['src/costops/aggregate.ts', 'src/web/routes/usage.ts'],
    commit: 'abc1234',
    diffBase: 'def5678',
    whatWorked: ['Reusing costops/pricing.ts instead of a second cost formula'],
    whatDidNotWork: ['Grouping in JS first -- too slow on 400k rows; moved into SQL'],
    decisions: ['Unpriced models render "unknown", never 0 (owner rule)'],
    openQuestions: ['Should cache-creation tokens be a separate column?'],
    nextStep: 'Run npx vitest run src/__tests__/usage-aggregate.test.ts and fix the two failing cases.',
    furtherSteps: ['Then npm run build and post the result on card a1b2c3d4'],
    ...over,
  }
}

describe('P2-B checkpoint: reuses the existing HANDOFF.md shape', () => {
  it('renders all five canonical /handoff sections, in order', () => {
    const text = renderCheckpoint(cp())
    let cursor = -1
    for (const h of REQUIRED_HANDOFF_SECTIONS) {
      const at = text.indexOf(`\n${h}\n`)
      expect(at, h).toBeGreaterThan(cursor)
      cursor = at
    }
  })

  it('the sections it renders are exactly the ones the LIVE runner asks for', () => {
    // handoffPrompt names the sections it expects; assert we render those names.
    const asked = handoffPrompt(93, '/tmp/HANDOFF.md')
    for (const name of ['Goal', 'Current Progress', 'What Worked', 'Next Steps']) {
      expect(asked, name).toContain(name)
      expect(renderCheckpoint(cp())).toContain(`## ${name}`)
    }
    expect(asked).toContain("What Didn't Work")
    expect(renderCheckpoint(cp())).toContain("## What Didn't Work")
    // And the resume side points at the same file, so no second convention.
    expect(resumePrompt('dev1', '/tmp/HANDOFF.md', true)).toContain('/tmp/HANDOFF.md')
  })

  it('does not introduce a parallel handoff detector or path convention', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'session-checkpoint.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    expect(src).not.toMatch(/CHECKPOINT\.md|checkpoint\.md/)
    expect(src).not.toMatch(/writeFileSync|statSync|mtimeMs/)
  })
})

describe('P2-B checkpoint: carries every required field', () => {
  it('renders card id, dispatch id, goal, work, files, commit, decisions, questions, next step', () => {
    const text = renderCheckpoint(cp())
    expect(text).toContain('card a1b2c3d4')
    expect(text).toContain('dispatch 11111111-2222-3333-4444-555555555555')
    expect(text).toContain('Add per-model token aggregation')
    expect(text).toContain('Aggregation query written and unit-tested')
    expect(text).toContain('`src/costops/aggregate.ts`')
    expect(text).toContain('Commit: abc1234')
    expect(text).toContain('## Decisions')
    expect(text).toContain('Unpriced models render "unknown"')
    expect(text).toContain('## Open questions')
    expect(text).toContain('Should cache-creation tokens be a separate column?')
    expect(text).toContain('1. Run npx vitest run')
    expect(text).toContain('2. Then npm run build')
  })

  it('carries the diff as a COMMAND against a pinned base, never an inlined diff', () => {
    const text = renderCheckpoint(cp())
    expect(text).toContain('Diff: `git diff def5678..abc1234`')
    expect(text).not.toContain('diff --git')
    // With no explicit base it still yields a runnable command.
    expect(renderCheckpoint(cp({ diffBase: null }))).toContain('git diff abc1234~1..abc1234')
  })

  it('renders deterministically and stays short', () => {
    expect(renderCheckpoint(cp())).toBe(renderCheckpoint(cp()))
    const v = validateCheckpoint(cp())
    expect(v.estimate.confidence).toBe('estimated')
    expect(v.estimate.tokens).toBeLessThan(TARGET_FRESH_TOKENS)
  })

  it('is valid, and reference-based material passes through the packet validator', () => {
    const withRef = cp({ references: [artifactRefFromContent('docs/plan.md', 'abc1234', 'x'.repeat(5000), { excerpt: 'step 3 is the blocker' })] })
    const v = validateCheckpoint(withRef)
    expect(v.errors).toEqual([])
    expect(v.ok).toBe(true)
    expect(renderCheckpoint(withRef)).toContain('`docs/plan.md` @ abc1234')
  })
})

describe('P2-B checkpoint: must be resumable', () => {
  it('rejects a checkpoint with no goal, no next step, no agent, or no work item', () => {
    expect(validateCheckpoint(cp({ goal: '  ' })).errors.map(e => e.code)).toContain('goal_missing')
    expect(validateCheckpoint(cp({ nextStep: '' })).errors.map(e => e.code)).toContain('next_step_missing')
    expect(validateCheckpoint(cp({ agent: '' })).errors.map(e => e.code)).toContain('agent_missing')
    expect(validateCheckpoint(cp({ cardId: null, dispatchId: null })).errors.map(e => e.code)).toContain('no_work_item')
  })

  it('accepts a dispatch id alone as the traceable work item', () => {
    expect(validateCheckpoint(cp({ cardId: null })).ok).toBe(true)
  })
})

describe('P2-B checkpoint: stays reference-based', () => {
  it('REJECTS an inlined unified diff', () => {
    const v = validateCheckpoint(cp({ workDone: ['Changed x:', FULL_DIFF] }))
    expect(v.ok).toBe(false)
    expect(v.errors.map(e => e.code)).toContain('inlined_diff')
  })

  it('REJECTS a pasted document in the body', () => {
    const v = validateCheckpoint(cp({ decisions: ['a'.repeat(4000)] }))
    expect(v.ok).toBe(false)
    expect(v.errors.map(e => e.code)).toContain('inlined_material')
  })

  it('REJECTS an over-long excerpt on a reference, via the SHARED packet rule', () => {
    const v = validateCheckpoint(cp({
      references: [{ path: 'docs/a.md', ref: 'abc1234', contentHash: hashContent('x'), excerpt: 'y'.repeat(MAX_EXCERPT_CHARS + 1) }],
    }))
    expect(v.ok).toBe(false)
    expect(v.errors.map(e => e.code)).toContain('reference_invalid')
    expect(v.referenceValidation.errors.map(e => e.code)).toContain('excerpt_too_long')
  })

  it('OPT-M7: REJECTS an over-long reference NOTE, inherited through the SAME delegated packet rule', () => {
    // The packet-side code is 'reference_note_too_long' -- the reference_
    // prefix is what makes the checkpoint's delegation filter forward it, so
    // the note cap needs no second implementation here.
    const v = validateCheckpoint(cp({
      references: [{ path: 'docs/a.md', ref: 'abc1234', contentHash: hashContent('x'), note: 'n'.repeat(MAX_NOTE_CHARS + 1) }],
    }))
    expect(v.ok).toBe(false)
    expect(v.errors.map(e => e.code)).toContain('reference_invalid')
    expect(v.referenceValidation.errors.map(e => e.code)).toContain('reference_note_too_long')
  })

  it('REJECTS a checkpoint carrying something shaped like a credential', () => {
    const v = validateCheckpoint(cp({ decisions: ['Used sk-abcdefghijklmnopqrstuvwxyz012345 for the probe'] }))
    expect(v.ok).toBe(false)
    expect(v.errors.map(e => e.code)).toContain('possible_secret')
  })
})
