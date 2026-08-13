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
import { numericCursorSql } from './email-ingest.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

/**
 * E10 (review 2026-08-13). The finding a null count MUST produce.
 *
 * `count()` has said "the caller reports that, never treats it as zero" since it
 * was written, and exactly one caller obeyed. Everywhere else the shape was
 * `if (n === null || n === 0) return null` — which folds "this table could not
 * be read" into "there is nothing wrong here", and the daily reconcile then
 * reports a clean day for a surface it is blind to. That is the precise failure
 * this whole module exists to prevent: silence that reads like health.
 *
 * A missing or unreadable table is CRITICAL, not a warning: every check here
 * exists because its absence once cost days, and a check that cannot run is a
 * check that is not running.
 */
function unreadable(table: string, ref: string): Finding {
  return {
    id: `${table}_unreadable`, severity: 'CRITICAL', ref,
    title: 'Egy ellenőrzött tábla nem olvasható',
    detail: `${table}: a lekérdezés hibára futott, tehát erre a területre az egyeztetés VAK — a "nincs találat" itt nem jelent rendben lévő állapotot.`,
    action: 'Ellenőrizd a séma-migrációt és a store épségét. Amíg ez fennáll, a napi jelentés csendje ezen a területen nem bizonyít semmit.',
  }
}

/** Every check is a small function so each can be exercised on its own; a check
 *  that can only be tested through the whole report is a check whose failure
 *  mode nobody has seen. */
type Check = (db: Database.Database, now: number) => Finding | null

const stuckLocalApplied: Check = (db, now) => {
  const n = count(db, `SELECT COUNT(*) AS n FROM email_processing WHERE status='LOCAL_APPLIED' AND updated_at < ?`, now - DAY)
  // The one check that always honoured count()'s contract; it now says so in the
  // same words as every other, from the shared helper.
  if (n === null) return unreadable('email_processing', '§8')
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
  if (n === null) return unreadable('email_processing_batches', '§8, AC-11')
  if (n === 0) return null
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
  if (n === null) return unreadable('outbound_ledger', '§7.3, §19')
  if (n === 0) return null
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
  if (n === null) return unreadable('outbound_ledger', 'v4.2.1 B.1')
  if (n === 0) return null
  return {
    id: 'outcome_unknown_aging', severity: 'WARNING', ref: 'v4.2.1 B.1',
    title: 'Bizonytalan kimenetelű küldés áll egy napja',
    detail: `${n} sor OUTCOME_UNKNOWN vagy APPLIED_UNVERIFIED állapotban, 24 óránál régebben.`,
    action: 'Visszaolvasás kell a kereshető jel alapján. Újraküldeni TILOS visszaolvasás nélkül.',
  }
}

const stuckSending: Check = (db, now) => {
  const n = count(db, `SELECT COUNT(*) AS n FROM outbound_ledger WHERE status='SENDING' AND updated_at < ?`, now - 3600)
  if (n === null) return unreadable('outbound_ledger', '§7.3')
  if (n === 0) return null
  return {
    id: 'sending_stuck', severity: 'CRITICAL', ref: '§7.3',
    title: 'Küldés ragadt SENDING állapotban',
    detail: `${n} sor egy óránál régebben SENDING. A folyamat vagy elszállt a hívás közben, vagy a readback nem futott le.`,
    action: 'Visszaolvasás a kereshető jel alapján, MIELŐTT bármit újraküldenél.',
  }
}

/**
 * E6 (review 2026-08-13). FAILED_RETRYABLE was an ORPHAN STATE.
 *
 * N-3 correctly took it out of the auto-reconcile queue: a row the adapter
 * proved never reached the provider needs a FIRST delivery, and the queue
 * evaluates no gate, so its retry has to go back through dispatchApprovedSend.
 * What nothing did was NOTICE that it never went back. No check reported it, so
 * an approved send knocked over by a transient provider failure sat in the
 * ledger forever and the daily report stayed silent — the exact shape of the
 * 2026-08-09 incident this module was written for, one status along.
 *
 * Reported, never auto-redispatched: redispatching here would put the gate back
 * where N-3 removed it from.
 */
