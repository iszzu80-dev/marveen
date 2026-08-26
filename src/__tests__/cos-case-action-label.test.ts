// The owner-facing rendering of the engine's next-action kind.
//
// P1 measured the gap this closes: 76 of 76 active personal cases carry a
// next-action KIND and 0 carry a next-action SENTENCE Istvan is allowed to see,
// because the engine's text is a closed set of internal English plan labels and
// `isUsableRecommendation` refuses all of them. Invariant A held as a fact while
// the board could say nothing about what the fact was.

import { describe, it, expect } from 'vitest'
import { renderActionKind, renderableActionKinds } from '../cos/case-action-label.js'
import { buildRollingPlan, internalPlanLabels } from '../cos/progression-pipeline.js'
import { CASE_STATUSES } from '../cos/schema.js'

/** Every kind the PLANNER can emit, enumerated by driving it -- not retyped.
 *  A kind added to the switch tomorrow is in this set the moment it exists. */
function plannerKinds(): Set<string> {
  const kinds = new Set<string>()
  // Stubs typed off the function itself, so a signature change is a compile
  // error here rather than a silently narrower enumeration.
  const c = {} as Parameters<typeof buildRollingPlan>[0]
  const ctx = {} as Parameters<typeof buildRollingPlan>[1]
  for (const status of [...CASE_STATUSES, '__NO_SUCH_STATUS__']) {
    for (const step of buildRollingPlan(c, ctx, status)) kinds.add(step.kind)
  }
  return kinds
}

describe('next-action kind, rendered for the owner', () => {
  it('ORACLE: every kind the planner can emit has a Hungarian label', () => {
    // The failure this prevents is silent: an unmapped kind renders as null, the
    // board shows a blank cell, and nothing says the vocabulary moved.
    const unmapped = [...plannerKinds()].filter(k => !renderableActionKinds().has(k))
    expect(unmapped).toEqual([])
  })

  it('renders a label and who holds the ball', () => {
    expect(renderActionKind('AWAIT_DECISION')).toEqual({
      kind: 'AWAIT_DECISION', label: 'Döntésre vár', ballHolder: 'owner',
    })
    expect(renderActionKind('AWAIT_EXTERNAL')?.ballHolder).toBe('external')
    expect(renderActionKind('EXECUTE')?.ballHolder).toBe('engine')
  })

  it('an unknown or absent kind renders NOTHING, not a friendly guess', () => {
    // A cheerful fallback would make an unmapped enum indistinguishable from a
    // mapped one, and the oracle above would stop being able to fail.
    expect(renderActionKind(null)).toBeNull()
    expect(renderActionKind(undefined)).toBeNull()
    expect(renderActionKind('')).toBeNull()
    expect(renderActionKind('SOMETHING_NEW')).toBeNull()
  })

  it('no rendered label is one of the engine\'s own banned English strings', () => {
    // The whole point: this exists BECAUSE those strings may not be shown.
    // Rendering one of them here would be the same defect wearing a new column.
    const banned = internalPlanLabels()
    for (const kind of renderableActionKinds()) {
      const r = renderActionKind(kind)!
      expect(banned.has(r.label)).toBe(false)
      // ...and it is actually Hungarian, not the enum with underscores removed.
      expect(r.label).toMatch(/[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/)
    }
  })

  it('is a pure mapping: same input, same output, no clock and no database', () => {
    const a = renderActionKind('RECOVER')
    const b = renderActionKind('RECOVER')
    expect(a).toEqual(b)
  })
})
