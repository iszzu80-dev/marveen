// Personal Chief of Staff (COS) — email → case intake (inbound behavior).
//
// Turns a DISCOVERED email (from openBatch) into a case, composing the pieces
// built in this slice set: the email_processing state machine, the case store,
// and the sensitivity policy. This is where a message becomes work:
//   - not actionable → EXCLUDED (noise; the batch can still terminalize).
//   - actionable, new thread → CLAIMED → a new case is created (its sensitivity
//     is the ESCALATED tier of the declared value vs the actual content) →
//     LOCAL_APPLIED with the case_id. (The SOURCE_COMMITTED / Gmail-label step
//     is the source side, done once the connector confirms — separate.)
//   - actionable, thread already has a case → DUPLICATE, linked to that case.
//
// Pure DB composition — no Gmail client, so it builds/tests before the live
// connector. The triage decision (actionable? case_type?) is the caller's
// (heartbeat/LLM); this module executes it consistently and safely.

import type Database from 'better-sqlite3'
import { linkCaseSource, findCasesForSource } from './case-sources.js'
import { createCase } from './case-store.js'
import { claimMessage, localApply, excludeMessage, markDuplicate } from './email-ingest.js'
import { effectiveSensitivity } from './sensitivity.js'
import { suggestLinks, linkCases } from './case-link.js'
import { IDEMPOTENCY_HEADER } from './adapters/gmail-send.js'
import type { CaseSensitivity } from './schema.js'
import { requireExactTriageReceipt } from './triage-provenance.js'

export interface EmailIntakeInput {
  /** Stage 2G provenance, forwarded from the bridge so the gate can re-derive
   *  the exact receipt fingerprint from the verdict being applied. */
  sourceManifestHash?: string
  triageActor?: string
  triageModel?: string
  triagePromptFingerprint?: string
  accountId: string
  /** Must already exist as DISCOVERED (via openBatch). */
  messageId: string
  threadId?: string
  subject: string
  from: string
  /** Body/snippet used (with the subject) to classify sensitivity. */
  snippet: string
  /** Triage verdict from the caller. */
  actionable: boolean
  caseType?: string
  title?: string
  /** Owner-declared floor; the content can only escalate it. */
  declaredSensitivity?: CaseSensitivity
  priority?: string
  /** INBOUND (received) or OUTBOUND (a message Istvan sent). Default INBOUND.
   *  An OUTBOUND actionable email opens a case in WAITING_EXTERNAL — the ball is
   *  with the recipient — with a follow-up to watch for the reply. */
  direction?: 'INBOUND' | 'OUTBOUND'
  /** Message headers. If they carry the COS's own X-Marveen-Idempotency-Key, the
   *  message is our OWN automated send and is skipped (self-event filtering) so
   *  the executor's sends are never re-ingested as new inbound work. */
  headers?: Record<string, string>
  /** Recipient (for an OUTBOUND email). */
  to?: string
  /** When to check for a reply (OUTBOUND) / next wake. */
  followUpAt?: number
}

/** W12: ALREADY_PROCESSED joins the set. It was previously only a BRIDGE
 *  outcome, which encoded an assumption that turned out to be false — that the
 *  bridge's pre-read is the only way a seen message can reach the intake. */
export type IntakeOutcome = 'CASE_CREATED' | 'LINKED_DUPLICATE' | 'EXCLUDED' | 'EXCLUDED_SELF_SEND' | 'ALREADY_PROCESSED'

export interface IntakeResult {
  outcome: IntakeOutcome
  caseId?: string
  messageStatus: string
  sensitivity?: CaseSensitivity
}

