// ZST CoS v1.2 legacy operationalization planner.
// Generates a dry-run/canary plan only. It does not update zst_cases.

import { classifyActionability } from '../actionability.js'
import type { ZstLegacyCaseInput, ZstMigrationBatch, ZstMigrationCandidate } from './types.js'

function proposal(c: ZstLegacyCaseInput): ZstMigrationCandidate {
  const current = classifyActionability({
    status: c.status, nextAction: c.nextAction, nextActionOwner: c.nextActionOwner,
    waitingOn: c.waitingOn, dueAt: c.dueAt, followUpAt: c.followUpAt, nextWakeAt: c.nextWakeAt,
    parentCaseId: c.parentCaseId, hasOpenChildren: c.hasOpenChildren,
  })
  if (current.valid && current.classification !== 'ORPHAN') {
    return {
      caseId: c.caseId, currentClassification: current.classification,
      proposedNextAction: c.nextAction ?? null, proposedNextActionOwner: c.nextActionOwner ?? null,
      requiresHumanReview: false, reasons: ['already operationally classifiable; no projection repair proposed'],
    }
  }

  const type = (c.caseType ?? '').toUpperCase()
  let action = 'Review source evidence and define the next concrete company action'
  let owner = 'ISTVAN'
  if (type.includes('INVOICE') || type.includes('ACCOUNT')) {
    action = 'Verify accounting evidence and determine the next bookkeeping step'
    owner = 'ACCOUNTANT'
  } else if (type.includes('CONTRACT') || type.includes('LEGAL')) {
    action = 'Review contract/obligation evidence and identify the decision or legal follow-up required'
    owner = 'ISTVAN'
  } else if (type.includes('VENDOR') || type.includes('PROCUREMENT')) {
    action = 'Review vendor state and define the next procurement follow-up'
    owner = 'ISTVAN'
  }
  return {
    caseId: c.caseId, currentClassification: current.classification,
    proposedNextAction: action, proposedNextActionOwner: owner,
    requiresHumanReview: true,
    reasons: [...current.reasons, 'legacy projection is incomplete; proposal is review-only and must not close the case'],
  }
}

export function buildZstMigrationCandidates(cases: readonly ZstLegacyCaseInput[]): ZstMigrationCandidate[] {
  return cases.map(proposal).sort((a, b) => a.caseId.localeCompare(b.caseId))
}

/** Exact rollout sequence required by v1.2: dry -> 2 -> 5 -> 10 -> remainder.
 * Each batch is cumulative only in observation, not in membership. A later batch
 * must not start unless the previous batch's acceptance/reconcile checks are green. */
export function buildZstMigrationBatches(candidates: readonly ZstMigrationCandidate[]): ZstMigrationBatch[] {
  const ids = candidates.filter(c => c.requiresHumanReview).map(c => c.caseId)
  let at = 0
  const take = (n: number) => { const out = ids.slice(at, at + n); at += out.length; return out }
  return [
    { phase: 'DRY_RUN', caseIds: ids.slice() },
    { phase: 'CANARY_2', caseIds: take(2) },
    { phase: 'CANARY_5', caseIds: take(5) },
    { phase: 'CANARY_10', caseIds: take(10) },
    { phase: 'REMAINDER', caseIds: ids.slice(at) },
  ]
}

export function assertMigrationBatchSafe(batch: ZstMigrationBatch, candidates: readonly ZstMigrationCandidate[]): void {
  const byId = new Map(candidates.map(c => [c.caseId, c]))
  for (const id of batch.caseIds) {
    const c = byId.get(id)
    if (!c) throw new Error(`migration batch references unknown case ${id}`)
    if (!c.requiresHumanReview) throw new Error(`migration batch contains already-classifiable case ${id}`)
    // Migration is projection-only. No generated proposal may imply completion,
    // sending, payment or legal commitment.
    const t = `${c.proposedNextAction ?? ''}`.toLowerCase()
    if (/send email|pay |utal|transfer|sign contract|aláír|alair|complete case|close case/.test(t)) {
      throw new Error(`unsafe migration proposal for ${id}`)
    }
  }
}
