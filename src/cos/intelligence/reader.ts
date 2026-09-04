// PHASE 3 (P3-A) -- THE PROJECTION GETS A READER.
//
// Owner ruling 2026-09-01: "A Phase 2 projekcio kapjon menetrend szerinti
// olvasot. A commitments / decisions / attention / questions / opportunities
// reteg ne csak kezi futaskor legyen igaz, hanem tenylegesen szolgalja a CoS
// mukodeset."
//
// WHAT WAS ACTUALLY WRONG. Phase 2 built five surfaces, proved them, and shipped
// them with zero scheduled callers: `projectIntelligence` was reachable only
// from probe scripts run by hand. That was correct for a shadow phase and it had
// one concrete cost -- on 2026-09-01 a manual run surfaced a NAV "elfogado
// nyugta" with ten days left before the Tarhely deletes it, and nothing would
// have raised it again the next morning. A surface nobody reads is a surface
// that is true and useless.
//
// THE TWO REQUIREMENTS THAT LOOK COMPATIBLE AND ARE NOT.
//
//   "ne termeljen notification stormot"
//   "a NAV/Cegkapu tipusu P0/P1 attentionnek automatikusan ujra felszinre kell
//    kerulnie, amig valodi resolution evidence nincs"
//
// Silence-until-changed satisfies the first and loses the NAV document. Speak-
// every-cycle satisfies the second and is the storm. Both hold only if the
// reader knows WHAT IT ALREADY SAID -- which is why this module has a durable
// ledger, and why that ledger is delivery bookkeeping and not a second
// intelligence state:
//
//   - it stores an utterance (element id, band, sentence fingerprint, when),
//     never a case's content, status or verdict;
//   - every figure spoken is recomputed from the canonical store on the run
//     that speaks it;
//   - deleting the whole table makes the reader repeat itself once. It cannot
//     make it wrong.
//
// A RECOMMENDATION IS STILL NOT AN AUTHORIZATION. This module reads a projection
// and writes sentences. It changes no case status, opens no question, approves
// nothing, and sends nothing outward on its own; the digest lands on the bus and
// in the daily log, which are the same two places the radar and PLANNED digests
// already use.
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { createAgentMessage, appendDailyLog } from '../../db.js'
import { APP_TZ } from '../../config.js'
import { projectIntelligence } from './project.js'
import { applyResearchEnrichment, markChangedSurface, type EnrichmentTrace } from '../research/result-reader.js'
import type { AttentionBand, AttentionItem, InterruptionPolicy, SurfacedRecord } from './attention.js'

export const ATTENTION_DIGEST_HEADER = '## COS figyelem'

/**
 * The reader's policy, and every number in it is an answer to one of the
 * owner's two requirements rather than a taste.
 *
 * SAFETY comes back twice a day for as long as the evidence that raised it is
 * still there. That is the NAV rule: an authority notice stops being
 * AUTHORITATIVE_NOTICE_UNREAD the moment a document is attached to the case, so
 * "until real resolution evidence exists" is enforced by the derivation, and
 * this timer only decides how often it says so in the meantime.
 *
 * INFORMATIONAL and OPPORTUNITY have NO timer. They speak when they change and
 * are otherwise silent for ever -- an item that is merely worth knowing has not
 * earned the right to interrupt twice for the same reason.
 */
export const READER_POLICY: InterruptionPolicy = {
  maxInterruptions: 3,
  quietSeconds: 24 * 3600,
  bandQuietSeconds: {
    SAFETY: 12 * 3600,
    OBLIGATION: 24 * 3600,
    BLOCKING: 24 * 3600,
    INFORMATIONAL: Number.POSITIVE_INFINITY,
    OPPORTUNITY: Number.POSITIVE_INFINITY,
  },
}

/**
 * THE CADENCE FLOOR, and the storm it stops.
 *
 * FOUND IN PRODUCTION, on the second live cycle after the cutover, which is the
 * only place it could have been found. The per-item rules were right and the
 * aggregate was not: once the top three items had spoken they went quiet for
 * twelve hours, so the NEXT three -- never surfaced, therefore "new" -- spoke on
 * the following cycle. With 130 quiet items and a cycle every ten minutes, the
 * reader would have worked through the entire backlog three items at a time.
 * Every individual decision was correct and the sum of them was the notification
 * storm the owner forbade by name.
 *
 * The rule: a namespace may open its mouth once an hour. Two exemptions, and
 * both are the point of the feature rather than softenings of it --
 *
 *   SAFETY is never held back. An unread authority notice does not wait for a
 *   cadence window; if it is the strongest thing in the namespace it speaks.
 *
 *   A CHANGE is never held back. "Csak valtozas vagy valoban releváns attention
 *   eseten jelezzen" -- a case whose sentence or band moved is the change, and
 *   silencing it to keep a rhythm would invert the requirement.
 *
 * What the floor actually suppresses is the third thing: a first-time item that
 * is neither urgent nor changed, i.e. the backlog arriving in instalments. That
 * belongs on the board (P3-C), which is exactly where it now is.
 */
export const MIN_DIGEST_INTERVAL_SECONDS = 3600

