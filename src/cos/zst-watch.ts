// ZST Slice 3/6 — the common proactive due-item runner (spec §27: "közös
// due-item runner kötelező" — NO per-contract/-license cron). One read-only
// query set that surfaces what needs attention: contract renewal / termination
// windows, license renewals (30/60/90d), open obligations coming due, and
// opportunities awaiting a decision. Read-only — it flags, it never acts (any
// renewal/cancellation/offer is approval-gated via the send executor).

import type Database from 'better-sqlite3'

export interface DueContract { contract_id: string; title: string; status: string; expiry_date: string | null; termination_deadline: string | null; notice_period_days: number | null; reason: string }
export interface DueLicense { license_id: string; product_name: string | null; renewal_date: string | null; auto_renew: number; cancellation_candidate: number; window: string }
export interface DueObligation { obligation_id: string; contract_id: string | null; description: string | null; due_date: string | null }
export interface DecisionOpportunity { opportunity_id: string; title: string; status: string; next_action: string | null }

export interface ZstDueItems {
  contracts: DueContract[]
  licenses: DueLicense[]
  obligations: DueObligation[]
  opportunities: DecisionOpportunity[]
  totals: { contracts: number; licenses: number; obligations: number; opportunities: number }
}

// Statuses where an opportunity is waiting on Istvan (hard gate — spec §22).
const OPP_DECISION_STATUSES = ['OFFER_REQUIRED', 'AWAITING_ZST_APPROVAL', 'NEGOTIATION', 'PILOT_DISCUSSION']

/** Surface everything due within `horizonDays`. Dates are ISO TEXT so SQLite's
 *  date() comparisons are lexicographic-correct. Read-only.
 *
 *  Every `date('now')` below carries 'localtime' (2026-08-13). SQLite's bare
 *  date('now') is UTC, and this runner serves a Budapest office: between
 *  midnight and 02:00 local the UTC date is still YESTERDAY, so a deadline
 *  crossing in the evening surfaced up to two hours late and the 30/60/90-day
 *  licence windows were computed from a day that had already ended here. A due
 *  runner that is a day behind on the day it matters is the one day it had to be
 *  right. */
export function dueZstItems(db: Database.Database, horizonDays = 45): ZstDueItems {
  const horizon = `+${horizonDays} days`

  // A contract is "due" when its termination_deadline or (expiry - notice) falls
  // within the horizon, or it is already in a renewal/termination state.
  const contracts = db.prepare(
    `SELECT contract_id, title, status, expiry_date, termination_deadline, notice_period_days,
       CASE
         WHEN status IN ('RENEWAL_DUE','TERMINATION_WINDOW') THEN status
         WHEN termination_deadline IS NOT NULL AND date(termination_deadline) <= date('now', 'localtime', @h) THEN 'TERMINATION_WINDOW'
         WHEN expiry_date IS NOT NULL AND date(expiry_date, '-' || COALESCE(notice_period_days,30) || ' days') <= date('now', 'localtime', @h) THEN 'RENEWAL_DUE'
         ELSE 'DUE'
       END AS reason
     FROM zst_contracts
     WHERE status NOT IN ('EXPIRED','TERMINATED','ARCHIVED')
       AND (
         status IN ('RENEWAL_DUE','TERMINATION_WINDOW')
         OR (termination_deadline IS NOT NULL AND date(termination_deadline) <= date('now', 'localtime', @h))
         OR (expiry_date IS NOT NULL AND date(expiry_date, '-' || COALESCE(notice_period_days,30) || ' days') <= date('now', 'localtime', @h))
       )
     ORDER BY COALESCE(termination_deadline, expiry_date)`
  ).all({ h: horizon }) as DueContract[]

  const licenses = db.prepare(
    `SELECT license_id, product_name, renewal_date, auto_renew, cancellation_candidate,
       CASE
         WHEN date(renewal_date) <= date('now', 'localtime', '+30 days') THEN '30d'
         WHEN date(renewal_date) <= date('now', 'localtime', '+60 days') THEN '60d'
         ELSE '90d'
       END AS window
     FROM zst_licenses
     WHERE renewal_date IS NOT NULL AND date(renewal_date) <= date('now', 'localtime', '+90 days')
     ORDER BY renewal_date`
  ).all() as DueLicense[]

  const obligations = db.prepare(
    `SELECT obligation_id, contract_id, description, due_date FROM zst_obligations
     WHERE status = 'OPEN' AND due_date IS NOT NULL AND date(due_date) <= date('now', 'localtime', @h)
     ORDER BY due_date`
  ).all({ h: horizon }) as DueObligation[]

  const oppPh = OPP_DECISION_STATUSES.map(() => '?').join(',')
  const opportunities = db.prepare(
    `SELECT opportunity_id, title, status, next_action FROM zst_opportunities
     WHERE status IN (${oppPh}) ORDER BY updated_at DESC`
  ).all(...OPP_DECISION_STATUSES) as DecisionOpportunity[]

  return {
    contracts, licenses, obligations, opportunities,
    totals: { contracts: contracts.length, licenses: licenses.length, obligations: obligations.length, opportunities: opportunities.length },
  }
}

// ── Product portfolio seed (spec §24 — data-driven, seed rows not enum) ────────
const SEED_PRODUCTS: Array<{ id: string; name: string }> = [
  { id: 'MARV', name: 'Marveen' },
  { id: 'QQ', name: 'QuickQuote / Mondigo' },
  { id: 'ZSIB', name: 'Zsibongó' },
  { id: 'WEB', name: 'Egyéb webes termékek' },
  { id: 'SHARED', name: 'Közös fejlesztési infrastruktúra' },
]

/** Idempotently seed the mandatory products. Adding a new product later is just
 *  another upsertZstProduct — never a code/enum change. */
export function seedZstProducts(db: Database.Database, now: number): number {
  const stmt = db.prepare(
    `INSERT INTO zst_products (product_id, product_name, version, updated_at)
     VALUES (@id, @name, 1, @now) ON CONFLICT(product_id) DO NOTHING`
  )
  let n = 0
  for (const p of SEED_PRODUCTS) { if (stmt.run({ id: p.id, name: p.name, now }).changes) n++ }
  return n
}
