// Personal Chief of Staff (COS) — the consumer the wake mechanism never had.
//
// `next_wake_at` means "come back to this case at time T". Everything for it
// was built: `setNextWake` writes it, `dueCases` reads it, and the tick called
// the reader on every cycle. Then it kept `dueCases(db, now).length` and threw
// the rows away, so nothing could act on a wake, so nobody filled the column,
// so the reader always returned nothing. Measured 2026-08-16: 0 of 61 open
// cases carried a wake time — a mechanism complete at both ends and dead in the
// middle.
//
// It surfaced the day a decision deadline stated only in prose ("DONTES
// 2026-08-16 10:00 elott", on two competing car rentals) passed unnoticed. That
// deadline had a natural home — a wake at 09:00 — and the home was unusable.
//
// WHY THE WAKE IS CLEARED WHEN IT FIRES
//
// A wake is an appointment, not a property: once kept, it is over. Clearing it
// is also the dedup — without it this alert would repeat every ten minutes for
// as long as the case stayed open, which is how a real signal gets muted. The
// clearing is not a loss of history: `setNextWake` leaves the case's event
// stream intact and this module writes the alert into the daily log.
//
// If a case needs waking again, something must ASK for it again. That is the
// right direction: a repeat that nobody re-armed is noise pretending to be
// vigilance.

import type Database from 'better-sqlite3'
import { dueCases, setNextWake, type DueCase } from './scheduler.js'
import { createAgentMessage, appendDailyLog } from '../db.js'

export interface WakeAlertResult {
  /** Cases whose wake fired in this run, in the order reported. */
  woken: DueCase[]
  /** The message posted, or null when there was nothing to post. */
  content: string | null
  posted: boolean
}

function line(c: DueCase, now: number): string {
  const late = c.next_wake_at === null ? '' :
    ` (${Math.max(0, Math.floor((now - c.next_wake_at) / 60))} perce esedékes)`
  return `- ${c.priority} ${c.title} [${c.case_id}]${late}`
}

/** Build the alert text for cases whose wake time has arrived. Returns null on
 *  an empty list: unlike a daily digest, this is an event alert — a wake that
 *  did not happen is not news, and saying so every ten minutes would bury the
 *  wakes that did. */
export function buildWakeAlert(db: Database.Database, now: number): { content: string | null; woken: DueCase[] } {
  const woken = dueCases(db, now)
  if (woken.length === 0) return { content: null, woken }
  const head = woken.length === 1
    ? 'Egy ügy ébresztője lejárt:'
    : `${woken.length} ügy ébresztője lejárt:`
  return { content: `${head}\n${woken.map((c) => line(c, now)).join('\n')}`, woken }
}

/**
 * Surface woken cases to the owner's agent and clear their wake.
 *
 * The order matters and matches `alertOutboundRecovery`: post FIRST, clear
 * after. A crash between them re-alerts next cycle, which is recoverable; the
 * other order loses the wake silently, which is the failure this module exists
 * to end.
 */
export function alertWokenCases(db: Database.Database, now: number): WakeAlertResult {
  const { content, woken } = buildWakeAlert(db, now)
  if (!content) return { woken, content: null, posted: false }

  createAgentMessage('cos-wake', 'marveen', content, 'cos-wake-alert')
  appendDailyLog('marveen', `## COS ébresztő\n${content}`)
  for (const c of woken) setNextWake(db, c.case_id, null, now)
  return { woken, content, posted: true }
}