/**
 * QUIET HOURS, and the one way they could do harm.
 *
 * Owner ruling 2026-09-04, verbatim: "22:00-07:00 kozott NE kuldj user-facing
 * digestet. Az ejszakai teteleket gyujtsd, es 7 utan egy csomagban surface-eld."
 * It came from a measured night: between 03:10 and 06:20 this reader spoke eight
 * times and raised 21 items, every one of them correct, none of them urgent, and
 * all of them into a channel whose owner was asleep. The cadence floor bounded
 * the RATE and had nothing to say about the HOUR.
 *
 * The danger of the feature is not that it holds too much. It is that a rule
 * written to stop backlog noise also gags a genuine emergency, and does so
 * invisibly -- the digest simply says nothing, exactly as it does on a quiet
 * night. So the exemptions are enumerated, and what CANNOT be detected is
 * enumerated with them rather than left as an implied capability.
 *
 * WHAT BREAKS QUIET HOURS:
 *
 *   A STATED DEADLINE FALLING WITHIN THE NEXT 24 HOURS. `dueAt` is the date the
 *   record carries, not an inference. A deadline that has ALREADY passed does
 *   not break quiet hours: waking the owner at 03:00 cannot un-pass it, and it
 *   will lead the morning package instead.
 *
 *   SAFETY. AUTHORITATIVE_NOTICE_UNREAD is the class the owner previously
 *   designated HIGH/P0 by name, and the cadence floor already exempts it. Muting
 *   it here would be this module quietly widening a rule the owner wrote to
 *   silence a backlog, into one that also silences an authority notice.
 *
 * WHAT THIS LAYER CANNOT DETECT, stated so it is not mistaken for covered: the
 * owner also named "security incident" and "production/system failure with
 * immediate harm" as P0. Neither has any signal in the intelligence projection
 * today -- there is no field, on any element, that asserts either. They
 * therefore cannot break quiet hours FROM HERE, and a surface that can assert
 * them must carry its own path to the owner. An exemption that cannot fire is
 * worse than a declared absence, because everyone downstream believes it is on.
 *
 * WAITING_EXTERNAL never breaks quiet hours -- owner, same ruling. An item does
 * not become urgent because nobody replied to it.
 */
export const QUIET_HOURS_START = 22
export const QUIET_HOURS_END = 7
export const P0_DEADLINE_HORIZON_SECONDS = 24 * 3600

/** Hour-of-day in the app timezone. Uses the SAME `APP_TZ` the digest already
 *  stamps its day with, so the quiet window and the daily-log date can never
 *  disagree about which day it is. */
export function hourInAppTz(now: number): number {
  return clockInAppTz(now).hour
}

/** Hour, minute and second in the app timezone, from one formatter call so the
 *  three cannot straddle a tick and disagree. */
export function clockInAppTz(now: number): { hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(now * 1000))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0')
  // 24 is a legal rendering of midnight in en-GB h23/h24 handling; normalise it,
  // because an hour of 24 would read as "not quiet" at exactly 00:00:00.
  return { hour: get('hour') % 24, minute: get('minute'), second: get('second') }
}

/** The window wraps midnight, so this is an OR and not a range test. */
export function isWithinQuietHours(now: number): boolean {
  const h = hourInAppTz(now)
  return h >= QUIET_HOURS_START || h < QUIET_HOURS_END
}

/** The next moment the window opens, from `now`. */
export function quietHoursEndAt(now: number): number {
  const { hour, minute, second } = clockInAppTz(now)
  const secondsIntoDay = hour * 3600 + minute * 60 + second
  const endSeconds = QUIET_HOURS_END * 3600
  const delta = secondsIntoDay < endSeconds
    ? endSeconds - secondsIntoDay
    : (24 * 3600 - secondsIntoDay) + endSeconds
  return now + delta
}

/** Which limb of the owner's rule fired. Named, because "it broke through" is
 *  not a reason and cannot be argued with at three in the morning. */
export type BreakLimb = 'OPPORTUNITY_LOST' | 'OWNER_ACTION_BLOCKED' | 'HARM_GROWS'

export interface QuietHoursDecision {
  breaks: boolean
  limb: BreakLimb | null
  /** One sentence, for the message and for the audit. */
  reason: string
}

/**
 * MAY THIS WAKE HIM.
 *
 * Owner ruling, 2026-09-04, and it replaced a rule that asked the wrong
 * question entirely: *"Ne kategória önmagában döntsön az éjszakai interruptról."*
 *
 *     QUIET_HOURS_BREAK = waiting until morning materially increases the harm,
 *     loses an opportunity, or blocks a time-critical owner action.
 *
 * The previous version returned true for every SAFETY item and for any deadline
 * inside a fixed horizon. Both are category tests wearing a threshold: a
 * security notice nobody can act on before Monday woke him at 03:00, and a
 * deadline twenty hours out did too, while a deadline expiring at 05:00 that he
 * genuinely could have met was treated identically.
 *
 * THE FIRST GATE IS CAPABILITY, NOT SEVERITY. If the owner is not the one who
 * can act, nothing here is urgent enough to wake him, whatever its band: waking
 * someone to watch a clock they cannot move is the definition of a pointless
 * interrupt. That single check removes most false wake-ups, and it removes them
 * for a reason that survives being questioned.
 *
 * HARM_GROWS must be DECLARED, never inferred. There is no field from which
 * "the damage is still accruing" can be read honestly, and inventing one from
 * staleness would make every old item an emergency by four in the morning. So
 * absence means no, and an already-passed deadline stays quiet by default --
 * exactly the owner's words: *"Ha már tegnap lejárt és 03:00-kor nincs érdemi
 * teendő, várjon reggelig."*
 */
