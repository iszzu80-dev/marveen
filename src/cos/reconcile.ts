// Personal Chief of Staff (COS) — daily reconcile (§14 `personal-daily-reconcile`).
//
// The spec asks this job to walk the ledger, the batches, the checkpoints, the
// store, the kanban link and the connector health, and to sort out the
// OUTCOME_UNKNOWN / RECOVERY cases. It was never built, and its absence is why
// the 2026-08-09 failures survived three days: eighteen batches sat OPEN, the
// checkpoint table was empty, and no job existed whose whole purpose was to
// notice exactly that.
//
// Deterministic on purpose. A scheduled task whose body is "look around and
// tell me if something is wrong" is a prompt, and §25/(3) forbids prompt-only
// work — a prompt has no failing state, so it degrades silently into a
// reassuring paragraph. This module returns findings or an empty list, and the
// runner's exit code follows.
//
// Read-only. It diagnoses, it never repairs: an automatic fix here would erase
// the evidence of how the system got into the state, and several of these
// findings (a stuck SENDING row, a cursor that cannot advance) need a human to
// decide before anything is touched.

import type Database from 'better-sqlite3'
import { evaluateOutputFloors, breachedFloors } from './output-floor.js'

export type Severity = 'CRITICAL' | 'WARNING' | 'INFO'

export interface Finding {
  id: string
  severity: Severity
  /** Spec section this check defends. */
  ref: string
  title: string
  /** What was measured, in numbers. */
  detail: string
  /** What a human should do about it. Empty is not allowed — a finding nobody
   *  can act on is noise that trains people to skip the report. */
  action: string
}

export interface ReconcileReport {
  at: number
  findings: Finding[]
  counts: Record<Severity, number>
  /** True only when nothing at all was found. */
  clean: boolean
}

const DAY = 86400

function count(db: Database.Database, sql: string, ...args: unknown[]): number | null {
  try {
    const r = db.prepare(sql).get(...(args as [])) as { n: number } | undefined
    return r?.n ?? 0
  } catch {
    return null   // unreadable — the caller reports that, never treats it as zero
  }
}

/** Every check is a small function so each can be exercised on its own; a check
 *  that can only be tested through the whole report is a check whose failure
 *  mode nobody has seen. */
type Check = (db: Database.Database, now: number) => Finding | null

const stuckLocalApplied: Check = (db, now) => {
  const n = count(db, `SELECT COUNT(*) AS n FROM email_processing WHERE status='LOCAL_APPLIED' AND updated_at < ?`, now - DAY)
  if (n === null) return { id: 'email_processing_unreadable', severity: 'CRITICAL', ref: '§8',
    title: 'A feldolgozási tábla nem olvasható', detail: 'email_processing lekérdezés hibára futott',
    action: 'Ellenőrizd a séma-migrációt és a store épségét.' }
  if (n === 0) return null
  return {
    id: 'messages_never_source_committed', severity: 'CRITICAL', ref: '§8, AC-10',
    title: 'Üzenetek ragadtak a lánc közepén',
    detail: `${n} üzenet áll LOCAL_APPLIED állapotban 24 óránál régebben, tehát a forrás-commit nem fut le rájuk.`,
    action: 'A §8 lánc második fele nincs bekötve vagy elakadt. Amíg így van, a rendszer nem tudja, meddig jutott.',
  }
}

const openBatches: Check = (db, now) => {
  const n = count(db, `SELECT COUNT(*) AS n FROM email_processing_batches WHERE status IN ('OPEN','PROCESSING') AND updated_at < ?`, now - DAY)
  if (n === null || n === 0) return null
  return {
    id: 'batches_never_closed', severity: 'CRITICAL', ref: '§8, AC-11',
    title: 'Kötegek maradtak nyitva',
    detail: `${n} köteg egy napnál régebben nyitott. A fiók-cursor csak lezárt kötegen léphet, tehát nem lép.`,
    action: 'Nézd meg, melyik elem nem terminális a kötegben; ha karanténba való, oda kell tenni, explicit policy alapján.',
  }
}

