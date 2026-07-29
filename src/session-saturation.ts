// Lean Optimization Phase 2 / P2-B -- session saturation states + dispatch
// admission. Pure logic (no clock, tmux, fs, db, network, model), so the whole
// state machine is unit-testable; the deployment-local config loader lives in
// src/web/session-efficiency-store.ts.
//
// WHY this exists on top of src/context-guard.ts, rather than inside it:
// context-guard.ts answers "should I make this session hand off / restart?" --
// a PUSH decision about a session's own lifecycle. This module answers a
// different question, on a different code path: "may this work package be sent
// INTO that session at all?" -- an ADMISSION decision at the dispatch origin.
// The live guard has no such gate, which is how a large work package could be
// dropped into a session already at 95% and lose it to the restart that
// followed. decideGuard() is untouched by this module.
//
// BEHAVIOUR NEUTRALITY (verified against live code, not prose):
//  - context-guard.ts:54-55 -- live defaults actPct 0.90 / hardPct 0.97.
//  - context-guard.ts:53,83 -- the pane-saturation net is always on
//    (saturationRestart defaults true, independent of `enabled`).
//  - context-guard.ts:104-142 -- `pct` is measured against a per-(agent,model)
//    CALIBRATED limit, not a static 200k.
// So checkpointRequiredPct defaults to exactly actPct and hardStopPct to exactly
// hardPct (asserted by a test, so a future "restore the 85/90/92/97 tiers" edit
// goes red), and a saturated pane maps to `hard_stop` regardless of pct, exactly
// like the live always-on net. The two ADDITIVE tiers -- `warning` and
// `no_new_large_task` -- have no analogue in the live guard: they gate nothing
// that existed before, only the new admission decision, so they cannot change
// any decision the shipped guard makes today.
//
// NO LLM anywhere in this module: task size comes from explicit dispatch
// metadata or a deterministic workflow-policy lookup (kanban label / card type).
// Nothing here estimates, infers, or asks a model what size a task is.

import type { TaskSize } from './context-packet.js'
export type { TaskSize }

// ---- states ----------------------------------------------------------------

/**
 * Saturation state of one session, most-to-least severe:
 *  - `hard_stop`          -- pane saturated, or pct >= hardStopPct. The live
 *                            guard force-restarts here; nothing large may enter.
 *  - `checkpoint_required`-- pct >= checkpointRequiredPct (== live actPct). The
 *                            live guard asks for a HANDOFF.md here.
 *  - `no_new_large_task`  -- pct >= noNewLargeTaskPct. Additive tier: the session
 *                            is still working fine, but is too close to its
 *                            handoff point to be given a large package.
 *  - `warning`            -- pct >= warningPct. Advisory only; gates nothing.
 *  - `ok`                 -- below every tier, or unmeasurable.
 */
export type SaturationState = 'ok' | 'warning' | 'no_new_large_task' | 'checkpoint_required' | 'hard_stop'

/** Severity order, used for at-or-above comparisons. */
export const SATURATION_ORDER: readonly SaturationState[] = [
  'ok', 'warning', 'no_new_large_task', 'checkpoint_required', 'hard_stop',
] as const

export function saturationSeverity(s: SaturationState): number {
  const i = SATURATION_ORDER.indexOf(s)
  return i < 0 ? 0 : i
}

export function atOrAbove(state: SaturationState, floor: SaturationState): boolean {
  return saturationSeverity(state) >= saturationSeverity(floor)
}

// ---- thresholds (configurable; defaults reproduce live behaviour) ----------

export interface SaturationThresholds {
  /** Advisory tier. Gates nothing. */
  warningPct: number
  /** From here up, a `large` work package is refused. Additive tier. */
  noNewLargeTaskPct: number
  /** From here up, the session should write a checkpoint. Defaults to the LIVE
   *  context-guard actPct (0.90) -- the point the shipped guard already acts. */
  checkpointRequiredPct: number
  /** From here up, treat the session as unable to take new work. Defaults to
   *  the LIVE context-guard hardPct (0.97). */
  hardStopPct: number
  /** Mirror of the live always-on pane-saturation net: a pane reading "100%
   *  context used" is `hard_stop` regardless of pct. Default TRUE, matching
   *  ContextGuardConfig.saturationRestart's default. */
  paneSaturationIsHardStop: boolean
}