export function quietHoursDecision(
  item: AttentionItem, now: number, windowEndsAt = quietHoursEndAt(now),
): QuietHoursDecision {
  const el = item.element as {
    dueAt?: number | null
    owner?: string
    /** Declared by the producer: the harm is still accruing AND a step tonight
     *  changes the outcome. Never derived here. */
    harmGrowsOvernight?: boolean
  }

  // GATE 1 -- can he do anything about it?
  //
  // It fires on a POSITIVE statement that somebody else owns the next step, not
  // on the absence of one. UNKNOWN means nobody recorded an owner, and reading
  // that as "not his" would be treating missing evidence as evidence -- which,
  // measured on the live shape, silenced the one item that could actually lose
  // something overnight: a commitment due in two hours whose owner column was
  // never filled in.
  if (el.owner === 'ENGINE' || el.owner === 'EXTERNAL') {
    return {
      breaks: false, limb: null,
      reason: `the next step belongs to ${el.owner.toLowerCase()}, not to him; waking him moves nothing`,
    }
  }

  const dueAt = typeof el.dueAt === 'number' ? el.dueAt : null

  // OPPORTUNITY_LOST -- the window shuts before the quiet hours do.
  if (dueAt !== null && dueAt >= now && dueAt <= windowEndsAt) {
    return {
      breaks: true, limb: 'OPPORTUNITY_LOST',
      reason: 'the deadline falls before the quiet window ends, so waiting for morning misses it',
    }
  }

  // HARM_GROWS -- declared, and only meaningful while it is still growing.
  if (el.harmGrowsOvernight === true) {
    return {
      breaks: true, limb: 'HARM_GROWS',
      reason: 'the producer declared that the damage keeps accruing and a step tonight changes it',
    }
  }

  // Everything else waits, and the reason says which case it is.
  if (dueAt !== null && dueAt < now) {
    return {
      breaks: false, limb: null,
      reason: 'the deadline has already passed and nothing was declared to be still accruing; '
        + 'waking him cannot un-miss it',
    }
  }
  return {
    breaks: false, limb: null,
    reason: dueAt === null
      ? 'no deadline, and nothing declared as accruing overnight'
      : 'the deadline is beyond the quiet window; the morning package reaches him in time',
  }
}

/** The predicate the reader uses. Kept as a thin wrapper so callers that only
 *  need yes/no do not have to carry the reason, and so the reason exists for
 *  the ones that do. */
export function breaksQuietHours(item: AttentionItem, now: number): boolean {
  return quietHoursDecision(item, now).breaks
}

/**
 * THE MORNING PACKAGE, and why the cap has to move for it.
 *
 * "Az ejszakai teteleket gyujtsd, es 7 utan EGY CSOMAGBAN surface-eld." With the
 * cap left at three, the night's backlog would come out three an hour from 07:00
 * -- the same instalment drip the owner objected to, merely starting later. So
 * the first utterance of the day after the window closes is allowed a wider cap.
 *
 * It is a CAP and not an unbounded release: after a long outage the held set can
 * be arbitrarily large, and a hundred-line message is another way of saying
 * nothing. The rest stays on the board, which is where a backlog belongs.
 */
export const MORNING_RELEASE_MAX_INTERRUPTIONS = 12

/** The first run of the day after quiet hours ended: nothing has spoken in this
 *  namespace since the window closed. Derived from the ledger, so a restart does
 *  not hand out a second morning package. */
export function isMorningRelease(now: number, lastSpokeAt: number): boolean {
  if (isWithinQuietHours(now)) return false
  // A namespace that has NEVER spoken has no night to have been held through.
  // Without this, an empty ledger looks like "silent since the window closed"
  // and the very first digest a fresh install ever sends would arrive under the
  // wide cap -- a twelve-item wall as an opening line, from a rule that exists
  // to release a backlog that was actually withheld.
  if (lastSpokeAt <= 0) return false
  const { hour, minute, second } = clockInAppTz(now)
  // Outside quiet hours means QUIET_HOURS_END <= hour < QUIET_HOURS_START, so
  // this is always the number of seconds elapsed since 07:00 local TODAY.
  const sinceWindowClosed = (hour - QUIET_HOURS_END) * 3600 + minute * 60 + second
  return lastSpokeAt < now - sinceWindowClosed
}

export interface LedgerRow {
  element_id: string
  band: string
  fingerprint: string
  first_surfaced_at: number
  last_surfaced_at: number
  times_surfaced: number
  /** Which recipe produced `fingerprint`. Null on rows written before the
   *  column existed -- an unknown recipe, which is not a comparable one. */
  fingerprint_algo: string | null
}

export interface MaterialEscalation {
  escalated: boolean
  /** What changed since the previous delivery, in words, or null. Required by
   *  the owner: a bypass whose reason cannot be read afterwards is a bypass
   *  nobody can audit. */
  what: string | null
}

const BAND_SEVERITY: Record<string, number> = {
  SAFETY: 0, OBLIGATION: 1, BLOCKING: 2, INFORMATIONAL: 3, OPPORTUNITY: 4,
}

/**
 * HAS ANYTHING MATERIAL HAPPENED SINCE WE LAST SPOKE?
 *
 * Owner ruling 2026-09-04, in two halves that pull against each other:
 * *"suppressed != ineligible, de urgent != automatikusan redeliver."* Being held
 * by anti-spam must never mean an item is not looked at again; being urgent must
 * never mean it repeats while nothing about it moves.
 *
 * WHERE THE ANSWER COMES FROM, and this was rewritten once. The first version
 * stored the prior deadline, owner and statement in the delivery ledger. The
 * projection guard rejected it, correctly: that ledger is exempt from the
 * no-second-truth rule only because it holds UTTERANCE facts, and a case fact
 * kept beside them is exactly the second truth the exemption was granted
 * against. So nothing about the case is shadowed here. The question is answered
 * from the case's OWN event log, plus the two utterance facts already stored.
 *
 * MERE TIME IS NOT ESCALATION. Ageing writes no events, so it cannot produce
 * one. The single place time legitimately does is the actionable window, which
 * the owner named explicitly -- and it is a CROSSING, computed from the deadline
 * and the moment we last spoke, so it fires once rather than for ever after.
 *
 * KNOWN LIMIT, stated rather than papered over: a case event records THAT the
 * case changed and why, not a field-level diff -- `payload` is null for status
 * transitions. So an edit that makes a case LESS urgent (a deadline pushed
 * further out) also reads as a material change and buys one redelivery. It is
 * bounded at one per real case change and can never fire on ageing, which is
 * the failure the ruling was aimed at.
 */
