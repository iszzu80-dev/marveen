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

/** True only for the two exemptions above. Everything else waits for 07:00. */
export function breaksQuietHours(item: AttentionItem, now: number): boolean {
  if (item.band === 'SAFETY') return true
  const dueAt = (item.element as { dueAt?: number | null }).dueAt
  if (typeof dueAt !== 'number') return false
  return dueAt >= now && dueAt - now <= P0_DEADLINE_HORIZON_SECONDS
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
}

/**
 * What was said, reduced to a digest.
 *
 * The band alone is not enough and the reason is worth stating: `elementId` is
 * deliberately stable across evidence changes, so a case whose attention REASON
 * flips (say USER_ACTION_REQUIRED to EXPLICIT_DEADLINE_PASSED) keeps its id, and
 * if the band happens to be unchanged too, a band-only comparison sees nothing
 * and stays quiet through a genuine change. The statement carries the reason, so
 * hashing the statement notices.
 */
export function fingerprintOf(item: AttentionItem): string {
  return createHash('sha256')
    .update(`${item.band} ${item.element.statement}`)
    .digest('hex')
    .slice(0, 16)
}

export function loadLedger(db: Database.Database, namespace: string): Map<string, LedgerRow> {
  const rows = db.prepare(
    `SELECT element_id, band, fingerprint, first_surfaced_at, last_surfaced_at, times_surfaced
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
       (namespace, element_id, band, fingerprint, first_surfaced_at, last_surfaced_at, times_surfaced)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(namespace, element_id) DO UPDATE SET
       band = excluded.band,
       fingerprint = excluded.fingerprint,
       last_surfaced_at = excluded.last_surfaced_at,
       times_surfaced = intelligence_surfaced.times_surfaced + 1`,
  )
  const tx = db.transaction(() => {
    for (const it of items) stmt.run(namespace, it.element.id, it.band, fingerprintOf(it), now, now)
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

  const mayPassCadence = (item: AttentionItem): boolean => {
    if (!withinCadence) return true
    if (item.band === 'SAFETY') return true
    const prev = ledger.get(item.element.id)
    // A band change or a changed sentence IS the news; only a first-time,
    // unchanged, non-urgent item is held for the next window.
    return !!prev && (prev.band !== item.band || prev.fingerprint !== fingerprintOf(item))
  }

  const eligible = p.attention.interrupt.filter(mayPassCadence)
  const heldByCadence = p.attention.interrupt.length - eligible.length
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
    if (prev && prev.fingerprint !== fingerprintOf(s.item) && speak.length < effectivePolicy.maxInterruptions
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
  const exempt = inQuietHours ? speak.filter((i) => breaksQuietHours(i, now)) : speak
  const heldByQuietHours = speak.length - exempt.length
  const exemptIds = new Set(exempt.map((i) => i.element.id))
  const spokenNow = inQuietHours ? spoken.filter((sp) => exemptIds.has(sp.id)) : spoken

  const base: ReaderResult = {
    namespace, posted: false, spoke: spokenNow, stillQuiet, promotedByChange,
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