/**
 * Defaults. checkpointRequiredPct / hardStopPct are NOT independent numbers:
 * they are the live context-guard defaults, kept in lockstep by a test. The two
 * additive tiers sit BELOW them so a large package stops being admitted a
 * little before the session is asked to hand off -- their only effect is on the
 * new admission decision.
 */
export const DEFAULT_SATURATION_THRESHOLDS: SaturationThresholds = {
  warningPct: 0.80,
  noNewLargeTaskPct: 0.85,
  checkpointRequiredPct: 0.90, // == DEFAULT_CONTEXT_GUARD.actPct (context-guard.ts:54)
  hardStopPct: 0.97,           // == DEFAULT_CONTEXT_GUARD.hardPct (context-guard.ts:55)
  paneSaturationIsHardStop: true,
}

/**
 * Coerce arbitrary parsed JSON into safe thresholds, mirroring
 * normalizeContextGuardConfig's defensive style: an out-of-range or non-numeric
 * value falls back to the default rather than disarming the gate, and the tiers
 * are forced into non-decreasing order (a config that put hardStop below
 * checkpoint would otherwise make `hard_stop` unreachable).
 */
export function normalizeSaturationThresholds(raw: unknown): SaturationThresholds {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const pct = (v: unknown, dflt: number): number =>
    (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1) ? v : dflt
  let warningPct = pct(o.warningPct, DEFAULT_SATURATION_THRESHOLDS.warningPct)
  let noNewLargeTaskPct = pct(o.noNewLargeTaskPct, DEFAULT_SATURATION_THRESHOLDS.noNewLargeTaskPct)
  let checkpointRequiredPct = pct(o.checkpointRequiredPct, DEFAULT_SATURATION_THRESHOLDS.checkpointRequiredPct)
  let hardStopPct = pct(o.hardStopPct, DEFAULT_SATURATION_THRESHOLDS.hardStopPct)
  // Non-decreasing: each tier is at least the one below it.
  if (noNewLargeTaskPct < warningPct) noNewLargeTaskPct = warningPct
  if (checkpointRequiredPct < noNewLargeTaskPct) checkpointRequiredPct = noNewLargeTaskPct
  if (hardStopPct < checkpointRequiredPct) hardStopPct = checkpointRequiredPct
  return {
    warningPct,
    noNewLargeTaskPct,
    checkpointRequiredPct,
    hardStopPct,
    // Default-ON: only an explicit false disarms the net, exactly like
    // ContextGuardConfig.saturationRestart (context-guard.ts:83).
    paneSaturationIsHardStop: o.paneSaturationIsHardStop !== false,
  }
}

// ---- classification --------------------------------------------------------

export interface SaturationInputs {
  /** Live context fraction (0..1+) against the CALIBRATED per-(agent,model)
   *  limit, or null when unmeasurable (no transcript / agent not running). */
  pct: number | null
  /** Pane footer shows context saturation ("100% context used" & co). */
  paneSaturated?: boolean
}

export interface SaturationClassification {
  state: SaturationState
  /** False when pct was null AND the pane was not saturated -- i.e. the state is
   *  a default, not an observation. Consumers must not treat `ok` as proof of
   *  headroom when this is false. */
  measured: boolean
  pct: number | null
  reason: string
}

/**
 * Classify one session's saturation. Deterministic; no model, no I/O.
 *
 * An UNMEASURABLE session (pct null, pane not saturated) classifies as `ok` with
 * measured=false, deliberately: refusing dispatch because measurement failed
 * would let a broken transcript reader silently stop fleet work. Failing open is
 * the additive/behaviour-neutral choice and matches the live guard, which does
 * nothing on 'context unmeasurable' (context-guard.ts:307).
 */