const failedRetryableStranded: Check = (db, now) => {
  const n = count(db,
    `SELECT COUNT(*) AS n FROM outbound_ledger WHERE status='FAILED_RETRYABLE' AND updated_at < ?`,
    now - 6 * 3600)
  if (n === null) return unreadable('outbound_ledger', '§7.3, N-3')
  if (n === 0) return null
  return {
    id: 'failed_retryable_stranded', severity: 'WARNING', ref: '§7.3, §19, N-3',
    title: 'Újrapróbálható hiba áll, és senki nem próbálja újra',
    detail: `${n} sor FAILED_RETRYABLE állapotban 6 óránál régebben. Az automata egyeztetés szándékosan nem nyúl hozzájuk (a újraküldés ELSŐ kézbesítés, kapun kell átmennie), tehát csak a jóváhagyott küldési úton mozdulhatnak.`,
    action: 'Nézd meg, mi bukott el rajtuk. Ha a küldés még aktuális, a jóváhagyott küldési ajtón (dispatch) kell újraindítani; ha nem, zárd le.',
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
  if (n === null) return unreadable('case_claims', '§9')
  if (n === 0) return null
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
    // Terminal cases are excluded: a CANCELLED case that names where it moved
    // to is a tombstone, not live contamination. Counting it would keep the
    // alarm ringing after the thing it warned about was fixed, and an alarm
    // that outlives its cause is how people learn to ignore alarms.
    rows = db.prepare(
      `SELECT case_id, title FROM personal_cases
       WHERE archived_at IS NULL
         AND status NOT IN ('COMPLETED','CANCELLED','ARCHIVED')
         AND (title LIKE '%ZST%' OR description LIKE '%ZST%'
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
  if (n === null) return unreadable('outbound_ledger', '§19, v4.2.1 B.1')
  if (n === 0) return null
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
  if (n === null) return unreadable('campaign_approvals', '§19, §3.2')
  if (n === 0) return null
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
  if (n === null) return unreadable('radar_items', '§19, §16')
  if (n === 0) return null
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
  //
  // Both columns are TEXT and Gmail historyIds are decimal integers, so this
  // used to order them as strings — '9999999' >= '10000000' is true as text and
  // false as a number. On a CRITICAL check that cuts both ways: it invented
  // data-loss alarms whenever the cursor had fewer digits than the batch, and
  // it stayed silent on the real thing whenever it had more. Compare as numbers,
  // and only when both sides actually are positions — a triage batch's
  // 'triage-1755000000' carries none, and SQLite's CAST would read it as 0.
  let n = 0
  try {
    n = (db.prepare(
      `SELECT COUNT(*) AS n FROM email_source_checkpoints cp
       JOIN email_processing_batches b ON b.gmail_account_id = cp.gmail_account_id
       WHERE b.status IN ('OPEN','PROCESSING')
         AND ${numericCursorSql('b.cursor_after')}
         AND ${numericCursorSql('cp.history_cursor')}
         AND CAST(cp.history_cursor AS INTEGER) >= CAST(b.cursor_after AS INTEGER)`
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

const sourceWritePolicyActive: Check = (db) => {
  // A policy exception that nobody can see becomes an assumption. If the cursor
  // is allowed to advance without marking the source, the daily report says so
  // every single day, by design — the cost of the exception has to stay visible
  // for as long as it is in force.
  let policy: { allowCursorAdvanceWithoutSourceWrite?: boolean; reason?: string } = {}
  try {
    policy = JSON.parse(readFileSync(join(process.cwd(), 'store', 'cos-source-commit-policy.json'), 'utf8'))
  } catch { return null }
  if (policy.allowCursorAdvanceWithoutSourceWrite !== true) return null
  const n = count(db, `SELECT COUNT(*) AS n FROM email_processing WHERE last_error LIKE 'source-commit kihagyva%'`)
  return {
    id: 'source_write_policy_active', severity: 'INFO', ref: '§8, A.1 precedens',
    title: 'A pozíció forrás-jelölés NÉLKÜL léphet (érvényes policy)',
    detail: `${n ?? 0} üzenet zárult le így. Ok: ${policy.reason ?? 'nincs megadva'}`,
    action: 'Amint a Gmail-token modify jogot kap, a valódi címkézés bekapcsolható és a kivétel visszavonható.',
  }
}

// --- corporate (ZST) surface -------------------------------------------------
//
// Until 2026-08-10 every check above looked only at the personal tables: the
// word `zst` appeared nowhere in this file. That is why 27 frozen corporate
// cases stayed invisible for a full day — not because the state was hard to
// see, but because nothing looked. A monitor that does not cover a surface
// cannot report on it, and its silence reads exactly like health.
//
// These mirror the personal checks over the zst_ tables. They are deliberately
// separate functions rather than a parameterized sweep: the corporate side has
// its own severities (a stuck corporate send is real company email) and will
// grow checks the personal side does not need.

/** The freeze detector. Runtime twin of the zst-acceptance ZE-2 criterion.
 *  A case whose STATUS says alive and whose progression_enabled says done is
 *  the worst of both: the board shows work in flight, the engine never looks
 *  at it again, and no existing check reads the two fields together. */
const zstFrozenCases: Check = (db) => {
  let rows: Array<{ status: string; n: number; last_change: number }> = []
  try {
    rows = db.prepare(
      `SELECT z.status AS status, COUNT(*) AS n, MAX(s.updated_at) AS last_change
       FROM zst_cases z
       JOIN case_progression_state s ON s.case_id = z.case_id AND s.domain = 'zst'
       WHERE s.progression_enabled = 0
         AND z.status NOT IN ('COMPLETED','CANCELLED','ARCHIVED')
       GROUP BY z.status ORDER BY COUNT(*) DESC`
    ).all() as never
  } catch { return null }
  if (!rows.length) return null
  const total = rows.reduce((a, r) => a + r.n, 0)
  const when = new Date(Math.max(...rows.map(r => r.last_change)) * 1000).toISOString()
  return {
    id: 'zst_cases_frozen', severity: 'CRITICAL', ref: '§19, incidens 2026-08-09',
    title: 'Céges ügyek élőnek látszanak, de a haladás-motor ki van rájuk kapcsolva',
    detail: `${total} ügy (${rows.map(r => `${r.status}: ${r.n}`).join(', ')}), utolsó kapcsoló-változás ${when}`,
    action: 'A táblán aktívnak látszanak, a motor viszont soha nem nézi meg őket. '
      + 'Ne tömegesen kapcsold vissza: előbb kettőt, egy ciklust várj, és nézd meg a case_progression_runs döntését.',
  }
}

/** A corporate send stuck mid-flight. Same shape as stuckSending, different
 *  ledger — and higher stakes, because this one is real company email. */
const zstStuckSending: Check = (db, now) => {
  const n = count(db,
    `SELECT COUNT(*) AS n FROM zst_outbound_ledger WHERE status='SENDING' AND sending_at < ?`,
    now - 3600)
  if (n === null) return unreadable('zst_outbound_ledger', '§7, §19')
  if (n === 0) return null
  return {
    id: 'zst_outbound_stuck_sending', severity: 'CRITICAL', ref: '§7, §19',
    title: 'Céges kimenő tétel egy óránál régebben SENDING állapotban áll',
    detail: `${n} tétel a zst_outbound_ledger-ben`,
    action: 'Kézzel kell eldönteni, kiment-e. Ne indítsd újra vakon: valódi céges levélről van szó.',
  }
}

/** A corporate claim left behind by a crashed run blocks that case forever. */
const zstStaleClaims: Check = (db, now) => {
  const n = count(db, `SELECT COUNT(*) AS n FROM zst_case_claims WHERE claim_expires_at < ?`, now)
  if (n === null) return unreadable('zst_case_claims', '§9')
  if (n === 0) return null
  return {
    id: 'zst_stale_claims', severity: 'WARNING', ref: '§9',
    title: 'Lejárt céges claim maradt a táblában',
    detail: `${n} lejárt claim`,
    action: 'Egy bent felejtett claim megakadályozza, hogy a motor hozzányúljon az ügyhöz. Nézd meg, melyik futás hasalt el.',
  }
}

/** The corporate intake's §8 invariant, measured where it can actually fail. */
const zstMessagesWithoutThread: Check = (db) => {
  const n = count(db,
    `SELECT COUNT(*) AS n FROM zst_email_processing WHERE thread_id IS NULL OR thread_id = ''`)
  if (n === null) return unreadable('zst_email_processing', '§8')
  if (n === 0) return null
  return {
    id: 'zst_message_without_thread', severity: 'WARNING', ref: '§8',
    title: 'Céges üzenet szálazonosító nélkül',
    detail: `${n} sor a zst_email_processing-ben`,
    action: 'A szálazonosító nélküli üzenet nem köthető levelezéshez, tehát utánkövetés sem fogalmazható rá.',
  }
}

// --- stagnation (card 8eb5a1e9) ----------------------------------------------
//
// no_progress_run_count has been incremented correctly since the GATE 2
// follow-up, and read by nobody. On 2026-08-10 the live store held four cases
// at 96 consecutive no-progress runs, two at 95 and twelve at 92 — sixteen
// hours of an engine waking up, achieving nothing, and writing the number down
// where no report looked. A counter with no reader is not an instrument.
//
// This matters more after the completion fix than before it. The engine can no
// longer close anything on its own, by design, so a case it cannot move will
// now spin forever instead of eventually (wrongly) resolving. The spinning is
// the honest behaviour; what would not be honest is doing it quietly.

/** Consecutive fruitless runs before a case is worth mentioning. At the
 *  ten-minute wake cadence this is two hours of getting nowhere: long enough
 *  that a WAITING_EXTERNAL case pausing between real events does not trip it,
 *  short enough to catch a case the same morning it gets stuck. */
const STAGNATION_RUNS = 12
/** And the band where "stuck" stops being a fair description. A day of this is
 *  not a case waiting, it is a case the engine cannot handle. */
const STAGNATION_RUNS_SEVERE = 72

/** Statuses in which the case is the ENGINE's move. A case in
 *  WAITING_EXTERNAL, AWAITING_SELECTION, SCHEDULED or BLOCKED is waiting on
 *  somebody or something else, and its counter climbing is the system working:
 *  the engine woke, saw it was not its turn, and left it alone.
 *
 *  Getting this wrong is not a detail. The unfiltered version of this check
 *  reported 22 live cases, 18 of which were correctly waiting on a supplier's
 *  reply or on Istvan. An alarm that fires on correct behaviour is how alarms
 *  get ignored — and this one would have buried the single case that is
 *  genuinely stuck under eighteen that are not. */
const ENGINE_ACTIONABLE = ['NEW', 'READY', 'EXECUTING', 'FOLLOW_UP_DUE', 'INFORMATION_REQUIRED', 'INFO_REQUIRED', 'RECOVERY_REQUIRED']

const stagnantCases: Check = (db) => {
  let rows: Array<{ domain: string; case_id: string; n: number; status: string }> = []
  const marks = ENGINE_ACTIONABLE.map(() => '?').join(',')
  try {
    // Only cases the engine is actually still polling. A frozen or closed case
    // with a high counter is a historical fact, not a live complaint, and
    // reporting it would keep the alarm ringing after the cause was handled.
    rows = db.prepare(
      `SELECT s.domain AS domain, s.case_id AS case_id, s.no_progress_run_count AS n,
              COALESCE(p.status, z.status) AS status
       FROM case_progression_state s
       LEFT JOIN personal_cases p ON p.case_id = s.case_id AND s.domain = 'personal'
       LEFT JOIN zst_cases      z ON z.case_id = s.case_id AND s.domain = 'zst'
       WHERE s.progression_enabled = 1 AND s.no_progress_run_count >= ?
         AND COALESCE(p.status, z.status) IN (${marks})
       ORDER BY s.no_progress_run_count DESC`,
    ).all(STAGNATION_RUNS, ...ENGINE_ACTIONABLE) as never
  } catch { return null }
  if (!rows.length) return null

  const severe = rows.filter(r => r.n >= STAGNATION_RUNS_SEVERE)
  const worst = rows[0]
  return {
    id: 'cases_making_no_progress',
    severity: severe.length ? 'CRITICAL' : 'WARNING',
    ref: '§19, kártya 8eb5a1e9',
    title: 'Ügyek, amiken a motoron van a sor, és mégsem halad',
    detail: `${rows.length} ügy legalább ${STAGNATION_RUNS} eredménytelen futással`
      + (severe.length ? `, ebből ${severe.length} legalább ${STAGNATION_RUNS_SEVERE}` : '')
      + `; a legrosszabb ${worst.domain}/${worst.case_id} (${worst.status}, ${worst.n})`,
    action: 'Ezek nem külső válaszra várnak: a státuszuk szerint a motoron van a sor, és mégsem mozdulnak. '
      + 'Nézd meg a legrosszabbat: vagy rossz státuszban áll, vagy a terv nem hajtható végre magától. '
      + 'A számláló nem oldja meg magától, a motor pedig szándékosan nem zárja le őket.',
  }
}

/** Cases waiting on ISTVAN, for a long time. The mirror of the check above and
 *  deliberately a separate finding: the engine is behaving correctly here, and
 *  mixing the two would let a real engine failure hide inside a list of
 *  questions nobody answered.
 *
 *  Found by measurement, 2026-08-10: four cases sat in AWAITING_SELECTION with
 *  96 consecutive engine wake-ups behind them. Sixteen hours of asking a
 *  question into a room with nobody in it. */
const OWNER_DECISION_RUNS = 48

const awaitingOwnerTooLong: Check = (db) => {
  let rows: Array<{ case_id: string; n: number; title: string }> = []
  try {
    rows = db.prepare(
      `SELECT s.case_id AS case_id, s.no_progress_run_count AS n, p.title AS title
       FROM case_progression_state s
       JOIN personal_cases p ON p.case_id = s.case_id AND s.domain = 'personal'
       WHERE s.progression_enabled = 1
         AND p.status = 'AWAITING_SELECTION'
         AND s.no_progress_run_count >= ?
       ORDER BY s.no_progress_run_count DESC`,
    ).all(OWNER_DECISION_RUNS) as never
  } catch { return null }
  if (!rows.length) return null
  return {
    id: 'awaiting_owner_decision_too_long', severity: 'WARNING', ref: '§19, kártya 8eb5a1e9',
    title: 'Döntésre váró ügyek, amiket Istvan nem látott',
    detail: `${rows.length} ügy: ${rows.slice(0, 4).map(r => r.title.slice(0, 30)).join(' · ')}`,
    action: 'A motor feltette a kérdést és azóta is várja a választ. Ha ennyi ideig áll, '
      + 'a kérdés nem jutott el Istvanhoz — a kérdést kell kézbesíteni, nem az ügyet nógatni.',
  }
}

export const CHECKS: Check[] = [
  stuckLocalApplied, openBatches, missingCheckpoint,
  outboundNeedsHuman, outcomeUnknown, stuckSending, failedRetryableStranded,
  connectorDown, staleClaims, corporateInPersonal, outputFloorBreaches,
  // §19 further minimum + critical alerts
  duplicateSendAttempt, failedReadback, stalledCampaign, expiredApproval,
  repeatedFollowUp, radarCheckFailing, cursorBatchMismatch, sourceWritePolicyActive,
  // corporate surface (2026-08-10)
  zstFrozenCases, zstStuckSending, zstStaleClaims, zstMessagesWithoutThread,
  // stagnation, both domains (2026-08-10)
  stagnantCases, awaitingOwnerTooLong,
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