function findActiveCaseByThread(db: Database.Database, threadId: string): { case_id: string } | undefined {
  // GRAPH FIRST (cutover 2026-09-03). The case-source graph is the read source
  // of truth for "which case is this thread about", and it is the only source
  // that can answer for a case whose threads never reached the column -- every
  // Sheet-migrated case, which is 21 of them carrying 55 threads.
  //
  // Only CANONICAL links are consulted. A semantic candidate must never route a
  // live incoming message: that would canonicalise a guess by acting on it,
  // which is precisely what the CANDIDATE state exists to prevent.
  //
  // Several canonical cases can claim one thread -- six threads in the live
  // store do. The most recently updated OPEN case wins, deliberately and not by
  // accident of row order: an old case kept alive by a shared thread should not
  // capture a reply that belongs to the matter currently in motion.
  const claims = findCasesForSource(db, 'personal', 'GMAIL_THREAD', threadId)
  if (claims.length) {
    const open = db.prepare(
      `SELECT case_id FROM personal_cases
        WHERE case_id IN (${claims.map(() => '?').join(',')})
          AND archived_at IS NULL AND status NOT IN ('COMPLETED','CANCELLED','ARCHIVED')
        ORDER BY updated_at DESC LIMIT 1`,
    ).get(...claims.map((c) => c.caseId)) as { case_id: string } | undefined
    if (open) return open
  }

  const byCase = db.prepare(
    `SELECT case_id FROM personal_cases
     WHERE gmail_thread_ids LIKE ? AND archived_at IS NULL
       AND status NOT IN ('COMPLETED','CANCELLED','ARCHIVED') LIMIT 1`
  ).get(`%"${threadId}"%`) as { case_id: string } | undefined
  if (byCase) return byCase

  // Second source, and it is not redundant: gmail_thread_ids is written ONLY at
  // case creation, from the intake message's thread. A case that we WROTE to —
  // where the thread exists because our own letter created it — has nothing in
  // that column, so the answer to our own letter would not find its case and
  // would open a new one. The ledger knows which thread each sent action landed
  // in; asking it closes exactly that gap.
  return db.prepare(
    `SELECT l.case_id FROM outbound_ledger l
     JOIN personal_cases c ON c.case_id = l.case_id
     WHERE l.thread_ref = ? AND c.archived_at IS NULL
       AND c.status NOT IN ('COMPLETED','CANCELLED','ARCHIVED')
     ORDER BY l.created_at DESC LIMIT 1`
  ).get(threadId) as { case_id: string } | undefined
}

/** Write the intake's own evidence into the case-source graph.
 *
 *  EXPLICIT_RELATION, so canonical: this is not an inference about the message,
 *  it IS the message that reached this case. Idempotent -- a re-run reports
 *  UNCHANGED and writes nothing. */
function recordIntakeSources(
  db: Database.Database, caseId: string, input: EmailIntakeInput, now: number, why: string,
): void {
  if (input.threadId) {
    linkCaseSource(db, {
      namespace: 'personal', caseId, sourceType: 'GMAIL_THREAD', sourceRef: input.threadId,
      linkMethod: 'EXPLICIT_RELATION', evidence: `${why} (message ${input.messageId})`,
      discoveredBy: 'cos-intake',
    }, now)
  }
  linkCaseSource(db, {
    namespace: 'personal', caseId, sourceType: 'GMAIL_MESSAGE', sourceRef: input.messageId,
    linkMethod: 'EXPLICIT_RELATION', evidence: why, discoveredBy: 'cos-intake',
  }, now)
}