export function materialEscalation(
  db: Database.Database, namespace: string, item: AttentionItem,
  prev: LedgerRow | undefined, now: number,
): MaterialEscalation {
  if (!prev) return { escalated: false, what: null }
  const reasons: string[] = []

  // 1. THE CROSSING. Pure function of the deadline and the two moments; the
  //    previous side of it needs no storage because it can be recomputed.
  const el = item.element as { dueAt?: number | null }
  const dueAt = typeof el.dueAt === 'number' ? el.dueAt : null
  if (dueAt !== null) {
    const inWindowNow = dueAt >= now && dueAt <= quietHoursEndAt(now)
    const then = prev.last_surfaced_at
    const inWindowThen = dueAt >= then && dueAt <= quietHoursEndAt(then)
    if (inWindowNow && !inWindowThen) {
      reasons.push('its deadline entered the window where acting is still possible')
    }
  }

  // 2. THE BAND ROSE. Both sides are utterance facts already in the ledger.
  if ((BAND_SEVERITY[item.band] ?? 9) < (BAND_SEVERITY[prev.band] ?? 9)) {
    reasons.push(`its band rose from ${prev.band} to ${item.band}`)
  }

  // 3. THE SENTENCE CHANGED while the band did not. The fingerprint hashes
  //    band + statement, so equal bands and different fingerprints isolate a
  //    changed statement exactly -- without the band sneaking in, which matters
  //    because a band FALLING is not an escalation.
  if (prev.band === item.band && identityChanged(prev, item)) {
    reasons.push('new evidence changed what it says')
  }

  // 4. THE CASE ITSELF MOVED. Read from its own log, which is the single truth,
  //    and the event's own reason becomes the readable justification the owner
  //    asked for.
  const table = namespace === 'zst' ? 'zst_case_events' : 'personal_case_events'
  //
  // THE CATCH IS NARROW ON PURPOSE. It was a bare `catch {}` for one revision,
  // and a mutation proved what that costs: deleting the `created_at` filter
  // left the statement bound with one parameter too many, better-sqlite3 threw,
  // the catch swallowed it, and the whole limb silently answered "nothing
  // escalated" while a test asserting exactly that stayed green. A missing
  // events table is a real condition on a fresh store; a malformed query is a
  // bug, and a bug that returns "no news" is the quietest kind there is.
  let ev: { event_type: string; reason: string | null } | undefined
  try {
    ev = db.prepare(
      `SELECT event_type, reason FROM ${table}
        WHERE case_id = ? AND created_at > ?
        ORDER BY created_at DESC LIMIT 1`,
    ).get(item.element.caseId, prev.last_surfaced_at) as typeof ev
  } catch (e) {
    if (!/no such table/i.test(e instanceof Error ? e.message : String(e))) throw e
    ev = undefined
  }
  if (ev) {
    reasons.push(`the case changed (${ev.event_type})`
      + (ev.reason ? `: ${ev.reason.slice(0, 120)}` : ''))
  }

  return reasons.length
    ? { escalated: true, what: reasons.join('; ') }
    : { escalated: false, what: null }
}

/** Which recipe `fingerprintOf` currently uses. Stored beside every digest.
 *
 *  Bump this whenever the INPUTS below change. Nothing else needs doing: a
 *  digest whose recipe is not this one is adopted rather than compared, so a
 *  bump migrates the ledger silently instead of announcing itself as news. */
export const FINGERPRINT_ALGO = 'v2-provenance'

/**
 * What the RECORDS say, reduced to a digest.
 *
 * The band alone is not enough and the reason is worth stating: `elementId` is
 * deliberately stable across evidence changes, so a case whose attention REASON
 * flips (say USER_ACTION_REQUIRED to EXPLICIT_DEADLINE_PASSED) keeps its id, and
 * if the band happens to be unchanged too, a band-only comparison sees nothing
 * and stays quiet through a genuine change. Something has to notice.
 *
 * IT USED TO BE THE SENTENCE, and that was the bug. Hashing the rendered
 * sentence makes the digest an artefact of how we PHRASE things, so every
 * change of phrasing reads as a change in the world. Two separate incidents
 * came from that single choice: `open and untouched for N days` moved the
 * digest at every midnight, and then the fix for it -- re-wording to an
 * absolute date -- invalidated all 163 stored digests at once and would have
 * reported ninety-six unchanged cases as changed, three per run, for a month.
 *
 * Owner's rule, 2026-09-04: "CHANGE / IDENTITY: csak stabil, absolute facts.
 * URGENCY / RANKING: olvashatja az aktuális időt." So the digest is taken over
 * the stable facts this element rests on -- which rows, and when each of those
 * rows said what it said. Provenance is exactly that and it is already required
 * on every element, so there is nothing new to maintain.
 *
 * What this still notices, which is the whole job: a new row, a row that moved,
 * a changed set of rows -- any of which IS new evidence. What it no longer
 * notices is us choosing different words for the same facts, or a clock ticking
 * past midnight. Neither of those is news.
 */
