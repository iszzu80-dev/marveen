// Personal Chief of Staff (COS) — graduated autonomy (§22).
//
// Five rungs per case type: OFF → OBSERVE → PREPARE → EXECUTE_WITH_APPROVAL →
// LIMITED_AUTONOMOUS. The fleet already has a 1-3 switch, which is why this was
// never built — but the fleet's three levels cannot express the distinction that
// actually matters to Istvan: between "it writes the message and you release it"
// and "it sends inside an approved campaign without asking each time". Owner
// decision 2026-08-09: limited autonomy is the goal, so the rung the fleet
// cannot name is the destination, and this ladder is the truth inside the COS.
//
// Two invariants the ladder can never be raised past, at any rung, by any
// promotion (§22, §10, AC-8):
//   - payment is never autonomous;
//   - data beyond what the approval declares shareable is never sent.
// They are checked here rather than left to the caller, because a rule that
// lives only in prose gets forgotten by the second implementation.
//
// Promotion is EARNED and CAPPED. N faultless campaigns make a type ELIGIBLE for
// the next rung; eligibility is not the promotion. The owner's ceiling is a
// separate number, and nothing crosses it on its own — otherwise the ladder is
// just a delay before full autonomy.
//
// Pure logic over a small table. No sending, no network.

import type Database from 'better-sqlite3'

export const RUNGS = ['OFF', 'OBSERVE', 'PREPARE', 'EXECUTE_WITH_APPROVAL', 'LIMITED_AUTONOMOUS'] as const
export type Rung = (typeof RUNGS)[number]

export const rungIndex = (r: Rung): number => RUNGS.indexOf(r)

/** Faultless campaigns required before the next rung becomes available. */
export const PROMOTION_THRESHOLD = 3

/** What is being asked for. PAYMENT is listed so it can be refused by name. */
export type ActionKind = 'OBSERVE' | 'DRAFT' | 'SEND' | 'PAYMENT' | 'SHARE_BEYOND_APPROVED'

export interface LadderState {
  caseType: string
  rung: Rung
  /** The owner's maximum. Promotion stops here, whatever the record. */
  ceiling: Rung
  faultlessCampaigns: number
  /** §22 master switch: pauses the whole Personal Chief regardless of rungs. */
  paused: boolean
}

export interface PermissionResult {
  allowed: boolean
  /** Machine-readable, so a refusal is diagnosable rather than a shrug. */
  code: 'ok' | 'paused' | 'rung_too_low' | 'never_autonomous' | 'approval_required' | 'unknown_type'
  reason: string
  /** True when the action may proceed only with an explicit owner approval. */
  requiresApproval: boolean
}