export function ingestEmail(db: Database.Database, input: EmailIntakeInput, now: number): IntakeResult {
  // Stage 2G gate (Istvan, 2026-08-17). An email-derived case may not exist
  // without a durable record of the judgement that opened it. The gate lives
  // HERE, at the point the case is created, not at the caller: the 2026-08-17
  // audit exists because the only record of a triage verdict was its effect.
  // The receipt is re-derived from the verdict being applied, so a case can
  // only be opened by the judgement that actually decided it.
  const triageReceiptId = requireExactTriageReceipt(db, {
    accountId: input.accountId, messageId: input.messageId, threadId: input.threadId ?? null,
    sourceManifestHash: input.sourceManifestHash ?? null,
    actionable: input.actionable, caseType: input.caseType ?? null, title: input.title ?? null,
    workspace: null, priority: input.priority ?? null, declaredSensitivity: input.declaredSensitivity ?? null,
    actor: input.triageActor ?? null, model: input.triageModel ?? null,
    promptFingerprint: input.triagePromptFingerprint ?? null,
  })
  // Self-event filter: a message carrying our own idempotency marker is a send
  // the COS executor made — never re-ingest it as new work.
  if (input.headers && input.headers[IDEMPOTENCY_HEADER]) {
    excludeMessage(db, input.accountId, input.messageId, now)
    return { outcome: 'EXCLUDED_SELF_SEND', messageStatus: 'EXCLUDED' }
  }

  // The same check without headers (2026-08-10, live): the triage feeder reads
  // Gmail via search and does not carry headers, so a letter the COS itself sent
  // came back through the Sent folder as an ordinary candidate — and would have
  // opened a SECOND case for a matter that was already waiting. The ledger knows
  // its own message ids, so ask it.
  //
  // Linked to the originating case rather than merely excluded: the sent letter
  // IS part of that case's history, and dropping it would lose the record of
  // what went out.
  const ownSend = db.prepare(
    `SELECT case_id FROM outbound_ledger WHERE external_ref = ? LIMIT 1`
  ).get(input.messageId) as { case_id: string | null } | undefined
  if (ownSend?.case_id) {
    markDuplicate(db, input.accountId, input.messageId, now)
    db.prepare(`UPDATE email_processing SET case_id=@c, triage_receipt_id=@r WHERE gmail_account_id=@a AND message_id=@m`)
      .run({ c: ownSend.case_id, r: triageReceiptId, a: input.accountId, m: input.messageId })
    return { outcome: 'LINKED_DUPLICATE', caseId: ownSend.case_id, messageStatus: 'DUPLICATE' }
  }

  if (!input.actionable) {
    excludeMessage(db, input.accountId, input.messageId, now)
    return { outcome: 'EXCLUDED', messageStatus: 'EXCLUDED' }
  }

  const outbound = input.direction === 'OUTBOUND'
  const tx = db.transaction((): IntakeResult => {
    // W12 / §6.9 — RE-ENTRY, checked before the claim.
    //
    // The claim is now a compare-and-swap on DISCOVERED (email-ingest.ts), and
    // that made a pre-existing behaviour visible: calling ingestEmail a second
    // time for the SAME message used to re-claim it unconditionally and then
    // walk the whole flow again, overwriting a LOCAL_APPLIED row's status with
    // DUPLICATE on the way. The bridge's pre-read hides this in production, so
    // it was never a live defect — but "safe because the only caller happens to
    // check first" is the same shape as the cross-process bug this packet is
    // about, one layer up.
    //
    // A message that has already been through here is REPORTED, not
    // reprocessed. The linked case is still returned, so a caller asking about
    // a message it already sent us gets the same answer as before and nothing
    // is clobbered.
    const seen = db.prepare(
      `SELECT status, case_id FROM email_processing WHERE gmail_account_id=? AND message_id=?`,
    ).get(input.accountId, input.messageId) as { status: string; case_id: string | null } | undefined
    if (seen && seen.status !== 'DISCOVERED') {
      const linked = seen.case_id ?? (input.threadId ? findActiveCaseByThread(db, input.threadId)?.case_id : undefined)
      return linked
        ? { outcome: 'LINKED_DUPLICATE', caseId: linked, messageStatus: seen.status }
        : { outcome: 'ALREADY_PROCESSED', messageStatus: seen.status }
    }

    claimMessage(db, input.accountId, input.messageId, now)

    if (input.threadId) {
      const existing = findActiveCaseByThread(db, input.threadId)
      if (existing) {
        markDuplicate(db, input.accountId, input.messageId, now)
        // record which case it belongs to even though it's a duplicate message
        db.prepare(`UPDATE email_processing SET case_id=@caseId, triage_receipt_id=@r WHERE gmail_account_id=@acc AND message_id=@mid`)
          .run({ caseId: existing.case_id, r: triageReceiptId, acc: input.accountId, mid: input.messageId })
        // The message itself joins the case's dossier. The thread is already
        // linked (it is how we found the case), but the MESSAGE is new evidence
        // and nothing else records it against the case as a source.
        recordIntakeSources(db, existing.case_id, input, now,
          'intake: a message on a thread this case already owns')
        return { outcome: 'LINKED_DUPLICATE', caseId: existing.case_id, messageStatus: 'DUPLICATE' }
      }
    }

    const caseId = `case-${input.accountId}-${input.messageId}`
    const tier = effectiveSensitivity(input.declaredSensitivity ?? 'PERSONAL', `${input.subject}\n${input.snippet}`)
    createCase(db, {
      caseId,
      title: input.title ?? input.subject,
      caseType: input.caseType ?? 'EMAIL',
      // OUTBOUND: Istvan sent this → the ball is with the recipient (waiting).
      status: outbound ? 'WAITING_EXTERNAL' : 'NEW',
      description: outbound ? `Sent to: ${input.to ?? '?'}` : `From: ${input.from}`,
      sensitivity: tier,
      priority: input.priority ?? 'P2',
      sourceSystem: 'gmail',
      sourceReference: input.messageId,
      triageReceiptId,
    }, now)
    db.prepare(`UPDATE email_processing SET triage_receipt_id=@r WHERE gmail_account_id=@a AND message_id=@m`)
      .run({ r: triageReceiptId, a: input.accountId, m: input.messageId })
    const patch: Record<string, unknown> = {}
    if (input.threadId) patch.gmail_thread_ids = JSON.stringify([input.threadId])
    // An outgoing email should be watched for a reply; default a follow-up.
    if (outbound) { patch.waiting_on = `reply from ${input.to ?? 'recipient'}`; patch.follow_up_at = input.followUpAt ?? now + 3 * 86400 }
    // AN INBOUND CASE IS DUE FOR ITS FIRST LOOK NOW, and until 2026-08-14 it said
    // so nowhere. `listTodayCases` (case-engine-core.ts) shows a case only when
    // one of due_at / follow_up_at / next_wake_at is within the horizon, OR the
    // status is one of the five attention statuses. A freshly intaked case is
    // NEW with all three dates null, so it matched no branch of that WHERE --
    // invisible in the Today view from the moment it was created, not merely
    // until somebody triaged it. Measured before this line existed: 28 of 67
    // open cases were missing from the view, 17 of them NEW.
    //
    // The date is the honest fix rather than adding NEW to the attention set,
    // because the claim being made really is a date: this needs a first look
    // now. The attention statuses mean something else -- the engine is stuck on
    // this case -- and widening them would have made every consumer of that set
    // say something it does not mean.
    //
    // SAFE AGAINST THE FOLLOW-UP DRAFTER, checked rather than assumed
    // (followup-autodraft.ts:80,89): drafting requires status WAITING_EXTERNAL
    // or FOLLOW_UP_DUE *and* a follow_up_at older than the two-day grace. A NEW
    // case with follow_up_at = now fails both gates, so this cannot make the
    // system write to anybody.
    else patch.follow_up_at = now
    const keys = Object.keys(patch)
    if (keys.length) {
      db.prepare(`UPDATE personal_cases SET ${keys.map((k) => `${k}=@${k}`).join(', ')} WHERE case_id=@id`)
        .run({ ...patch, id: caseId })
    }
    // THE GRAPH IS WRITTEN HERE, not only by the backfill. A backfill that runs
    // on a schedule leaves every case created between two runs invisible to the
    // graph, and consumers would then be reading a source of truth that is
    // hours stale. The column is still written above, as the legacy projection.
    recordIntakeSources(db, caseId, input, now, 'intake: the message that opened the case')
    // Cross-thread linking (2026-08-09). Thread matching above only catches a
    // reply on a conversation we already know; a courier or a merchant writes on
    // its own thread about the same matter.
    //
    // NARROWED 2026-08-13 (P7). This used to auto-link every STRONG candidate,
    // justified as "deterministic, reversible, acts on nothing outside the
    // store". The missing word is WHOSE text decides: `input.subject` and
    // `input.snippet` are a STRANGER'S EMAIL. A sender who puts another case's
    // order number in their message got their case wired to it, deterministically
    // and with no human in the loop — case-graph poisoning that "reversible"
    // only helps with if somebody notices. So the shared identifier must also
    // appear in a field the owner or this system wrote (suggestLinks'
    // autoLinkable). Everything else is recorded as a SUGGESTION on the new
    // case's audit trail — visible, checkable, and not acted upon.
    const candidates = suggestLinks(db, `${input.subject}\n${input.snippet}`, caseId)
    for (const c of candidates) {
      if (c.strength === 'STRONG' && c.autoLinkable) {
        linkCases(db, caseId, c.caseId, c.evidence, now)
        continue
      }
      db.prepare(
        `INSERT INTO personal_case_events (case_id, case_version, actor, event_type, reason, created_at)
         VALUES (@id, 1, 'marveen', 'CASE_LINK_SUGGESTED', @reason, @now)`
      ).run({ id: caseId, reason: `${c.caseId} (${c.strength}): ${c.evidence}`, now })
    }

    localApply(db, input.accountId, input.messageId, caseId, now)
    // Seed progression state for the new case so it doesn't stagnate at NEW.
    // Guarded by table existence — if the progression schema hasn't been deployed
    // yet, the intake path is unchanged (existing brownfield behavior).
    const progTableExists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='case_progression_state'",
    ).get() as { 1: number } | undefined
    if (progTableExists) {
      db.prepare(
        `INSERT OR IGNORE INTO case_progression_state
         (domain, case_id, progression_enabled, progression_mode,
          next_progression_at, created_at, updated_at)
         VALUES ('personal', ?, 1, 'internal', ?, ?, ?)`,
      ).run(caseId, now, now, now)
    }
    return { outcome: 'CASE_CREATED', caseId, messageStatus: 'LOCAL_APPLIED', sensitivity: tier }
  })
  return tx()
}
