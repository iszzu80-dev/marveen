// APG 1.9 §25 -- the unaccepted-archive control, moved to where a control has
// to live to be one.
//
// The 1.8 conformance audit's first security finding (§3.1): "Az »enforced« mód
// egyetlen tényleges blokkoló kontrollja böngésző-oldali JavaScript."
// web/apg.js:1067-1110 gated the archive; the server's
// POST /api/kanban/:id/archive had no APG check at all. One curl with the
// shared token -- which every dispatched agent is handed -- archived
// unaccepted work, and the dashboard's own §9.5 "done ≠ accepted" projection
// never saw it. A control that only the client runs is a UI affordance.
//
// The client check STAYS. It is good UX: it explains the refusal in a dialog
// before a round trip, and it can offer the assisted-mode confirm. It is simply
// no longer the thing that refuses.
//
// §25's ladder is implemented literally, and the three rungs differ from each
// other on purpose:
//
//   OBSERVE   "fail-open + explicit degraded state". The control RUNS (observe
//             is the measuring mode -- §35's Stage 1 window only fills if it
//             does) and never blocks. If the sidecar is unreachable the answer
//             is not silence: `degraded: true` with the reason, which is the
//             explicit degraded state the section asks for.
//
//   ASSISTED  "Ne mutass hamis PASS-t." The archive proceeds -- assisted stops
//             at owner decisions, not at every gate -- but the response states
//             `accepted: false` when the work item is unaccepted, and
//             `degraded: true` when the control could not run. Neither case is
//             ever reported as a pass.
//
//   ENFORCED  "fail-closed". Unaccepted work is refused, AND a control-plane
//             failure is refused: the sidecar being down is exactly when the
//             gate must hold, because an archive is not reversible from the
//             dialog that started it. Only this route stops -- the rest of the
//             dashboard, and every non-APG Marveen path, is untouched, which is
//             §25's "Csak az AGP-controlled progression álljon meg".
//
// The whole decision is a pure function over injected deps so both the
// fail-closed and the unaccepted branch are directly testable without a kernel
// sidecar on disk.

import type { ApgMode, ApgModeSource, ApgUiWorkItemSummary } from '../apg/ui-types.js'
import { buildApgWorkItemSummaries } from '../apg/ui-read-model.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { resolveEffectiveApgMode } from './apg-scope-overrides.js'

/** What the route reports back about the control, in every outcome. */
export interface ArchiveGateReport {
  mode: ApgMode
  mode_source: ApgModeSource
  /** Did the control actually run against the sidecar? */
  checked: boolean
  /** Null when unchecked; otherwise whether the card's work is accepted. */
  accepted: boolean | null
  /** §25 observe/assisted: the control could not run and we say so. */
  degraded: boolean
  reason: string
  blocked: boolean
}

export type ArchiveGateDecision =
  | { allow: true; report: ArchiveGateReport }
  | { allow: false; status: number; error: string; report: ArchiveGateReport }

export interface ArchiveGateDeps {
  resolveMode: (project: string | null, cardId: string) => { mode: ApgMode; source: ApgModeSource }
  /** APG_BLOCK_UNACCEPTED_ARCHIVE -- the operator switch this control obeys. */
  isControlEnabled: () => boolean
  listWorkItems: (
    mode: ApgMode,
    cardId: string,
  ) => { items: ApgUiWorkItemSummary[] } | { error: string }
}

export function defaultArchiveGateDeps(): ArchiveGateDeps {
  return {
    resolveMode: (project, cardId) => resolveEffectiveApgMode(project, cardId),
    isControlEnabled: () =>
      String(getEffectiveSettingValue('APG_BLOCK_UNACCEPTED_ARCHIVE')) === '1',
    listWorkItems: (mode, cardId) =>
      buildApgWorkItemSummaries(mode, { kanbanCardId: cardId, limit: 1, offset: 0 }),
  }
}

/**
 * The same "is this work item unaccepted" predicate the client uses, so the two
 * cannot drift into disagreeing about what they are blocking.
 *
 * `not_started` is excluded deliberately: a card with no APG activity at all is
 * not unaccepted work, it is un-instrumented work, and blocking it would make
 * enforced mode block every ordinary card on the board -- which is how a
 * fail-closed control gets switched off within a day.
 */
export function isUnacceptedWorkItem(item: ApgUiWorkItemSummary): boolean {
  return (
    item.effective_mode !== 'off'
    && item.acceptance_status !== 'accepted'
    && item.acceptance_status !== 'not_started'
  )
}

export function evaluateArchiveGate(
  input: { cardId: string; project: string | null },
  deps: ArchiveGateDeps = defaultArchiveGateDeps(),
): ArchiveGateDecision {
  const { mode, source } = deps.resolveMode(input.project, input.cardId)
  const base = { mode, mode_source: source, blocked: false }

  if (mode === 'off') {
    return {
      allow: true,
      report: { ...base, checked: false, accepted: null, degraded: false, reason: 'apg_off' },
    }
  }
  if (!deps.isControlEnabled()) {
    // The operator switched the control off. That is a policy choice with a
    // name, not a silent pass -- the response says which switch decided.
    return {
      allow: true,
      report: {
        ...base,
        checked: false,
        accepted: null,
        degraded: false,
        reason: 'control_disabled:APG_BLOCK_UNACCEPTED_ARCHIVE',
      },
    }
  }

  let result: { items: ApgUiWorkItemSummary[] } | { error: string }
  try {
    result = deps.listWorkItems(mode, input.cardId)
  } catch (err) {
    // The read model already degrades internally; this is the belt for anything
    // that escapes it, and it must land in the SAME branch as a reported error
    // rather than as an unhandled 500 that reads like a server bug.
    result = { error: err instanceof Error ? err.message : String(err) }
  }

  if ('error' in result) {
    const reason = `control_plane_unavailable:${result.error}`
    if (mode === 'enforced') {
      return {
        allow: false,
        status: 403,
        error:
          'APG 1.9 §25: enforced mode fails closed. The APG control plane could not be read, '
          + 'so acceptance cannot be verified, and archiving unaccepted work is not reversible '
          + 'from here. Fix the sidecar or change the mode for this scope.',
        report: { ...base, checked: false, accepted: null, degraded: true, reason, blocked: true },
      }
    }
    // observe + assisted: fail open, but never silently. `degraded: true` is
    // the explicit degraded state, and `accepted: null` refuses to imply a pass.
    return {
      allow: true,
      report: { ...base, checked: false, accepted: null, degraded: true, reason },
    }
  }

  const unaccepted = result.items.find(isUnacceptedWorkItem)
  if (!unaccepted) {
    return {
      allow: true,
      report: { ...base, checked: true, accepted: true, degraded: false, reason: 'accepted_or_no_work_item' },
    }
  }

  const reason = `unaccepted_work_item:${unaccepted.acceptance_status}`
  if (mode === 'enforced') {
    return {
      allow: false,
      status: 403,
      error:
        'APG 1.9 §9.5/§25: this card has APG work that is not accepted, and the scope is '
        + 'enforced. Archiving it would close out unaccepted work. Accept it, or downgrade '
        + 'the scope through the audited override path.',
      report: { ...base, checked: true, accepted: false, degraded: false, reason, blocked: true },
    }
  }
  // Assisted (and observe): the archive proceeds, and the response says plainly
  // that it archived unaccepted work. That is the anti-false-PASS requirement.
  return {
    allow: true,
    report: { ...base, checked: true, accepted: false, degraded: false, reason },
  }
}