export function classifySaturation(
  inputs: SaturationInputs,
  thresholds: SaturationThresholds = DEFAULT_SATURATION_THRESHOLDS,
): SaturationClassification {
  const pct = (typeof inputs.pct === 'number' && Number.isFinite(inputs.pct)) ? inputs.pct : null

  // Always-on pane-saturation net first -- it needs no pct and outranks every
  // tier, exactly like the live guard's ordering (context-guard.ts:298).
  if (thresholds.paneSaturationIsHardStop && inputs.paneSaturated === true) {
    return { state: 'hard_stop', measured: true, pct, reason: 'pane saturated (100% context used)' }
  }
  if (pct === null) {
    return { state: 'ok', measured: false, pct: null, reason: 'context unmeasurable -- failing open' }
  }
  const at = (p: number) => `${Math.round(pct * 100)}% >= ${Math.round(p * 100)}%`
  if (pct >= thresholds.hardStopPct) {
    return { state: 'hard_stop', measured: true, pct, reason: `hard stop (${at(thresholds.hardStopPct)})` }
  }
  if (pct >= thresholds.checkpointRequiredPct) {
    return { state: 'checkpoint_required', measured: true, pct, reason: `checkpoint required (${at(thresholds.checkpointRequiredPct)})` }
  }
  if (pct >= thresholds.noNewLargeTaskPct) {
    return { state: 'no_new_large_task', measured: true, pct, reason: `no new large task (${at(thresholds.noNewLargeTaskPct)})` }
  }
  if (pct >= thresholds.warningPct) {
    return { state: 'warning', measured: true, pct, reason: `warning (${at(thresholds.warningPct)})` }
  }
  return { state: 'ok', measured: true, pct, reason: 'below every saturation tier' }
}

// ---- task size resolution (explicit metadata or workflow policy; NO LLM) ---

export type TaskSizeSource = 'explicit' | 'workflow_policy' | 'agent_default'

export interface TaskSizeResolution {
  taskSize: TaskSize
  source: TaskSizeSource
  reason: string
}

/**
 * Deployment-local workflow policy that maps kanban labels / card types onto a
 * task size. A plain lookup table: label/type name (lowercased) -> size. There
 * is no pattern inference and no model -- an unlisted label contributes nothing.
 */
export interface TaskSizePolicy {
  /** kanban label name (lowercased) -> size */
  labels: Record<string, TaskSize>
  /** kanban card type (lowercased) -> size */
  cardTypes: Record<string, TaskSize>
  /** Fallback when nothing is marked. NEVER 'large' by default. */
  agentDefault: TaskSize
}

export const DEFAULT_TASK_SIZE_POLICY: TaskSizePolicy = {
  labels: {},
  cardTypes: {},
  // An unmarked task is the agent's default, and the default is 'normal'. It is
  // NEVER 'large': guessing 'large' would refuse ordinary unlabelled dispatch
  // into any session past noNewLargeTaskPct, which is a behaviour change nobody
  // asked for and would look like the fleet randomly dropping work.
  agentDefault: 'normal',
}

const VALID_SIZES: ReadonlySet<string> = new Set<TaskSize>(['small', 'normal', 'large'])

function coerceSize(v: unknown): TaskSize | null {
  return (typeof v === 'string' && VALID_SIZES.has(v)) ? v as TaskSize : null
}

/** Coerce arbitrary parsed JSON into a safe policy. Unknown sizes are dropped
 *  (never silently upgraded), and agentDefault can only be set to a valid size. */
export function normalizeTaskSizePolicy(raw: unknown): TaskSizePolicy {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const table = (v: unknown): Record<string, TaskSize> => {
    const out: Record<string, TaskSize> = {}
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const size = coerceSize(val)
        if (size && k.trim()) out[k.trim().toLowerCase()] = size
      }
    }
    return out
  }
  return {
    labels: table(o.labels),
    cardTypes: table(o.cardTypes),
    agentDefault: coerceSize(o.agentDefault) ?? DEFAULT_TASK_SIZE_POLICY.agentDefault,
  }
}

export interface TaskSizeInputs {
  /** Explicit size from dispatch/packet metadata. Highest precedence. */
  explicit?: TaskSize | string | null
  /** Kanban label names on the originating card, if any. */
  labels?: string[] | null
  /** Kanban card type, if any. */
  cardType?: string | null
  /** Per-agent default override; falls back to the policy's agentDefault. */
  agentDefault?: TaskSize | null
}

