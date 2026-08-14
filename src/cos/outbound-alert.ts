// Personal Chief of Staff (COS) — outbound RECOVERY_REQUIRED alert.
//
// An outbound action lands in RECOVERY_REQUIRED when the provider reported
// success but the idempotency marker is provably absent on readback (executor
// P1.1). That is an anomaly a human must resolve — the executor will NEVER
// auto-resend it (the provider claimed success, resending risks a double-send).
// Left unsurfaced it would sit silently; this posts it to the bus (marveen relays
// to Telegram) + the daily log so it actually gets seen.

import type Database from 'better-sqlite3'
import { createAgentMessage, appendDailyLog } from '../db.js'
import { APP_TZ } from '../config.js'

interface RecRow { ledger_id: string; case_id: string | null; action_type: string; last_error: string | null }

/** Build the human-facing text for the current RECOVERY_REQUIRED rows. Returns
 *  null if there are none. Pure over the DB → testable. */
export function buildOutboundRecoveryAlert(db: Database.Database, limit = 20): string | null {
  const rows = db.prepare(
    `SELECT ledger_id, case_id, action_type, last_error FROM outbound_ledger
     WHERE status='RECOVERY_REQUIRED' ORDER BY created_at ASC LIMIT ?`
  ).all(limit) as RecRow[]
  if (rows.length === 0) return null
  const lines = rows.map(r => `- ${r.action_type} (${r.ledger_id}${r.case_id ? `, case ${r.case_id}` : ''}): ${r.last_error ?? 'marker absent after provider success'}`)
  return `⚠️ COS outbound RECOVERY_REQUIRED (${rows.length}): a provider sikert jelzett, de a marker nem talalhato vissza. NEM kuldjuk ujra (dupla-kuldes kockazat) - emberi ellenorzes kell.\n${lines.join('\n')}`
}

/** Surface RECOVERY_REQUIRED outbound rows: bus message (marveen relays to
 *  Telegram) + daily log. No-op if there are none. */
export function alertOutboundRecovery(db: Database.Database): boolean {
  const content = buildOutboundRecoveryAlert(db)
  if (!content) return false
  createAgentMessage('cos-outbound', 'marveen', content, 'cos-autonomous-recovery')
  appendDailyLog('marveen', `## COS OUTBOUND RECOVERY_REQUIRED\n${content}`)
  return true
}

// ── PLANNED waiting list ────────────────────────────────────────────────────
//
// 2026-08-15. A drafted letter (followup-autodraft → draftSend) lands in
// outbound_ledger as PLANNED and waits for Istvan's approval. Measured that
// night: one real letter to a real counterparty had been sitting PLANNED since
// 2026-08-13 00:44 and NOTHING had said so. Not a data bug and not a code bug:
// `alertOutboundRecovery` above only looks at RECOVERY_REQUIRED, and the
// scheduler deliberately excludes PLANNED so it cannot auto-send. Correct on
// both counts, and between them nobody pushes the queue in front of the owner.
//
// Same shape as the Today-view bug the same evening: the data is right, the
// surface exists (GET /api/cos/outbound), and it is PULL-only. "It works" and
// "he will ever see it" are different claims.
//
// TWO DESIGN POINTS, both deliberate:
//
// 1. THE ZERO CASE SPEAKS. `buildPlannedDigest` never returns null. A daily
//    signal that goes quiet when there is nothing to report is
//    indistinguishable from one that broke — exactly the dead-monitor shape
//    this file exists to prevent one status over.
//
// 2. NO BODY TEXT LEAVES HERE. The digest carries ledger id, case, subject,
//    recipient and age. The letter body stays in the ledger and on the
//    dashboard, because a daily bus message is a wide surface for the contents
//    of personal correspondence. The recipient IS included: a wrong address is
//    the thing you must notice first, and it cannot be noticed from a count.

/** Marks the digest's own daily-log receipt. The once-a-day guard looks for
 *  THIS string, so the thing it checks is the thing it produces: a day with no
 *  receipt fires, and a receipt cannot exist without the digest having run. */
export const PLANNED_DIGEST_HEADER = '## COS PLANNED kimeno varolista'

const DAY = 86400

interface PlannedRow {
  ledger_id: string; case_id: string | null; case_title: string | null
  recipient: string | null; payload: string | null; created_at: number
}