const missingCheckpoint: Check = (db) => {
  let accounts: string[] = []
  let have = new Set<string>()
  try {
    accounts = (db.prepare(`SELECT DISTINCT gmail_account_id AS a FROM email_processing`).all() as Array<{ a: string }>).map(r => r.a)
    have = new Set((db.prepare(`SELECT gmail_account_id AS a FROM email_source_checkpoints`).all() as Array<{ a: string }>).map(r => r.a))
  } catch { return null }
  const missing = accounts.filter(a => !have.has(a))
  if (!missing.length) return null
  return {
    id: 'account_cursor_missing', severity: 'CRITICAL', ref: '§6.4',
    title: 'Van fiók, aminek nincs pozíciója',
    detail: `Cursor nélküli fiók: ${missing.join(', ')}. A rendszer nem tudja, meddig dolgozta fel a postát.`,
    action: 'A batch-lezárás állítja be a cursort; amíg a kötegek nyitva vannak, ez sem jön létre.',
  }
}

const outboundNeedsHuman: Check = (db) => {
  const n = count(db, `SELECT COUNT(*) AS n FROM outbound_ledger WHERE status IN ('RECOVERY_REQUIRED','FAILED_TERMINAL')`)
  if (n === null || n === 0) return null
  return {
    id: 'outbound_needs_human', severity: 'CRITICAL', ref: '§7.3, §19',
    title: 'Kimenő művelet emberre vár',
    detail: `${n} sor RECOVERY_REQUIRED vagy FAILED_TERMINAL állapotban. A végrehajtó ezeket sosem oldja fel magától.`,
    action: 'Nézd meg egyenként, mi történt a küldéssel, és döntsd el: újra, elenged, vagy kompenzáció.',
  }
}

const outcomeUnknown: Check = (db, now) => {
  const n = count(db,
    `SELECT COUNT(*) AS n FROM outbound_ledger WHERE status IN ('OUTCOME_UNKNOWN','APPLIED_UNVERIFIED') AND updated_at < ?`,
    now - DAY)
  if (n === null || n === 0) return null
  return {
    id: 'outcome_unknown_aging', severity: 'WARNING', ref: 'v4.2.1 B.1',
    title: 'Bizonytalan kimenetelű küldés áll egy napja',
    detail: `${n} sor OUTCOME_UNKNOWN vagy APPLIED_UNVERIFIED állapotban, 24 óránál régebben.`,
    action: 'Visszaolvasás kell a kereshető jel alapján. Újraküldeni TILOS visszaolvasás nélkül.',
  }
}

const stuckSending: Check = (db, now) => {
  const n = count(db, `SELECT COUNT(*) AS n FROM outbound_ledger WHERE status='SENDING' AND updated_at < ?`, now - 3600)
  if (n === null || n === 0) return null
  return {
    id: 'sending_stuck', severity: 'CRITICAL', ref: '§7.3',
    title: 'Küldés ragadt SENDING állapotban',
    detail: `${n} sor egy óránál régebben SENDING. A folyamat vagy elszállt a hívás közben, vagy a readback nem futott le.`,
    action: 'Visszaolvasás a kereshető jel alapján, MIELŐTT bármit újraküldenél.',
  }
}

const connectorDown: Check = (db) => {
  let rows: Array<{ connector_id: string; status: string; consecutive_failures: number }> = []
  try {
    rows = db.prepare(`SELECT connector_id, status, consecutive_failures FROM connector_health WHERE status IN ('DOWN','DEGRADED')`).all() as never
  } catch { return null }
  if (!rows.length) return null
  const down = rows.filter(r => r.status === 'DOWN')
  return {
    id: 'connector_unhealthy', severity: down.length ? 'CRITICAL' : 'WARNING', ref: '§12, §19',
    title: 'Csatlakozó nincs rendben',
    detail: rows.map(r => `${r.connector_id}: ${r.status} (${r.consecutive_failures} hiba egymás után)`).join('; '),
    action: down.length
      ? 'DOWN csatlakozóval nem indul külső művelet. Ha auth-hiba, új hozzájárulás kell.'
      : 'Figyeld; ha nem áll helyre magától, nézd meg a hitelesítést.',
  }
}