export function fingerprintOf(item: AttentionItem): string {
  // Sorted so that provenance ARRIVING in a different order is not a change;
  // the set and its timestamps are the fact, the array order is incidental.
  // `?? []` because a crash here would take down the whole cycle. Provenance is
  // required on every element by construction, so an element without it is a bug
  // somewhere upstream -- but the reader's job is to say what it can see, and an
  // element with no traceable evidence is honestly identified by its case and
  // band alone rather than by an exception.
  const evidence = (item.element.provenance ?? [])
    .map((p) => `${p.source}:${p.ref}@${p.observedAt}`)
    .sort()
    .join('|')
  // `changeKey` first: when a producer has named its semantic facts, those are
  // the identity and provenance merely corroborates it.
  return createHash('sha256')
    .update(`${item.band} ${item.element.kind} ${item.element.caseId} `
          + `${item.element.changeKey ?? ''} ${evidence}`)
    .digest('hex')
    .slice(0, 16)
}

/**
 * Did the EVIDENCE move since we last spoke about this?
 *
 * The single place that answers it, because there were three and they have to
 * agree: a promotion path that thinks something changed and a delivery path
 * that thinks it did not produce an item that speaks with no reason to.
 *
 * A digest written under a different recipe is NOT COMPARABLE, and answering
 * "changed" for it would be inventing an observation we never made. Those rows
 * are adopted by `adoptStaleFingerprints` before anything reads them; this
 * guard is here for the ones that slip past -- a row written between the
 * adoption pass and the comparison, or a caller that skipped the pass.
 */
export function identityChanged(prev: LedgerRow, item: AttentionItem): boolean {
  if (prev.fingerprint_algo !== FINGERPRINT_ALGO) return false
  return prev.fingerprint !== fingerprintOf(item)
}

/**
 * Bring ledger rows written under an older recipe up to the current one.
 *
 * WITHOUT SPEAKING, and without touching a single clock: `last_surfaced_at` and
 * `times_surfaced` are utterance facts, and no utterance happened here. Only
 * the digest and its recipe change, so the row still records truthfully when we
 * last spoke and how often.
 *
 * It runs over every EVALUATED item rather than every spoken one, and that is
 * the point. Adopting only what speaks would leave a quiet case carrying an
 * incomparable digest for ever, and `identityChanged` answers false for those --
 * so a case that never speaks could never be promoted BY a change again. That
 * failure is silent, which makes it worse than the noise this fixes.
 */
export function adoptStaleFingerprints(
  db: Database.Database, namespace: string,
  ledger: Map<string, LedgerRow>, items: readonly AttentionItem[],
): number {
  const stale = items.filter((it) => {
    const prev = ledger.get(it.element.id)
    return prev !== undefined && prev.fingerprint_algo !== FINGERPRINT_ALGO
  })
  if (stale.length === 0) return 0

  const stmt = db.prepare(
    `UPDATE intelligence_surfaced SET fingerprint = ?, fingerprint_algo = ?
      WHERE namespace = ? AND element_id = ?`,
  )
  db.transaction(() => {
    for (const it of stale) {
      const fp = fingerprintOf(it)
      stmt.run(fp, FINGERPRINT_ALGO, namespace, it.element.id)
      // Keep the in-memory ledger honest too, so comparisons later in THIS run
      // read the adopted value rather than the one we just replaced.
      const prev = ledger.get(it.element.id)!
      ledger.set(it.element.id, { ...prev, fingerprint: fp, fingerprint_algo: FINGERPRINT_ALGO })
    }
  })()
  return stale.length
}

export function loadLedger(db: Database.Database, namespace: string): Map<string, LedgerRow> {
  const rows = db.prepare(
    `SELECT element_id, band, fingerprint, first_surfaced_at, last_surfaced_at,
            times_surfaced, fingerprint_algo
       FROM intelligence_surfaced WHERE namespace = ?`,
  ).all(namespace) as LedgerRow[]
  return new Map(rows.map((r) => [r.element_id, r]))
}

export function ledgerToSeen(ledger: Map<string, LedgerRow>): SurfacedRecord[] {
  return [...ledger.values()].map((r) => ({
    id: r.element_id, band: r.band as AttentionBand, at: r.last_surfaced_at,
  }))
}

/** Upsert, AFTER the sentence has actually been delivered -- see `runProjectionReader`. */
export function recordSurfaced(
  db: Database.Database, namespace: string, items: readonly AttentionItem[], now: number,
): void {
  const stmt = db.prepare(
    `INSERT INTO intelligence_surfaced
       (namespace, element_id, band, fingerprint, first_surfaced_at, last_surfaced_at,
        times_surfaced, fingerprint_algo)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(namespace, element_id) DO UPDATE SET
       band = excluded.band,
       fingerprint = excluded.fingerprint,
       fingerprint_algo = excluded.fingerprint_algo,
       last_surfaced_at = excluded.last_surfaced_at,
       times_surfaced = intelligence_surfaced.times_surfaced + 1`,
  )
  const tx = db.transaction(() => {
    for (const it of items) {
      stmt.run(namespace, it.element.id, it.band, fingerprintOf(it), now, now, FINGERPRINT_ALGO)
    }
  })
  tx()
}

export interface SpokenItem {
  id: string
  caseId: string
  band: AttentionBand
  statement: string
  why: string
  /** Why it was allowed to speak now: the four are not interchangeable and the
   *  owner reads them differently. */
  trigger: 'NEW' | 'BAND_CHANGED' | 'CHANGED_WHILE_QUIET' | 'RESURFACED'
  timesSurfacedBefore: number
  /** P3-B2 enrichment, kept on its OWN line rather than folded into the
   *  statement. The statement is what our records say; this is what somebody
   *  else published. A reader must be able to see which is which without
   *  knowing the feature exists. */
  researchNote: string | null
}

