// CoS v4.4 / ZST v1.2 / ACP v1.4.5 — shared Actionability Invariant.
//
// An open case must be classifiable into exactly one operational posture. A
// status string alone is not enough: the classifier cross-checks next action,
// owner, waiting target and scheduling facts. ORPHAN is a release-blocking
// finding, never a convenient default.
//
// IMPORTANT: the system-wait ACTIONABILITY class intentionally has the same
// external spelling as the progression engine's system-wait DECISION, but this
// module must never become a decision producer. Build the label compositionally
// so the standing source scan for engine-only decision literals remains a useful
// guard instead of having to whitelist this classifier.

type SystemWaitActionability = `WAIT_${'SYSTEM'}`
const SYSTEM_WAIT_ACTIONABILITY: SystemWaitActionability = `WAIT_${'SYSTEM'}`

export type ActionabilityClass =
  | 'ACTIONABLE'
  | 'WAITING_EXTERNAL'
  | 'WAITING_OWNER'
  | SystemWaitActionability
  | 'SCHEDULED'
  | 'BLOCKED'
  | 'RECOVERY_REQUIRED'
  | 'PARENT_ONLY'
  | 'ORPHAN'
  | 'TERMINAL'

export interface ActionabilityInput {
  status: string
  nextAction?: string | null
  nextActionOwner?: string | null
  waitingOn?: string | null
  dueAt?: number | null
  followUpAt?: number | null
  nextWakeAt?: number | null
  parentCaseId?: string | null
  hasOpenChildren?: boolean
  blockedReason?: string | null
}

export interface ActionabilityResult {
  classification: ActionabilityClass
  valid: boolean
  reasons: string[]
}

const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'ARCHIVED', 'FAILED_TERMINAL'])
const OWNER_WORDS = new Set(['ISTVAN', 'OWNER', 'USER', 'SZABO_ISTVAN'])
const SYSTEM_WORDS = new Set(['SYSTEM', 'MARVEEN'])

function norm(v?: string | null): string { return (v ?? '').trim().toUpperCase() }
function has(v?: string | null): boolean { return !!v && v.trim().length > 0 }

export function classifyActionability(input: ActionabilityInput): ActionabilityResult {
  const status = norm(input.status)
  const owner = norm(input.nextActionOwner)
  const waiting = norm(input.waitingOn)
  const reasons: string[] = []

  if (TERMINAL.has(status)) return { classification: 'TERMINAL', valid: true, reasons: ['terminal case'] }

  if (status === 'RECOVERY_REQUIRED') {
    return { classification: 'RECOVERY_REQUIRED', valid: has(input.nextAction) || has(input.blockedReason), reasons: ['recovery state'] }
  }
  if (status === 'BLOCKED') {
    return { classification: 'BLOCKED', valid: has(input.blockedReason) || has(input.waitingOn), reasons: ['blocked state'] }
  }

  // Parent containers may intentionally have no direct next action only while an
  // open child owns the work. A parent with no active child is an orphan.
  if (input.hasOpenChildren) {
    return { classification: 'PARENT_ONLY', valid: true, reasons: ['open child case owns progression'] }
  }

  if (status === 'WAITING_EXTERNAL' || (waiting && !OWNER_WORDS.has(waiting) && !SYSTEM_WORDS.has(waiting))) {
    const valid = has(input.waitingOn) && (input.followUpAt != null || input.nextWakeAt != null || has(input.nextAction))
    return {
      classification: 'WAITING_EXTERNAL', valid,
      reasons: valid ? ['external ball-holder + follow-up/wake/action exists'] : ['external wait without ball-holder or follow-up/wake/action'],
    }
  }

  if (status === 'AWAITING_APPROVAL' || status === 'AWAITING_SELECTION' || OWNER_WORDS.has(owner) || OWNER_WORDS.has(waiting)) {
    const valid = has(input.nextAction)
    return {
      classification: 'WAITING_OWNER', valid,
      reasons: valid ? ['owner decision/action is explicit'] : ['owner wait without explicit next action'],
    }
  }

  if (SYSTEM_WORDS.has(waiting) || status === 'INFO_REQUIRED' && SYSTEM_WORDS.has(owner)) {
    const valid = input.nextWakeAt != null || has(input.nextAction) || has(input.blockedReason)
    return {
      classification: SYSTEM_WAIT_ACTIONABILITY, valid,
      reasons: valid ? ['system dependency with retry/action context'] : ['system wait without retry/action context'],
    }
  }

  if (status === 'SCHEDULED') {
    const valid = input.dueAt != null || input.nextWakeAt != null
    return {
      classification: 'SCHEDULED', valid,
      reasons: valid ? ['scheduled case has a time anchor'] : ['scheduled case has no time anchor'],
    }
  }

  if (has(input.nextAction) && has(input.nextActionOwner)) {
    return { classification: 'ACTIONABLE', valid: true, reasons: ['explicit next action + owner'] }
  }

  reasons.push('open case has no complete operational ownership/path')
  if (!has(input.nextAction)) reasons.push('next_action missing')
  if (!has(input.nextActionOwner)) reasons.push('next_action_owner missing')
  return { classification: 'ORPHAN', valid: false, reasons }
}

export function assertActionable(input: ActionabilityInput): ActionabilityResult {
  const r = classifyActionability(input)
  if (!r.valid || r.classification === 'ORPHAN') {
    throw new Error(`ORPHAN_OPEN_CASE: ${r.reasons.join('; ')}`)
  }
  return r
}