/**
 * Resolve a task size DETERMINISTICALLY. Precedence: explicit metadata ->
 * workflow policy (label, then card type) -> agent default. No model is
 * consulted and no heuristic looks at the prompt text; an unmarked task can
 * never resolve to 'large' unless the agent default itself says so.
 *
 * When several labels map to a size, the most severe wins -- a card labelled
 * both `size:small` and `size:large` is treated as large, because the expensive
 * mistake is admitting a large package, not refusing one.
 */
export function resolveTaskSize(
  inputs: TaskSizeInputs,
  policy: TaskSizePolicy = DEFAULT_TASK_SIZE_POLICY,
): TaskSizeResolution {
  const explicit = coerceSize(inputs.explicit)
  if (explicit) {
    return { taskSize: explicit, source: 'explicit', reason: 'explicit dispatch metadata' }
  }
  const sizeRank: Record<TaskSize, number> = { small: 0, normal: 1, large: 2 }
  let policyHit: { size: TaskSize; via: string } | null = null
  for (const raw of inputs.labels ?? []) {
    const hit = policy.labels[String(raw ?? '').trim().toLowerCase()]
    if (hit && (!policyHit || sizeRank[hit] > sizeRank[policyHit.size])) policyHit = { size: hit, via: `label "${raw}"` }
  }
  if (!policyHit && inputs.cardType) {
    const hit = policy.cardTypes[String(inputs.cardType).trim().toLowerCase()]
    if (hit) policyHit = { size: hit, via: `card type "${inputs.cardType}"` }
  }
  if (policyHit) {
    return { taskSize: policyHit.size, source: 'workflow_policy', reason: `workflow policy via ${policyHit.via}` }
  }
  const dflt = coerceSize(inputs.agentDefault) ?? policy.agentDefault
  return { taskSize: dflt, source: 'agent_default', reason: `unmarked task -- agent default (${dflt})` }
}

// ---- dispatch admission ----------------------------------------------------

/**
 * The floor at which a `large` work package stops being admitted. Deliberately
 * a named constant so the load-bearing rule is one grep away.
 */
export const LARGE_TASK_REFUSAL_FLOOR: SaturationState = 'no_new_large_task'

export interface AdmissionInputs {
  taskSize: TaskSize
  saturation: SaturationClassification
}

export interface AdmissionDecision {
  admit: boolean
  /** Set when admit=false. */
  refusalCode: 'large_into_saturated_session' | null
  reason: string
  /** True when the receiving session should be checkpointed regardless of the
   *  admit decision (state at or above checkpoint_required). Advisory: the
   *  existing context-guard already owns the handoff request itself. */
  checkpointAdvised: boolean
  state: SaturationState
  taskSize: TaskSize
}

/**
 * THE load-bearing decision of P2-B: may this work package be dispatched into
 * this session right now?
 *
 * The ONLY refusal this layer adds is the one the program asked for: a `large`
 * package is refused once the session is at or above LARGE_TASK_REFUSAL_FLOOR.
 * `small` and `normal` are always admitted, so every dispatch that succeeds
 * today still succeeds -- this is not a general throttle, and it deliberately
 * does not become one. An unmeasurable session admits everything (see
 * classifySaturation).
 */
export function decideDispatchAdmission(inputs: AdmissionInputs): AdmissionDecision {
  const { taskSize, saturation } = inputs
  const checkpointAdvised = atOrAbove(saturation.state, 'checkpoint_required')
  if (taskSize === 'large' && atOrAbove(saturation.state, LARGE_TASK_REFUSAL_FLOOR)) {
    return {
      admit: false,
      refusalCode: 'large_into_saturated_session',
      reason: `large work package refused: session is ${saturation.state} (${saturation.reason})`,
      checkpointAdvised,
      state: saturation.state,
      taskSize,
    }
  }
  return {
    admit: true,
    refusalCode: null,
    reason: `${taskSize} work package admitted: session is ${saturation.state}`,
    checkpointAdvised,
    state: saturation.state,
    taskSize,
  }
}