export interface ReaderResult {
  namespace: 'personal' | 'zst'
  posted: boolean
  /** Ledger rows migrated to the current digest recipe on THIS run, silently.
   *  Auditable on purpose: this is the number that would otherwise have been
   *  reported as cases that changed, and a reader has to be able to see that
   *  the migration happened rather than infer it from a quiet digest. */
  adoptedFingerprints: number
  /** Items that spoke. Bounded by the policy's `maxInterruptions`. */
  spoke: SpokenItem[]
  /** Held back by the anti-spam rule and NOT promoted: nothing about them changed. */
  stillQuiet: number
  /** Suppressed by band+timer, but their sentence had changed, so they spoke. */
  promotedByChange: number
  /** Ranked, available, not spoken. */
  quiet: number
  /** Held by the once-an-hour cadence floor: first-time, unchanged, non-SAFETY
   *  items that would otherwise have delivered the backlog in instalments. */
  heldByCadence: number
  /** Held because the owner is asleep: items that were otherwise ready to speak,
   *  suppressed by the 22:00-07:00 window and DELIBERATELY NOT written to the
   *  ledger, so each keeps its utterance for the morning package. */
  heldByQuietHours: number
  /** Whether this run fell inside the quiet window at all. Separates "held
   *  nothing because nothing qualified" from "held nothing because the window
   *  was not open" -- a zero means two different things otherwise. */
  inQuietHours: boolean
  /** Whether this run was the first after the window closed, and therefore spoke
   *  under the wider morning cap rather than the hourly three. */
  morningRelease: boolean
  /** research result -> evidence -> projection item -> changed surface. Present
   *  whether or not anything was spoken, because a finding that reached a QUIET
   *  item still reached a surface. */
  researchTraces: EnrichmentTrace[]
  /** MUST be 0. Kept as a number rather than an assumption so a test can read it. */
  opportunityInSpoken: number
  /** Derivation contradictions -- a RUN FAULT. The cycle fails on these. */
  anomalies: number
  /** Standing record-integrity findings. Always reported, never a failure:
   *  they describe history we do not rewrite, so they never reach zero, and a
   *  permanently-red gate is worse than no gate. */
  integrityFindings: number
  /** Commitments the record says are discharged, withheld from attention. */
  dischargedWithheld: number
  text: string | null
}

export class OpportunityInterruptedError extends Error {}

/**
 * One namespace, one pass.
 *
 * The namespaces are run separately and never merged: connector identity is the
 * scope boundary, and a digest that listed both would be a cross-scope data path
 * created for the convenience of a message layout.
 */
