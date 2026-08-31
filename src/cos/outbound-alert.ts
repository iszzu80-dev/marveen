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
import { ownerQuestionCapacity, heldOwnerQuestionBacklog } from './owner-question.js'

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
  /** Which namespace the row came from, so a corporate letter is not reported as
   *  a personal one. */
  ns: 'szemelyes' | 'ZST'
}

// TWO ledgers, not one. The first version of this digest read `outbound_ledger`
// alone, which is the personal namespace — so a corporate letter would have sat
// waiting for approval exactly the way ob-mv-4655682f sat for two days, and this
// digest, whose entire job is to stop that, would have reported zero.
//
// Found by the review peer within an hour of the digest landing, and it is the
// same shape as three other findings the same night: every new protection is born
// on the personal path and the corporate one gets it later, on a separate code
// path, maybe. Fixed here by making ONE function read both, rather than growing a
// second digest that drifts from this one.
const LEDGERS = [
  { table: 'outbound_ledger', cases: 'personal_cases', ns: 'szemelyes' as const },
  { table: 'zst_outbound_ledger', cases: 'zst_cases', ns: 'ZST' as const },
]

export interface PlannedDigest {
  count: number
  /** Age of the longest-waiting row, in whole days. null when count is 0. */
  oldestAgeDays: number | null
  /** Always present, zero case included. */
  text: string
}

/** The PLANNED outbound queue as a human-facing digest. Pure over the DB →
 *  testable, and callable for a read-only look without posting anything. */
/** The question's first line — the digest names what is blocking, it does not
 *  reprint whole questions. */
function firstLine(text: string): string {
  const l = text.split('\n').find(x => x.trim() !== '') ?? '(ures kerdes)'
  return l.length > 90 ? `${l.slice(0, 90)}...` : l
}

