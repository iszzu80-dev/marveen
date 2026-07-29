// Lean Optimization Phase 2 / P2-B -- dispatch admission gate (I/O side).
//
// THE load-bearing P2-B rule, wired to real signals: a `large` work package must
// not be dispatched into a session whose configured threshold says it can no
// longer safely hold it. The pure decision lives in src/session-saturation.ts;
// this module only gathers the inputs:
//   - live pct + pane saturation  <- context-guard-runner.readLiveSaturationSignals
//     (the SAME measurement the guard sweep uses, highwater calibration included)
//   - thresholds + task-size policy <- session-efficiency-store (deployment-local)
//
// NO LLM: the size of a work package comes from explicit dispatch metadata or a
// deterministic label/type lookup. Nothing in this file, or anything it calls,
// invokes a model or reads prompt text.
//
// BEHAVIOUR NEUTRALITY: the only refusal is `large`-into-saturated. With the
// shipped defaults the task-size policy has an EMPTY label table and an
// agentDefault of 'normal', so resolveTaskSize can only return 'large' when an
// origin passes it explicitly or an operator configures a label -- i.e. on a
// default install nothing is ever refused. Tuning is opt-in.
//
// FAULT ISOLATION (program principle 20): evaluateDispatchAdmissionSafe FAILS
// OPEN. If config is corrupt, tmux is unreachable, the transcript is unreadable,
// or this layer throws for any reason at all, the dispatch is ADMITTED and the
// send proceeds -- an efficiency layer may never be the reason fleet work stops.
// This mirrors P2-A's createDispatchSafe and is covered by a red-able test.

import { logger } from '../logger.js'
import { readLiveSaturationSignals } from './context-guard-runner.js'
import { readSessionEfficiencyConfig, SESSION_EFFICIENCY_PATH } from './session-efficiency-store.js'
import {
  classifySaturation,
  resolveTaskSize,
  decideDispatchAdmission,
  type AdmissionDecision,
  type SaturationState,
  type TaskSize,
  type TaskSizeSource,
} from '../session-saturation.js'

export interface AdmissionRequest {
  /** Target agent. */
  agent: string
  /** Explicit size from dispatch/packet metadata, when the origin knows it. */
  explicitTaskSize?: TaskSize | string | null
  /** Kanban label names on the originating card (workflow policy input). */
  labels?: string[] | null
  /** Card type / task type (workflow policy input). */
  cardType?: string | null
}

export interface AdmissionOutcome extends AdmissionDecision {
  agent: string
  taskSizeSource: TaskSizeSource
  taskSizeReason: string
  /** False when the saturation state is a fail-open default, not an observation. */
  measured: boolean
  pct: number | null
  /** True when the gate itself faulted and admitted by default. */
  faultedOpen: boolean
}

/**
 * Evaluate admission for one dispatch. May throw (config read, tmux, transcript)
 * -- hot paths must call evaluateDispatchAdmissionSafe instead.
 *
 * `signals` and `configPath` are injectable so tests drive real decisions without
 * a tmux server or a live store/ file.
 */
export function evaluateDispatchAdmission(
  req: AdmissionRequest,
  opts: {
    signals?: { pct: number | null; paneSaturated: boolean }
    configPath?: string
  } = {},
): AdmissionOutcome {
  const cfg = readSessionEfficiencyConfig(opts.configPath ?? SESSION_EFFICIENCY_PATH)
  const thresholds = cfg.agents[req.agent]?.saturation ?? cfg.saturation
  const agentDefault = cfg.agents[req.agent]?.agentDefaultTaskSize ?? cfg.taskSizePolicy.agentDefault
  const signals = opts.signals ?? readLiveSaturationSignals(req.agent)

  const saturation = classifySaturation(signals, thresholds)
  const size = resolveTaskSize(
    { explicit: req.explicitTaskSize ?? null, labels: req.labels ?? null, cardType: req.cardType ?? null, agentDefault },
    cfg.taskSizePolicy,
  )
  const decision = decideDispatchAdmission({ taskSize: size.taskSize, saturation })
  return {
    ...decision,
    agent: req.agent,
    taskSizeSource: size.source,
    taskSizeReason: size.reason,
    measured: saturation.measured,
    pct: saturation.pct,
    faultedOpen: false,
  }
}

/** The fail-open outcome used when the gate cannot decide. */
function admitByDefault(agent: string, reason: string): AdmissionOutcome {
  return {
    admit: true,
    refusalCode: null,
    reason,
    checkpointAdvised: false,
    state: 'ok' as SaturationState,
    taskSize: 'normal',
    agent,
    taskSizeSource: 'agent_default',
    taskSizeReason: 'admission gate could not decide',
    measured: false,
    pct: null,
    faultedOpen: true,
  }
}

/**
 * Fault-isolated admission for the hot dispatch paths. NEVER throws and NEVER
 * refuses on error: a fault in this measurement/efficiency layer must not stop a
 * real dispatch. Mirrors costops/dispatch.ts createDispatchSafe.
 */
export function evaluateDispatchAdmissionSafe(
  req: AdmissionRequest,
  opts: { signals?: { pct: number | null; paneSaturated: boolean }; configPath?: string } = {},
): AdmissionOutcome {
  try {
    return evaluateDispatchAdmission(req, opts)
  } catch (err) {
    logger.warn({ err, agent: req.agent }, 'dispatch admission gate faulted; admitting by default (send unaffected)')
    return admitByDefault(req.agent, 'admission gate faulted -- failing open, dispatch proceeds')
  }
}
