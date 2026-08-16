// ZST CoS v1.2 — operational projection for newly created company cases.
// Pure/deterministic except for recording temporal facts through the caller.

import type { TemporalClaim } from './temporal-consistency-gate.js'
import { extractTemporalClaims } from './temporal-consistency-gate.js'

export interface ZstOperationalProjectionInput {
  caseType: string
  direction: 'INBOUND' | 'OUTBOUND'
  subject: string
  body: string
  from: string
  to?: string
  occurredAt: number
  explicitFollowUpAt?: number
}

export interface ZstOperationalProjection {
  status: 'NEW' | 'WAITING_EXTERNAL'
  nextAction: string
  nextActionOwner: string
  waitingOn: string | null
  followUpAt: number | null
  temporalClaims: TemporalClaim[]
}

export function projectZstOperationalIntake(input: ZstOperationalProjectionInput): ZstOperationalProjection {
  const kind = input.caseType.toUpperCase()
  const text = `${input.subject}\n${input.body}`
  const temporalClaims = extractTemporalClaims(text, 'zst-intake')

  if (input.direction === 'OUTBOUND') {
    return {
      status: 'WAITING_EXTERNAL',
      nextAction: 'Check for the external reply, evaluate it, and determine the next company step',
      nextActionOwner: 'SYSTEM',
      waitingOn: input.to ? `reply from ${input.to}` : 'EXTERNAL_OTHER',
      followUpAt: input.explicitFollowUpAt ?? input.occurredAt + 3 * 86400,
      temporalClaims,
    }
  }

  if (kind.includes('INVOICE') || kind.includes('ACCOUNT')) {
    return {
      status: 'NEW',
      nextAction: 'Verify the invoice/accounting evidence and determine the required bookkeeping follow-up',
      nextActionOwner: 'ACCOUNTANT', waitingOn: null, followUpAt: null, temporalClaims,
    }
  }
  if (kind.includes('CONTRACT') || kind.includes('LICENSE') || kind.includes('LEGAL')) {
    return {
      status: 'NEW',
      nextAction: 'Review the contract or obligation evidence and identify the next decision or legal follow-up',
      nextActionOwner: 'ISTVAN', waitingOn: null, followUpAt: null, temporalClaims,
    }
  }
  if (kind.includes('VENDOR') || kind.includes('PROCUREMENT')) {
    return {
      status: 'NEW',
      nextAction: 'Review vendor evidence and define the next procurement follow-up',
      nextActionOwner: 'ISTVAN', waitingOn: null, followUpAt: null, temporalClaims,
    }
  }
  if (kind.includes('OPPORTUNITY') || kind.includes('PRODUCT')) {
    return {
      status: 'NEW',
      nextAction: 'Review the opportunity evidence and decide the next qualification step',
      nextActionOwner: 'ISTVAN', waitingOn: null, followUpAt: null, temporalClaims,
    }
  }
  return {
    status: 'NEW',
    nextAction: 'Review the latest company source and define the next concrete operational step',
    nextActionOwner: 'ISTVAN', waitingOn: null, followUpAt: null, temporalClaims,
  }
}