export function buildPlannedDigest(db: Database.Database, now: number, limit = 20): PlannedDigest {
  const rows: PlannedRow[] = []
  let total = 0
  for (const L of LEDGERS) {
    // A missing table is not an empty queue. If the ZST schema has not been
    // created in this database, say so by throwing rather than reporting zero —
    // "nothing is waiting" and "I could not look" must not render identically.
    const part = db.prepare(
      `SELECT l.ledger_id, l.case_id, c.title AS case_title, l.recipient, l.payload, l.created_at
         FROM ${L.table} l LEFT JOIN ${L.cases} c ON c.case_id = l.case_id
        WHERE l.status = 'PLANNED'
        ORDER BY l.created_at ASC LIMIT ?`
    ).all(limit) as Omit<PlannedRow, 'ns'>[]
    for (const r of part) rows.push({ ...r, ns: L.ns })
    total += (db.prepare(
      `SELECT COUNT(*) AS n FROM ${L.table} WHERE status='PLANNED'`
    ).get() as { n: number }).n
  }
  // Oldest first ACROSS both namespaces, then cut — otherwise a long personal
  // queue would push every corporate row past the limit.
  rows.sort((a, b) => a.created_at - b.created_at)
  rows.splice(limit)

  // THE QUESTION CHANNEL'S CEILING, said out loud when it blocks.
  //
  // Istvan's decision 2026-08-15: no kind gets an exemption from the cap, not
  // even SERVICE_QUOTE. The ceiling is right — past a handful, one more
  // question does not get answered faster, it gets the channel muted. But an
  // enforced ceiling nobody can see is a queue that silently swallows: on that
  // day five questions had been open for up to four days, nineteen cases wanted
  // to ask and could not, and the only trace was a counter in cycle telemetry.
  //
  // It rides THIS digest rather than getting its own, for the reason the whole
  // card is about: a second daily surface is a second thing that can stop
  // firing unnoticed. This one already speaks every day, zero case included.
  const capacity = ownerQuestionCapacity(db)
  // E2, 2026-08-31: WHAT IS WAITING BEHIND THE WALL, and of what kind.
  //
  // The ceiling line above has said "full, and here is who holds the slots"
  // since 08-15. It never said what the wall was holding back, so a channel
  // blocked by five shopping questions read exactly like one blocked while an
  // authorization gate and a parked decision queued behind it. Those need
  // opposite responses from him and the message could not tell them apart.
  //
  // Reported, NOT given a slot. The class ordering decides who is asked next
  // when a slot frees; it deliberately does not preempt a question already on
  // his board. Visibility is the part that does not need his permission.
  const heldLine = (() => {
    if (!capacity.full) return ''
    let held: ReturnType<typeof heldOwnerQuestionBacklog>
    try { held = heldOwnerQuestionBacklog(db, now) } catch { return '' }
    if (!held.total) return ''
    const byClass = held.byClass.map(c => `${c.count} ${c.cls}`).join(', ')
    const worst = held.top[0]
    return `\n\nA fal MOGOTT ${held.total} kerdes var (${byClass}).`
      + (worst ? ` A legregebben varo: ${worst.caseId} (${worst.cls}, ${Math.floor(worst.ageSec / 86_400)} napja).` : '')
      + ` Egy valasz barmelyik fenti kerdesre ezek kozul a legsurgosebbet engedi ki.`
  })()
  const capacityLine = capacity.full
    ? `\n\n⛔ A KERDES-CSATORNA TELE VAN (${capacity.open}/${capacity.cap}).`
      + ` Amig egyet meg nem valaszolsz, UJ kerdes nem tud kimenni -- egyik ugyrol sem.`
      + ` A helyet ezek foglaljak:\n`
      + capacity.questions.map(q => `- ${q.caseId}: ${firstLine(q.text)}`).join('\n')
      + heldLine
    : ''

  if (total === 0) {
    return { count: 0, oldestAgeDays: null,
      text: `${PLANNED_DIGEST_HEADER}: 0 sor. Nincs jovahagyasra varo megfogalmazott level.${capacityLine}` }
  }

  // Age ROUNDED DOWN to days reported a 46-hour-old letter as "1 napja". On a
  // signal whose whole point is urgency that is the wrong direction to round, so
  // under two days it is stated in hours.
  const ageOf = (t: number): string => {
    const sec = Math.max(0, now - t)
    return sec < 2 * DAY ? `${Math.floor(sec / 3600)} oraja` : `${Math.floor(sec / DAY)} napja`
  }
  const ageDays = (t: number) => Math.floor((now - t) / DAY)
  const oldest = rows.length > 0 ? ageDays(rows[0]!.created_at) : 0
  const oldestText = rows.length > 0 ? ageOf(rows[0]!.created_at) : '0 oraja'
  const subjectOf = (payload: string | null): string => {
    if (!payload) return '(nincs targy)'
    try {
      const s = (JSON.parse(payload) as { subject?: unknown }).subject
      return typeof s === 'string' && s.trim() !== '' ? s : '(nincs targy)'
    } catch { return '(olvashatatlan payload)' }
  }
  const lines = rows.map(r =>
    `- [${r.ns}] ${ageOf(r.created_at)}: "${subjectOf(r.payload)}" -> ${r.recipient ?? '(nincs cimzett)'}`
    + ` [${r.ledger_id}${r.case_id ? `, ugy ${r.case_title ?? r.case_id}` : ''}]`)
  // The listing is capped; say so rather than let a truncated list read as the
  // whole queue. Same reason sweepFollowUpCandidates reports scan_window_exhausted.
  const more = total > rows.length ? `\n(+${total - rows.length} tovabbi, a lista ${limit} sorra van vagva)` : ''
  return {
    count: total, oldestAgeDays: oldest,
    text: `${PLANNED_DIGEST_HEADER}: ${total} megfogalmazott level var a jovahagyasodra`
      + ` (a legregebbi ${oldestText}). Semmi nem ment el.\n${lines.join('\n')}${more}${capacityLine}`,
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
  // Same day for the read and the write -- see reportUnverifiedFinds for what
  // the two clocks cost across midnight.
  const day = todayOverride ?? new Date().toLocaleDateString('en-CA', { timeZone: APP_TZ })
  if (plannedDigestPostedToday(db, day)) {
    return { posted: false, alreadyToday: true, count: digest.count, oldestAgeDays: digest.oldestAgeDays }
  }
  createAgentMessage('cos-outbound', 'marveen', digest.text, 'cos-planned-digest')
  appendDailyLog('marveen', digest.text, day)
  return { posted: true, alreadyToday: false, count: digest.count, oldestAgeDays: digest.oldestAgeDays }
}
