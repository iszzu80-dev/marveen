// ACP v1.4.5 — Temporal Semantic Consistency Gate (TSCG).
//
// A scalar timestamp being present is not proof that the system knows what the
// timestamp means. The gate blocks owner-facing / progression decisions when a
// binding semantic date is missing, unverified, conflicted or already past due
// without an explicit handled state.

import type { TemporalFactKind, TemporalFactRow } from './temporal-facts.js'
import { isBindingTemporalKind } from './temporal-facts.js'

export type TemporalGateStatus =
  | 'TEMPORAL_OK'
  | 'TEMPORAL_MISSING'
  | 'TEMPORAL_UNVERIFIED'
  | 'TEMPORAL_CONFLICT'
  | 'TEMPORAL_PAST_DUE'

export interface TemporalClaim {
  kind: TemporalFactKind
  occursAt: number
  source: string
  raw: string
}

export interface TemporalGateInput {
  facts: readonly TemporalFactRow[]
  now: number
  /** Semantic kinds the pending action explicitly depends on. */
  requiredKinds?: readonly TemporalFactKind[]
  /** Claims extracted from case text or another read-only projection. */
  observedClaims?: readonly TemporalClaim[]
  /** Fact ids already acknowledged/handled after passing their deadline. */
  handledPastDueFactIds?: ReadonlySet<string>
}

export interface TemporalGateResult {
  status: TemporalGateStatus
  allowProgression: boolean
  reasons: string[]
  blockingFactIds: string[]
  missingKinds: TemporalFactKind[]
}

const DATE_TIME = /\b(20\d{2})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):([0-5]\d))?\b/g

function utcEpoch(y: number, m: number, d: number, hh = 12, mm = 0): number | null {
  // Text-only extraction intentionally avoids assuming local timezone. Date-only
  // claims are represented at midday UTC so they cannot accidentally appear a
  // day earlier because a host runs in another timezone. Provider-derived facts
  // should carry the exact epoch and supersede this low-confidence claim.
  const ms = Date.UTC(y, m - 1, d, hh, mm, 0)
  const dt = new Date(ms)
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return Math.floor(ms / 1000)
}

/** Conservative semantic extraction used only as a consistency signal. */
export function extractTemporalClaims(text: string, source = 'case_text'): TemporalClaim[] {
  const lower = (text ?? '').toLowerCase()
  let kind: TemporalFactKind = 'OTHER'
  if (/\b(dontes|döntés|valassz|válassz|decide|decision)\b/.test(lower)) kind = 'DECISION_DUE'
  else if (/\b(felmond|termination)\b/.test(lower)) kind = 'TERMINATION_DEADLINE'
  else if (/\b(fizet|payment|invoice|szamla|számla)\b/.test(lower)) kind = 'PAYMENT_DUE'
  else if (/\b(felvetel|felvétel|pickup|booking|foglalas|foglalás)\b/.test(lower)) kind = 'BOOKING_START'
  else if (/\b(hatarido|határidő|due|deadline)\b/.test(lower)) kind = 'CASE_DUE'

  const out: TemporalClaim[] = []
  for (const match of text.matchAll(DATE_TIME)) {
    const y = Number(match[1]); const m = Number(match[2]); const d = Number(match[3])
    const hasTime = match[4] !== undefined
    const at = utcEpoch(y, m, d, hasTime ? Number(match[4]) : 12, hasTime ? Number(match[5]) : 0)
    if (at !== null) out.push({ kind, occursAt: at, source, raw: match[0] })
  }
  return out
}

export function evaluateTemporalConsistency(input: TemporalGateInput): TemporalGateResult {
  const facts = input.facts.filter(f => f.verification !== 'REJECTED')
  const reasons: string[] = []
  const blocking = new Set<string>()
  const missingKinds: TemporalFactKind[] = []
  const required = new Set(input.requiredKinds ?? [])

  for (const c of input.observedClaims ?? []) {
    if (isBindingTemporalKind(c.kind)) required.add(c.kind)
  }

  // Same semantic kind with multiple active timestamps is a conflict unless the
  // conflict has already been resolved by rejecting/superseding one fact.
  const byKind = new Map<TemporalFactKind, TemporalFactRow[]>()
  for (const f of facts) {
    const list = byKind.get(f.fact_kind) ?? []
    list.push(f); byKind.set(f.fact_kind, list)
  }
  for (const [kind, rows] of byKind) {
    const active = rows.filter(r => r.verification !== 'REJECTED')
    const times = new Set(active.map(r => r.occurs_at))
    if (active.some(r => r.verification === 'CONFLICTED') || times.size > 1 && active.filter(r => r.verification === 'VERIFIED').length > 1) {
      reasons.push(`${kind}: egymásnak ellentmondó aktív időpontok`)
      active.forEach(r => blocking.add(r.fact_id))
    }
  }
  if (blocking.size) return {
    status: 'TEMPORAL_CONFLICT', allowProgression: false, reasons,
    blockingFactIds: [...blocking], missingKinds,
  }

  for (const kind of required) {
    const rows = (byKind.get(kind) ?? []).filter(r => r.verification !== 'REJECTED')
    if (!rows.length) {
      missingKinds.push(kind)
      reasons.push(`${kind}: nincs provenance-bound temporal fact`)
      continue
    }
    const verified = rows.filter(r => r.verification === 'VERIFIED')
    if (!verified.length) {
      rows.forEach(r => blocking.add(r.fact_id))
      reasons.push(`${kind}: csak nem ellenőrzött temporal fact áll rendelkezésre`)
    }
  }
  if (missingKinds.length) return {
    status: 'TEMPORAL_MISSING', allowProgression: false, reasons,
    blockingFactIds: [...blocking], missingKinds,
  }
  if (blocking.size) return {
    status: 'TEMPORAL_UNVERIFIED', allowProgression: false, reasons,
    blockingFactIds: [...blocking], missingKinds,
  }

  // If text explicitly claims a binding event, a verified fact of another kind
  // at the same/near date does NOT satisfy it. This is the Hertz/Sixt class: a
  // verified pickup date cannot stand in for the earlier decision deadline.
  for (const claim of input.observedClaims ?? []) {
    if (!isBindingTemporalKind(claim.kind)) continue
    const verifiedSameKind = (byKind.get(claim.kind) ?? []).filter(r => r.verification === 'VERIFIED')
    if (!verifiedSameKind.length) {
      missingKinds.push(claim.kind)
      reasons.push(`${claim.kind}: explicit szöveges igény (${claim.raw}) nincs verifikált azonos szemantikájú facthez kötve`)
    }
  }
  if (missingKinds.length) return {
    status: 'TEMPORAL_MISSING', allowProgression: false, reasons,
    blockingFactIds: [...blocking], missingKinds: [...new Set(missingKinds)],
  }

  const handled = input.handledPastDueFactIds ?? new Set<string>()
  const past = facts.filter(f => f.verification === 'VERIFIED' && isBindingTemporalKind(f.fact_kind)
    && f.occurs_at < input.now && !handled.has(f.fact_id))
  if (past.length) {
    past.forEach(f => blocking.add(f.fact_id))
    reasons.push(`${past.length} verifikált, kötelező temporal fact elmúlt és nincs kezelve`)
    return {
      status: 'TEMPORAL_PAST_DUE', allowProgression: false, reasons,
      blockingFactIds: [...blocking], missingKinds,
    }
  }

  return {
    status: 'TEMPORAL_OK', allowProgression: true,
    reasons: ['minden szükséges szemantikus időpont verifikált és konzisztens'],
    blockingFactIds: [], missingKinds: [],
  }
}