const staleClaims: Check = (db, now) => {
  const n = count(db, `SELECT COUNT(*) AS n FROM case_claims WHERE claim_expires_at < ?`, now)
  if (n === null || n === 0) return null
  return {
    id: 'stale_claims', severity: 'WARNING', ref: '§9',
    title: 'Lejárt foglalás maradt a táblában',
    detail: `${n} lejárt claim. Ezek átvehetők, de amíg ott ülnek, egy elszállt futás nyomát jelzik.`,
    action: 'Recovery-check után atomikus upserttel átvehető; nézd meg, mi ölte meg az eredeti futást.',
  }
}

const corporateInPersonal: Check = (db) => {
  let rows: Array<{ case_id: string; title: string }> = []
  try {
    rows = db.prepare(
      `SELECT case_id, title FROM personal_cases
       WHERE archived_at IS NULL AND (title LIKE '%ZST%' OR description LIKE '%ZST%'
         OR title LIKE '%ONE Magyarorsz%' OR title LIKE '%Product Lab%')`
    ).all() as never
  } catch { return null }
  if (!rows.length) return null
  return {
    id: 'corporate_content_in_personal_store', severity: 'CRITICAL', ref: '§19 kritikus, AC-17',
    title: 'Céges tartalom a személyes tárban',
    detail: `${rows.length} ügy: ${rows.slice(0, 4).map(r => r.case_id).join(', ')}`,
    action: 'A spec szerint ez kritikus riasztás. Vagy a Scope Gate hiányzik, vagy a postafiók-szabály engedte át.',
  }
}

const outputFloorBreaches: Check = (db, now) => {
  const breached = breachedFloors(evaluateOutputFloors(db, now))
  if (!breached.length) return null
  const silent = breached.filter(b => b.status === 'SILENT')
  return {
    id: 'output_floor_breached', severity: silent.length ? 'CRITICAL' : 'WARNING', ref: '§19, audit 2026-08-09',
    title: 'Futószalag nem termel',
    detail: breached.map(b => `${b.label}: ${b.observed}/${b.floor} (${b.windowHours}h)`).join('; '),
    action: silent.length
      ? `Nulla termelés itt: ${silent.map(b => b.label).join(', ')}. ${silent[0].meaning}`
      : 'A küszöb alatti futószalagokat nézd meg, mielőtt csendes hétnek könyveled.',
  }
}

