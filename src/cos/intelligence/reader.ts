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
  /** MUST be 0. Kept as a number rather than an assumption so a test can read it. */
  opportunityInSpoken: number
  anomalies: number
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
  const p = projectIntelligence(db, namespace, now, ledgerToSeen(ledger), policy)

  const decide = (item: AttentionItem, quietWhenSuppressed: boolean): SpokenItem => {
    const prev = ledger.get(item.element.id)
    const trigger: SpokenItem['trigger'] =
        !prev ? 'NEW'
      : quietWhenSuppressed ? 'CHANGED_WHILE_QUIET'
      : prev.band !== item.band ? 'BAND_CHANGED'
      : 'RESURFACED'
    return {
      id: item.element.id, caseId: item.element.caseId, band: item.band,
      statement: item.element.statement, why: item.why, trigger,
      timesSurfacedBefore: prev?.times_surfaced ?? 0,
    }
  }

  const speak: AttentionItem[] = [...p.attention.interrupt]
  const spoken: SpokenItem[] = p.attention.interrupt.map((i) => decide(i, false))

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
    if (prev && prev.fingerprint !== fingerprintOf(s.item) && speak.length < policy.maxInterruptions) {
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

  const base: ReaderResult = {
    namespace, posted: false, spoke: spoken, stillQuiet, promotedByChange,
    quiet: p.attention.quiet.length, opportunityInSpoken: 0,
    anomalies: p.anomalies.length, text: null,
  }
  if (!speak.length) return base

  const text = buildDigestText(namespace, spoken)
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
  recordSurfaced(db, namespace, speak, now)
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
    return `- [${BAND_LABEL[s.band]}] ${s.statement} -- ${TRIGGER_LABEL[s.trigger]}${times} [${s.caseId}]`
  })
  return `${ATTENTION_DIGEST_HEADER} (${scope}): ${spoken.length} tetel\n${lines.join('\n')}`
}
