// What the owner READS where the engine's own words may not go.
//
// The engine's next-best-action text is a closed set of internal English plan
// labels, and `isUsableRecommendation` refuses to show any of them to Istvan --
// "Javaslatom: Execute first recovery action" reached him once already. P1
// measured the consequence: of 76 active personal cases, 76 have a next-action
// KIND and 0 have a showable next-action SENTENCE. The board could say that a
// next step exists and could not say anything about it.
//
// So the kind is rendered here, deterministically, in Hungarian.
//
// THREE RULES THIS MODULE OBEYS, all three of them the owner's, 2026-08-26:
//
//   IT IS PRESENTATION, NOT STATE. Nothing calls this on a write path. The
//   result is never stored in a column, which is why it can be changed by
//   editing this file rather than by migrating a hundred rows.
//
//   IT NEVER BECOMES TRUSTED INPUT. `case-link`'s TRUSTED_CASE_FIELDS decide
//   which text may auto-link a stranger's incoming mail to a case. This output
//   is not one of those fields and must never be written into one: a rendering
//   the system generated for itself is not evidence that the owner recorded
//   anything.
//
//   IT IS A MAPPING, NOT A MODEL. An enum in, a fixed string out. No call, no
//   inference, no cleverness -- so it cannot fail at runtime, cannot leak, and
//   cannot say something different tomorrow about the same case.
//
// A kind this file does not know returns null rather than a guess. A cheerful
// fallback ("Következő lépés") would make an unmapped enum indistinguishable
// from a mapped one, and the board would quietly stop reflecting the engine's
// vocabulary the day someone adds a kind. A test drives the planner to
// enumerate the real vocabulary and fails on anything unmapped.

import type { RollingPlanStep } from './progression-pipeline.js'

export type ActionKind = RollingPlanStep['kind']

/** Kind -> what Istvan sees. Short noun phrases: this sits in a table cell next
 *  to the case title, not in a sentence. */
const LABELS: Record<ActionKind, string> = {
  GATHER_INFO:    'Információt kell gyűjteni',
  AWAIT_EXTERNAL: 'Külső válaszra vár',
  AWAIT_DECISION: 'Döntésre vár',
  EXECUTE:        'Végrehajtandó lépés',
  VERIFY:         'Ellenőrzés',
  COMMUNICATE:    'Visszajelzést kell adni',
  RECOVER:        'Hibából kell visszaállni',
}

/** Who the label implies is holding the ball. The board already has an owner
 *  column for cases where somebody wrote one down; this is the engine's view,
 *  and the two are shown separately rather than merged, because a disagreement
 *  between them is information. */
const BALL: Record<ActionKind, 'engine' | 'owner' | 'external'> = {
  GATHER_INFO: 'engine',
  AWAIT_EXTERNAL: 'external',
  AWAIT_DECISION: 'owner',
  EXECUTE: 'engine',
  VERIFY: 'engine',
  COMMUNICATE: 'engine',
  RECOVER: 'engine',
}

export interface RenderedAction {
  kind: ActionKind
  label: string
  ballHolder: 'engine' | 'owner' | 'external'
}

/** Render a next-action kind for the owner. `null` for anything unmapped or
 *  absent -- see the header on why there is no friendly fallback. */
export function renderActionKind(kind: string | null | undefined): RenderedAction | null {
  if (!kind) return null
  if (!(kind in LABELS)) return null
  const k = kind as ActionKind
  return { kind: k, label: LABELS[k], ballHolder: BALL[k] }
}

/** The kinds this module can render. Exported so a test can compare it against
 *  the vocabulary the PLANNER actually emits rather than against a list
 *  somebody retyped -- the TEST_ORACLE_DEFECT rule (2026-08-26). */
export function renderableActionKinds(): Set<string> {
  return new Set(Object.keys(LABELS))
}
