// Personal Chief of Staff (COS) — Action Executor (Slice 1 core). As of the ZST
// executor work the crash-safe state machine lives in executor-core.ts (shared
// with the ZST executor); this module binds it to the PERSONAL `outbound_ledger`
// table and re-exports the same public surface, so every existing caller and the
// 15 executor tests are unchanged. The SINGLE sanctioned writer to the outside
// world; never sends twice for the same action without a readback proving the
// prior attempt did not reach the provider.

import {
  makeExecutor,
  TERMINAL_STATUSES, NON_RESENDABLE_STATUSES, SendError, idempotencyKey,
  type OutboundStatus, type OutboundAction, type ReadbackResult, type OutboundAdapter,
  type SendErrorHints, type PlanInput, type ExecuteOpts,
} from './executor-core.js'

export {
  TERMINAL_STATUSES, NON_RESENDABLE_STATUSES, SendError, idempotencyKey,
}
export type {
  OutboundStatus, OutboundAction, ReadbackResult, OutboundAdapter, SendErrorHints, PlanInput, ExecuteOpts,
}

const engine = makeExecutor('outbound_ledger', 'case_claims')

export const planAction = engine.planAction
export const executeAction = engine.executeAction
export const verifyAction = engine.verifyAction
export const recoverAction = engine.recoverAction
export const cancelAction = engine.cancelAction