export interface PlannedDigest {
  count: number
  /** Age of the longest-waiting row, in whole days. null when count is 0. */
  oldestAgeDays: number | null
  /** Always present, zero case included. */
  text: string
}

/** The PLANNED outbound queue as a human-facing digest. Pure over the DB →
 *  testable, and callable for a read-only look without posting anything. */
export function buildPlannedDigest(db: Database.Database, now: number, limit = 20): PlannedDigest {
  const rows = db.prepare(
    `SELECT l.ledger_id, l.case_id, c.title AS case_title, l.recipient, l.payload, l.created_at
       FROM outbound_ledger l LEFT JOIN personal_cases c ON c.case_id = l.case_id
      WHERE l.status = 'PLANNED'
      ORDER BY l.created_at ASC LIMIT ?`
  ).all(limit) as PlannedRow[]
  const total = (db.prepare(
    `SELECT COUNT(*) AS n FROM outbound_ledger WHERE status='PLANNED'`
  ).get() as { n: number }).n

  if (total === 0) {
    return { count: 0, oldestAgeDays: null,
      text: `${PLANNED_DIGEST_HEADER}: 0 sor. Nincs jovahagyasra varo megfogalmazott level.` }
  }

  const ageDays = (t: number) => Math.floor((now - t) / DAY)
  const oldest = rows.length > 0 ? ageDays(rows[0]!.created_at) : 0
  const subjectOf = (payload: string | null): string => {
    if (!payload) return '(nincs targy)'
    try {
      const s = (JSON.parse(payload) as { subject?: unknown }).subject
      return typeof s === 'string' && s.trim() !== '' ? s : '(nincs targy)'
    } catch { return '(olvashatatlan payload)' }
  }
  const lines = rows.map(r =>
    `- ${ageDays(r.created_at)} napja: "${subjectOf(r.payload)}" -> ${r.recipient ?? '(nincs cimzett)'}`
    + ` [${r.ledger_id}${r.case_id ? `, ugy ${r.case_title ?? r.case_id}` : ''}]`)
  // The listing is capped; say so rather than let a truncated list read as the
  // whole queue. Same reason sweepFollowUpCandidates reports scan_window_exhausted.
  const more = total > rows.length ? `\n(+${total - rows.length} tovabbi, a lista ${limit} sorra van vagva)` : ''
  return {
    count: total, oldestAgeDays: oldest,
    text: `${PLANNED_DIGEST_HEADER}: ${total} megfogalmazott level var a jovahagyasodra`
      + ` (a legregebbi ${oldest} napja). Semmi nem ment el.\n${lines.join('\n')}${more}`,
  }
}

/** Did today's digest already run? Answered from its own receipt, so a missing
 *  receipt always re-fires and a spurious "already done" is impossible. */
export function plannedDigestPostedToday(db: Database.Database, todayOverride?: string): boolean {
  const today = todayOverride ?? new Date().toLocaleDateString('en-CA', { timeZone: APP_TZ })
  const hit = db.prepare(
    `SELECT 1 AS x FROM daily_logs
      WHERE agent_id='marveen' AND date=? AND content LIKE ? LIMIT 1`
  ).get(today, `${PLANNED_DIGEST_HEADER}%`) as { x: number } | undefined
  return hit !== undefined
}

export interface PlannedDigestResult {
  posted: boolean
  /** True when today's receipt already existed, so nothing was posted again. */
  alreadyToday: boolean
  count: number
  oldestAgeDays: number | null
}

/**
 * Post the PLANNED digest once per Budapest calendar day: bus message (marveen
 * relays to Telegram) + daily log receipt.
 *
 * Runs from the ten-minute cycle rather than its own schedule on purpose. A
 * separate daily task that never fires is silent in exactly the way this digest
 * exists to fix; riding the cycle means the digest is alive whenever the cycle
 * is, and the cycle's own liveness is already reported.
 */
export function reportPlannedOutbound(
  db: Database.Database, now: number, todayOverride?: string,
): PlannedDigestResult {
  const digest = buildPlannedDigest(db, now)
  if (plannedDigestPostedToday(db, todayOverride)) {
    return { posted: false, alreadyToday: true, count: digest.count, oldestAgeDays: digest.oldestAgeDays }
  }
  createAgentMessage('cos-outbound', 'marveen', digest.text, 'cos-planned-digest')
  appendDailyLog('marveen', digest.text)
  return { posted: true, alreadyToday: false, count: digest.count, oldestAgeDays: digest.oldestAgeDays }
}