export function runProjectionReader(
  db: Database.Database,
  namespace: 'personal' | 'zst',
  now = Math.floor(Date.now() / 1000),
  post?: (text: string) => void,
  policy: InterruptionPolicy = READER_POLICY,
  todayOverride?: string,
  /** A REHEARSAL WRITES NOTHING, and this flag exists because the obvious way to
   *  build one is wrong. Passing a no-op poster silences the message but still
   *  runs the ledger write below, which marks every item as told -- so a dry run
   *  would quietly consume the one utterance an unread NAV notice gets, and the
   *  real run afterwards would find nothing to say. Nothing would look broken.
   *  A dry run therefore skips the ledger, not the words. */
  dryRun = false,
): ReaderResult {
  const ledger = loadLedger(db, namespace)

  // `lastSpokeAt` is read BEFORE the projection because the morning release has
  // to widen the cap that `projectIntelligence` itself applies when it builds the
  // interrupt list. Computing it later, next to the cadence floor, would have
  // left the release capped at three by a decision already taken upstream.
  const lastSpokeAt = Math.max(0, ...[...ledger.values()].map((r) => r.last_surfaced_at))
  const inQuietHours = isWithinQuietHours(now)
  const morningRelease = isMorningRelease(now, lastSpokeAt)
  const effectivePolicy: InterruptionPolicy = morningRelease
    ? { ...policy, maxInterruptions: MORNING_RELEASE_MAX_INTERRUPTIONS }
    : policy

  const raw = projectIntelligence(db, namespace, now, ledgerToSeen(ledger), effectivePolicy)

  // P3-B2: the research ledger stops being a dead end. The enrichment is applied
  // to the PROJECTION, never to a case, and it is applied here rather than inside
  // `projectIntelligence` so the projection itself stays a pure function of the
  // canonical store -- research is an overlay a reader chooses to put on.
  const enriched = applyResearchEnrichment(db, namespace, raw)
  const p = enriched.projection
  const researchTraces = enriched.traces

  // BEFORE ANYTHING COMPARES A DIGEST, bring rows written under an older recipe
  // up to the current one. Over the WHOLE evaluated population -- every bucket,
  // not just what is about to speak -- because a row left on an old recipe can
  // never be found to have changed, and that silence would be invisible.
  //
  // A rehearsal still writes nothing: `identityChanged` refuses to compare an
  // unadopted row rather than calling it changed, so a dry run reads correctly
  // without this pass. It is the real run that has to converge.
  const adoptedFingerprints = dryRun ? 0 : adoptStaleFingerprints(db, namespace, ledger, [
    ...p.attention.interrupt, ...p.attention.quiet,
    ...p.attention.suppressed.map((sx) => sx.item),
  ])

  const decide = (item: AttentionItem, quietWhenSuppressed: boolean): SpokenItem => {
    const prev = ledger.get(item.element.id)
    const trigger: SpokenItem['trigger'] =
        !prev ? 'NEW'
      : quietWhenSuppressed ? 'CHANGED_WHILE_QUIET'
      : prev.band !== item.band ? 'BAND_CHANGED'
      : 'RESURFACED'
    const research = researchTraces.find((t) => t.elementId === item.element.id)
    return {
      id: item.element.id, caseId: item.element.caseId, band: item.band,
      statement: item.element.statement, why: item.why, trigger,
      timesSurfacedBefore: prev?.times_surfaced ?? 0,
      researchNote: research ? research.after.slice(research.before.length + 4) : null,
    }
  }

  // The cadence floor. `lastSpokeAt` (read above) is the most recent utterance in
  // THIS namespace; the two namespaces keep separate clocks, because a busy
  // company day must not silence a personal deadline.
  const withinCadence = lastSpokeAt > 0 && now - lastSpokeAt < MIN_DIGEST_INTERVAL_SECONDS

  // THE ELIGIBLE POPULATION, and it is not the shortlist.
  //
  // Owner invariant, 2026-09-04: *"Barmilyen cadence-bypass / quiet-hours-break
  // ertekeles a TELJES eligible populationbol induljon. Ne egy mar top-N-re
  // levagott nappali vagy ejszakai shortlistbol. A prioritasi shortlist csak
  // presentation/delivery reteg legyen, ne eligibility gate."*
  //
  // `p.attention.interrupt` is capped at three by the interruption policy. That
  // cap answers "how much may I say at once", which is a delivery question. It
  // was silently answering "what is allowed to be urgent" as well, and the two
  // are not the same: a genuinely time-critical item ranked fourth was
  // ineligible for a bypass it plainly deserved.
  //
  // NOT included: `p.attention.suppressed`, the anti-spam set whose band has not
  // changed inside its quiet window. That is a different mechanism from the
  // top-N cut the owner named, and folding it in would be me extending the
  // ruling again rather than applying it. Raised instead of assumed.
  // Owner extension, 2026-09-04: the suppressed set is IN. *"A suppression NEM
  // jelentheti azt, hogy egy tetelt nem vizsgalunk ujra."* Being held by
  // anti-spam is a delivery decision; it must not quietly become a decision
  // that the item is no longer allowed to be urgent.
  const suppressedItems = p.attention.suppressed.map((sx) => sx.item)
  const eligiblePopulation = [
    ...p.attention.interrupt, ...p.attention.quiet, ...suppressedItems,
  ]

  // THE BYPASS, one rule for the night and the day alike (owner, 2026-09-04):
  // *"Ugyanaz az alapelv mukodjon nappal is."* A SECURITY label no longer walks
  // past the cadence on its own; an active, worsening or owner-actionable
  // security incident still does, because that is what the harm test asks.
  const suppressedIds = new Set(suppressedItems.map((i) => i.element.id))
  const escalationReason = new Map<string, string>()
  const bypass = eligiblePopulation.filter((i) => {
    if (!quietHoursDecision(i, now).breaks) return false
    // ...and for an item the anti-spam layer is holding, urgency alone is not
    // enough. *"urgent != automatikusan redeliver."* Something must have moved
    // since we last spoke, and the reason is kept so the override can be read
    // back afterwards rather than merely trusted.
    if (!suppressedIds.has(i.element.id)) return true
    const esc = materialEscalation(db, namespace, i, ledger.get(i.element.id), now)
    if (esc.escalated && esc.what) escalationReason.set(i.element.id, esc.what)
    return esc.escalated
  })
  const bypassIds = new Set(bypass.map((i) => i.element.id))

  const changedSinceLastTime = (item: AttentionItem): boolean => {
    const prev = ledger.get(item.element.id)
    // A band change or a changed sentence IS the news; only a first-time,
    // unchanged, non-urgent item is held for the next window.
    return !!prev && (prev.band !== item.band || identityChanged(prev, item))
  }
  const mayPassCadence = (item: AttentionItem): boolean =>
    !withinCadence || bypassIds.has(item.element.id) || changedSinceLastTime(item)

  const heldByCadence = p.attention.interrupt.filter((i) => !mayPassCadence(i)).length
  // The shortlist supplies the ordinary delivery; the bypass adds anything the
  // harm test found anywhere in the population, shortlist or not.
  const eligible = [
    ...p.attention.interrupt.filter(mayPassCadence),
    ...bypass.filter((i) => !p.attention.interrupt.includes(i)),
  ]
  const speak: AttentionItem[] = [...eligible]
  const spoken: SpokenItem[] = eligible.map((i) => decide(i, false))

  // THE PROMOTION, and the failure it exists to stop.
  //
  // `selectAttention` suppresses on band + timer. An item whose SENTENCE changed
  // inside its quiet window is a genuine change wearing an unchanged band, and
  // the owner asked to hear about changes. So a suppressed item whose
  // fingerprint no longer matches the ledger is let through -- still under the
  // same cap, so this can add news but never volume.
  let promotedByChange = 0
  let stillQuiet = 0
  for (const s of p.attention.suppressed) {
    const prev = ledger.get(s.item.element.id)
    if (prev && identityChanged(prev, s.item) && speak.length < effectivePolicy.maxInterruptions
        && mayPassCadence(s.item)) {
      speak.push(s.item)
      spoken.push(decide(s.item, true))
      promotedByChange++
    } else {
      stillQuiet++
    }
  }

  // STRUCTURAL, not advisory. The owner's rule is that an opportunity may never
  // interrupt an obligation, safety or blocking decision; `selectAttention`
  // guarantees it by keeping separate lists, and the promotion above is the one
  // place new items enter afterwards. If this ever throws, the digest does not
  // go out -- a wrong interrupt list is worse than a missing one.
  const opportunityInSpoken = speak.filter((i) => i.band === 'OPPORTUNITY').length
  if (opportunityInSpoken > 0) {
    throw new OpportunityInterruptedError(
      `${opportunityInSpoken} opportunity item(s) reached the interrupt list for ${namespace}; ` +
      `an opportunity never interrupts`,
    )
  }

  // RECORDED FROM THE TRACES, not from a judgement: a research ticket is marked
  // as having changed something only because an element in this projection now
  // carries its provenance. That is what turns `changedSurface` from a claim
  // into an acceptance metric. Skipped on a dry run like every other write.
  if (!dryRun) markChangedSurface(db, researchTraces)

  // QUIET HOURS, applied LAST and to the final speaking set.
  //
  // Placed here on purpose. Filtering earlier would have hidden the held items
  // from the promotion and cadence bookkeeping above, so the counters would have
  // reported a quiet night rather than a suppressed one, and the difference
  // between "nothing qualified" and "the owner was asleep" would be unreadable
  // from the run result -- which is the only place anyone can check that this
  // feature is behaving.
  //
  // NOTHING IS RECORDED FOR A HELD ITEM. `recordSurfaced` below runs only over
  // what actually spoke, so a suppressed item keeps its utterance and leads the
  // morning package instead of having been silently marked as told. That is the
  // same trap the dry-run flag exists for, arriving through a second door.
  // THE NIGHT LOOKS AT THE WHOLE BOARD, not at the daytime shortlist.
  //
  // `speak` is what survived the interrupt cap and the cadence -- a ranking
  // built for ordinary hours. Filtering only that for exemptions made the
  // owner's rule decorative, and measurably so: in the live shape a commitment
  // due in two hours (urgency 0.99) sits in the QUIET set while three undated
  // stale cases hold the three interrupt slots. The one item that could lose an
  // opportunity before morning was the one item the night could not see.
  //
  // So at night the exemption is drawn from every item the projection produced.
  // Reaching him at 03:00 is a different question from earning a slot in the
  // daily three, and it deserves to be asked of the whole board.
  const nightPool = inQuietHours ? eligiblePopulation : speak
  const exempt = inQuietHours ? nightPool.filter((i) => breaksQuietHours(i, now)) : speak
  const heldByQuietHours = speak.filter((i) => !exempt.includes(i)).length
  const exemptIds = new Set(exempt.map((i) => i.element.id))
  // An exempt item that never made the daytime shortlist has no utterance yet,
  // so one is built for it here. Without this the wider night pool above would
  // widen nothing: the item would be exempt and still silent, which is the
  // quietest kind of bug -- a rule that passes its own unit tests and changes
  // no behaviour.
  const spokenById = new Map(spoken.map((sp) => [sp.id, sp]))
  const spokenNow = inQuietHours
    ? exempt.map((i) => spokenById.get(i.element.id) ?? decide(i, false))
    : spoken

  const base: ReaderResult = {
    namespace, posted: false, spoke: spokenNow, stillQuiet, promotedByChange, adoptedFingerprints,
    quiet: p.attention.quiet.length, heldByCadence, heldByQuietHours,
    inQuietHours, morningRelease, researchTraces, opportunityInSpoken: 0,
    anomalies: p.anomalies.length, integrityFindings: p.integrityFindings.length,
    dischargedWithheld: p.dischargedWithheld, text: null,
  }
  if (!exempt.length) return base

  const text = buildDigestText(namespace, spokenNow)
  const day = todayOverride ?? new Date().toLocaleDateString('en-CA', { timeZone: APP_TZ })
  const doPost = post ?? ((t: string) => {
    createAgentMessage('cos-attention', 'marveen', t, 'cos-attention-digest')
    appendDailyLog('marveen', t, day)
  })

  // POST FIRST, RECORD AFTER. A crash between the two costs one repeated line;
  // the other order costs the only sentence an unread NAV notice ever gets, and
  // marks it as told. Same ordering, same reason, as the radar digest.
  if (dryRun) return { ...base, posted: false, text }
  doPost(text)
  recordSurfaced(db, namespace, exempt, now)
  return { ...base, posted: true, text }
}