export function ensureLadderSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cos_autonomy_ladder (
      case_type            TEXT PRIMARY KEY,
      rung                 TEXT NOT NULL DEFAULT 'PREPARE',
      ceiling              TEXT NOT NULL DEFAULT 'EXECUTE_WITH_APPROVAL',
      faultless_campaigns  INTEGER NOT NULL DEFAULT 0,
      paused               INTEGER NOT NULL DEFAULT 0,
      updated_at           INTEGER NOT NULL,
      CHECK (rung IN ('OFF','OBSERVE','PREPARE','EXECUTE_WITH_APPROVAL','LIMITED_AUTONOMOUS')),
      CHECK (ceiling IN ('OFF','OBSERVE','PREPARE','EXECUTE_WITH_APPROVAL','LIMITED_AUTONOMOUS'))
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cos_autonomy_global (
      id      INTEGER PRIMARY KEY CHECK (id = 1),
      paused  INTEGER NOT NULL DEFAULT 0,
      reason  TEXT,
      updated_at INTEGER NOT NULL
    )
  `)
}

/** A case type with no row starts at PREPARE, per §22's "new type" rule: it may
 *  draft, never send. An unknown type must not inherit a permissive default. */
export function getLadder(db: Database.Database, caseType: string): LadderState {
  const row = db.prepare(
    `SELECT case_type, rung, ceiling, faultless_campaigns, paused FROM cos_autonomy_ladder WHERE case_type = ?`
  ).get(caseType) as
    | { case_type: string; rung: Rung; ceiling: Rung; faultless_campaigns: number; paused: number }
    | undefined
  const g = db.prepare(`SELECT paused FROM cos_autonomy_global WHERE id = 1`).get() as { paused: number } | undefined
  const globallyPaused = g?.paused === 1
  if (!row) {
    return { caseType, rung: 'PREPARE', ceiling: 'EXECUTE_WITH_APPROVAL', faultlessCampaigns: 0, paused: globallyPaused }
  }
  return {
    caseType: row.case_type, rung: row.rung, ceiling: row.ceiling,
    faultlessCampaigns: row.faultless_campaigns,
    paused: globallyPaused || row.paused === 1,
  }
}

export function setLadder(
  db: Database.Database, caseType: string, patch: Partial<Omit<LadderState, 'caseType'>>, now: number,
): void {
  const cur = getLadder(db, caseType)
  const next = { ...cur, ...patch }
  if (rungIndex(next.rung) > rungIndex(next.ceiling)) {
    throw new Error(`a rung (${next.rung}) nem lehet a plafon (${next.ceiling}) fölött`)
  }
  db.prepare(
    `INSERT INTO cos_autonomy_ladder (case_type, rung, ceiling, faultless_campaigns, paused, updated_at)
     VALUES (@t, @r, @c, @f, @p, @now)
     ON CONFLICT(case_type) DO UPDATE SET rung=@r, ceiling=@c, faultless_campaigns=@f, paused=@p, updated_at=@now`
  ).run({ t: caseType, r: next.rung, c: next.ceiling, f: next.faultlessCampaigns, p: next.paused ? 1 : 0, now })
}

/** §22 master switch. */
export function pauseAll(db: Database.Database, paused: boolean, reason: string, now: number): void {
  db.prepare(
    `INSERT INTO cos_autonomy_global (id, paused, reason, updated_at) VALUES (1, @p, @r, @now)
     ON CONFLICT(id) DO UPDATE SET paused=@p, reason=@r, updated_at=@now`
  ).run({ p: paused ? 1 : 0, r: reason, now })
}

/**
 * May this action happen for this case type right now?
 *
 * The two never-autonomous rules are checked FIRST, before the rung is even
 * read. Ordering them after would mean a future rung above LIMITED_AUTONOMOUS
 * silently unlocks payment — the kind of thing that is obvious in review and
 * invisible six months later.
 */
export function permits(db: Database.Database, caseType: string, action: ActionKind): PermissionResult {
  if (action === 'PAYMENT') {
    return { allowed: false, code: 'never_autonomous', requiresApproval: true,
      reason: 'fizetés soha nem autonóm, semmilyen fokozaton (§22, AC-8)' }
  }
  if (action === 'SHARE_BEYOND_APPROVED') {
    return { allowed: false, code: 'never_autonomous', requiresApproval: true,
      reason: 'a jóváhagyottnál több adat megosztása soha nem autonóm (§22, AC-7)' }
  }

  const s = getLadder(db, caseType)
  if (s.paused) {
    return { allowed: false, code: 'paused', requiresApproval: false,
      reason: 'a Personal Chief szüneteltetve van (főkapcsoló vagy típus-szintű szünet)' }
  }

  const need: Record<Exclude<ActionKind, 'PAYMENT' | 'SHARE_BEYOND_APPROVED'>, Rung> = {
    OBSERVE: 'OBSERVE', DRAFT: 'PREPARE', SEND: 'EXECUTE_WITH_APPROVAL',
  }
  const required = need[action as 'OBSERVE' | 'DRAFT' | 'SEND']
  if (rungIndex(s.rung) < rungIndex(required)) {
    return { allowed: false, code: 'rung_too_low', requiresApproval: false,
      reason: `${caseType} fokozata ${s.rung}, ehhez legalább ${required} kellene` }
  }
  if (action === 'SEND' && s.rung === 'EXECUTE_WITH_APPROVAL') {
    return { allowed: true, code: 'approval_required', requiresApproval: true,
      reason: 'küldhető, de csak kifejezett jóváhagyással' }
  }
  return { allowed: true, code: 'ok', requiresApproval: false, reason: `${s.rung} fokozat engedi` }
}

export interface Eligibility {
  eligible: boolean
  nextRung: Rung | null
  reason: string
}

/** Is this type ELIGIBLE for the next rung? Eligibility is not promotion: the
 *  owner raises it. A ladder that climbs itself is a delay, not a safeguard. */
export function promotionEligibility(db: Database.Database, caseType: string): Eligibility {
  const s = getLadder(db, caseType)
  const i = rungIndex(s.rung)
  if (i >= rungIndex(s.ceiling)) {
    return { eligible: false, nextRung: null, reason: `elérte a tulajdonosi plafont (${s.ceiling})` }
  }
  if (s.faultlessCampaigns < PROMOTION_THRESHOLD) {
    return { eligible: false, nextRung: RUNGS[i + 1],
      reason: `${s.faultlessCampaigns}/${PROMOTION_THRESHOLD} hibátlan kampány` }
  }
  return { eligible: true, nextRung: RUNGS[i + 1],
    reason: `${s.faultlessCampaigns} hibátlan kampány után emelhető — a döntés Istvané` }
}

/** Record a campaign outcome. A fault RESETS the counter: three clean runs after
 *  a mistake is the point, not three clean runs ever. */
export function recordCampaignOutcome(
  db: Database.Database, caseType: string, faultless: boolean, now: number,
): number {
  const s = getLadder(db, caseType)
  const next = faultless ? s.faultlessCampaigns + 1 : 0
  setLadder(db, caseType, { faultlessCampaigns: next }, now)
  return next
}

/** How the ladder maps onto the fleet's 1-3 config, so one place stays the
 *  truth and the other stays a mirror (owner decision 2026-08-09). */
export function fleetLevelFor(rung: Rung): 1 | 2 | 3 {
  switch (rung) {
    case 'OFF': case 'OBSERVE': return 1
    case 'PREPARE': case 'EXECUTE_WITH_APPROVAL': return 2
    case 'LIMITED_AUTONOMOUS': return 3
  }
}