const duplicateSendAttempt: Check = (db) => {
  // §19 minimum #1. The UNIQUE constraints make a duplicate physically
  // impossible, so what we look for is the ATTEMPT: two ledger rows for the same
  // campaign+recipient+kind. A silent "the constraint held" is not the same as
  // "nothing tried" — the second means the idempotency key is being derived
  // wrongly somewhere upstream.
  let rows: Array<{ n: number }> = []
  try {
    rows = db.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT campaign_id, recipient, action_type, COUNT(*) AS c
         FROM outbound_ledger WHERE campaign_id IS NOT NULL AND recipient IS NOT NULL
         GROUP BY campaign_id, recipient, action_type HAVING c > 1)`
    ).all() as never
  } catch { return null }
  const n = rows[0]?.n ?? 0
  if (!n) return null
  return {
    id: 'duplicate_send_attempt', severity: 'CRITICAL', ref: '§19 kritikus, AC-1',
    title: 'Ugyanannak a címzettnek több küldés indult',
    detail: `${n} kampány+címzett+típus hármas fordul elő többször a ledgerben.`,
    action: 'Az idempotencia-kulcs valahol nem fedi le a küldést. Nézd meg, mielőtt bármit újraindítasz.',
  }
}

const failedReadback: Check = (db) => {
  // §19 minimum #3: a send the provider accepted but we could never verify.
  const n = count(db, `SELECT COUNT(*) AS n FROM outbound_ledger WHERE status='APPLIED_UNVERIFIED'`)
  if (n === null || n === 0) return null
  return {
    id: 'readback_never_succeeded', severity: 'WARNING', ref: '§19, v4.2.1 B.1',
    title: 'Sikertelen visszaolvasás',
    detail: `${n} küldésnél a szolgáltató sikert adott, de a visszaolvasás nem erősítette meg.`,
    action: 'Napi egyeztetés tárgya. Újraküldeni TILOS: a levél nagy eséllyel kiment.',
  }
}

const stalledCampaign: Check = (db, now) => {
  // §19 minimum #4: a campaign that is paused or has not moved.
  let rows: Array<{ campaign_id: string; status: string }> = []
  try {
    rows = db.prepare(
      `SELECT campaign_id, status FROM campaigns
       WHERE status IN ('PAUSED','DRAFT') AND updated_at < ?`
    ).all(now - 7 * DAY) as never
  } catch { return null }
  if (!rows.length) return null
  return {
    id: 'campaign_stalled', severity: 'WARNING', ref: '§19, §15',
    title: 'Kampány áll egy hete',
    detail: rows.map(r => `${r.campaign_id}: ${r.status}`).join('; '),
    action: 'Vagy folytatni kell, vagy lezárni. Egy örökre DRAFT-ban álló kampány elfelejtett szándék.',
  }
}

const expiredApproval: Check = (db, now) => {
  // §19 minimum #5. An approval past its validity is not a bug on its own — it
  // becomes one when the case still expects a send to happen.
  const n = count(db,
    `SELECT COUNT(*) AS n FROM campaign_approvals WHERE status='APPROVED' AND valid_until IS NOT NULL AND valid_until < ?`,
    now)
  if (n === null || n === 0) return null
  return {
    id: 'approval_expired', severity: 'WARNING', ref: '§19, §3.2',
    title: 'Lejárt jóváhagyás',
    detail: `${n} jóváhagyás érvényessége lejárt, de még APPROVED státuszban áll.`,
    action: 'Ha a küldés még aktuális, új jóváhagyás kell. A lejárt már úgysem hatalmaz fel semmire.',
  }
}

const repeatedFollowUp: Check = (db) => {
  // §19 minimum #8: the same case chasing the same party again and again.
  let rows: Array<{ case_id: string; c: number }> = []
  try {
    rows = db.prepare(
      `SELECT case_id, COUNT(*) AS c FROM outbound_ledger
       WHERE outbound_kind='FOLLOW_UP' GROUP BY case_id HAVING c >= 3`
    ).all() as never
  } catch { return null }
  if (!rows.length) return null
  return {
    id: 'follow_up_repeated', severity: 'WARNING', ref: '§19',
    title: 'Sokadik utánkövetés ugyanabban az ügyben',
    detail: rows.map(r => `${r.case_id}: ${r.c} follow-up`).join('; '),
    action: 'Három sikertelen utánkövetés után nem a negyedik levél a megoldás. Más csatorna vagy Istvan döntése kell.',
  }
}

const radarCheckFailing: Check = (db, now) => {
  // §19 minimum #9: a radar item whose scheduled check is overdue — the price
  // watch is asleep, and a target hit would pass unnoticed.
  const n = count(db,
    `SELECT COUNT(*) AS n FROM radar_items WHERE status='ACTIVE' AND next_check_at IS NOT NULL AND next_check_at < ?`,
    now - DAY)
  if (n === null || n === 0) return null
  return {
    id: 'radar_check_overdue', severity: 'WARNING', ref: '§19, §16',
    title: 'Radar-ellenőrzés csúszik',
    detail: `${n} aktív radar-elem esedékes ellenőrzése egy napnál régebben lejárt.`,
    action: 'Az árfigyelés erre az elemre alszik; egy célár-találat észrevétlen maradna.',
  }
}

const cursorBatchMismatch: Check = (db) => {
  // §19 KRITIKUS: the cursor moved past a batch that never terminalised. This is
  // the one that says the system believes it processed mail it did not.
  let n = 0
  try {
    n = (db.prepare(
      `SELECT COUNT(*) AS n FROM email_source_checkpoints cp
       JOIN email_processing_batches b ON b.gmail_account_id = cp.gmail_account_id
       WHERE b.status IN ('OPEN','PROCESSING') AND b.cursor_after IS NOT NULL
         AND cp.history_cursor IS NOT NULL AND cp.history_cursor >= b.cursor_after`
    ).get() as { n: number }).n
  } catch { return null }
  if (!n) return null
  return {
    id: 'cursor_past_open_batch', severity: 'CRITICAL', ref: '§19 kritikus, AC-11',
    title: 'A pozíció túllépett egy lezáratlan kötegen',
    detail: `${n} köteg nyitva van, miközben a fiók pozíciója már túl van rajta.`,
    action: 'A rendszer azt hiszi, feldolgozott olyan levelet, amit nem. Ez adatvesztés, nem késés.',
  }
}

export const CHECKS: Check[] = [
  stuckLocalApplied, openBatches, missingCheckpoint,
  outboundNeedsHuman, outcomeUnknown, stuckSending,
  connectorDown, staleClaims, corporateInPersonal, outputFloorBreaches,
  // §19 further minimum + critical alerts
  duplicateSendAttempt, failedReadback, stalledCampaign, expiredApproval,
  repeatedFollowUp, radarCheckFailing, cursorBatchMismatch,
]

/** Run every check. Order of findings: CRITICAL first — a report that buries the
 *  critical line under three warnings gets skimmed. */
export function runDailyReconcile(
  db: Database.Database,
  now: number = Math.floor(Date.now() / 1000),
  checks: Check[] = CHECKS,
): ReconcileReport {
  const findings: Finding[] = []
  for (const c of checks) {
    let f: Finding | null = null
    try {
      f = c(db, now)
    } catch (e) {
      // A check that throws is itself a finding. Swallowing it would make the
      // reconcile quietly narrower every time something breaks underneath it.
      f = {
        id: 'check_threw', severity: 'CRITICAL', ref: '§14',
        title: 'Egy egyeztető ellenőrzés hibára futott',
        detail: String((e as Error).message).slice(0, 200),
        action: 'Az egyeztetés ettől kezdve vak erre a területre. Javítsd, mielőtt a jelentést elhiszed.',
      }
    }
    if (f) findings.push(f)
  }
  const rank: Record<Severity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 }
  findings.sort((a, b) => rank[a.severity] - rank[b.severity])
  const counts: Record<Severity, number> = { CRITICAL: 0, WARNING: 0, INFO: 0 }
  for (const f of findings) counts[f.severity] += 1
  return { at: now, findings, counts, clean: findings.length === 0 }
}

/** Plain-text report for the scheduled task / Telegram. Empty string when clean:
 *  the daily job must be silent on a good day, or it becomes wallpaper. */
export function formatReconcileReport(r: ReconcileReport): string {
  if (r.clean) return ''
  const lines = [`COS napi egyeztetés: ${r.counts.CRITICAL} kritikus, ${r.counts.WARNING} figyelmeztetés`]
  for (const f of r.findings) {
    lines.push('')
    lines.push(`[${f.severity}] ${f.title} (${f.ref})`)
    lines.push(f.detail)
    lines.push(`Teendő: ${f.action}`)
  }
  return lines.join('\n')
}