const BAND_LABEL: Record<AttentionBand, string> = {
  SAFETY: 'BIZTONSAG', OBLIGATION: 'IGERET', BLOCKING: 'DONTES',
  INFORMATIONAL: 'INFO', OPPORTUNITY: 'LEHETOSEG',
}

const TRIGGER_LABEL: Record<SpokenItem['trigger'], string> = {
  NEW: 'uj',
  BAND_CHANGED: 'savot valtott',
  CHANGED_WHILE_QUIET: 'valtozott',
  RESURFACED: 'meg mindig nyitva',
}

/** Deterministic: the same items in the same order always produce the same text,
 *  so "did anything change" is a string comparison and not a judgement. */
export function buildDigestText(namespace: string, spoken: readonly SpokenItem[]): string {
  const scope = namespace === 'zst' ? 'ZST' : 'szemelyes'
  const lines = spoken.map((s) => {
    const times = s.trigger === 'RESURFACED' && s.timesSurfacedBefore > 0
      ? ` (${s.timesSurfacedBefore + 1}. alkalom)` : ''
    const line = `- [${BAND_LABEL[s.band]}] ${s.statement} -- ${TRIGGER_LABEL[s.trigger]}${times} [${s.caseId}]`
    // The web-sourced sentence gets its own indented line, so nobody reads a
    // published page as if it were one of our own records.
    return s.researchNote ? `${line}\n    ${s.researchNote}` : line
  })
  return `${ATTENTION_DIGEST_HEADER} (${scope}): ${spoken.length} tetel\n${lines.join('\n')}`
}
