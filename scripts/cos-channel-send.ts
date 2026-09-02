// Deliver the owner's pending questions to the CoS channel, and record WHERE
// each one went so the answer can find its way back.
//
// Runs after the reader/ask step. Deliberately a separate step from asking:
// askPendingOwnerQuestions decides WHAT to ask and writes the row; this decides
// whether the sentence actually left the machine. Merging them would make a
// delivery failure look like "nothing to ask", which is the failure mode this
// whole subsystem keeps re-learning.

import { initDatabase, getDb } from '../src/db.js'
import { loadCosBotConfig, loadChannelConfigs, sendCosMessage } from '../src/cos/cos-telegram.js'
import { pendingOutbox, markOutboxSent, markOutboxFailed } from '../src/cos/channel-outbox.js'
import {
  heldOwnerMessages, buildHeldFollowUp, markHeldResolved, outstandingOwnerQuestions,
} from '../src/cos/owner-question.js'
import { assertOwnerQuestionFreshForDelivery } from '../src/cos/owner-delivery-freshness.js'
import {
  markQuestionStaleBlocked, clearStaleBlock, exhaustedStaleQuestions, MAX_STALE_RETRIES,
} from '../src/cos/stale-question-regeneration.js'

async function main(): Promise<void> {
  initDatabase()
  const db = getDb()
  const cfg = loadCosBotConfig()

  if (!cfg) { console.log('CosChannel:', JSON.stringify({ sent: 0, failed: true, error: 'no bot config' })); return }
  if (!cfg.chatId) {
    // Configuration, not outage — Telegram will not disclose the chat until the
    // owner has messaged the bot once.
    console.log('CosChannel:', JSON.stringify({ sent: 0, failed: true, error: 'no chat_id yet (owner must message the bot once)' }))
    return
  }

  // Questions that are open and have NOT yet been delivered to this channel.
  // `channel IS NULL` is the pre-split backlog: those were asked before the CoS
  // channel existed and are exactly what should move over first.
  //
  // progression_run_id is selected because delivery is the final owner-facing
  // freshness boundary. The question composer silently refreshes this id when an
  // unchanged ask is re-read from a newer packet; delivery must validate the
  // exact evidence run the current text represents, not the original asked_at.
  const rows = db.prepare(
    `SELECT case_id, domain, question_hash, question_text, progression_run_id
       FROM cos_owner_questions
      WHERE answered_at IS NULL AND superseded_at IS NULL
        AND (channel IS NULL OR channel != ?)
      ORDER BY asked_at ASC LIMIT 10`,
  ).all(cfg.channelId) as Array<{
    case_id: string
    domain: 'personal' | 'zst'
    question_hash: string
    question_text: string
    progression_run_id: string | null
  }>

  let sent = 0
  let staleBlocked = 0
  let staleExhausted = 0
  const failures: Array<{ caseId: string; error: string }> = []
  for (const r of rows) {
    try {
      // ACP v1.4.5 shared Evidence Freshness Gate. A question can be fresh when
      // composed and stale by the time the separate delivery step runs. The
      // watermark checks BOTH case version and event sequence; the 37-second
      // owner-reply class is therefore caught even when timestamps share a
      // second. EVIDENCE_UNKNOWN is also fail-closed.
      assertOwnerQuestionFreshForDelivery(db, r.domain, r.case_id, r.progression_run_id)
      const res = await sendCosMessage(cfg, r.question_text)
      db.prepare(
        `UPDATE cos_owner_questions SET channel = ?, channel_target = ?
          WHERE case_id = ? AND question_hash = ?`,
      ).run(cfg.channelId, `${res.chatId}:${res.messageId}`, r.case_id, r.question_hash)
      // Delivered: the block is lifted. The RETRY COUNT is deliberately not
      // reset -- a case that alternates between stale and fresh is showing the
      // same problem repeatedly, and zeroing on success would let it do that
      // for ever without reaching the bound.
      clearStaleBlock(db, r.case_id, r.question_hash)
      sent++
    } catch (e) {
      // One undeliverable question must not stop the rest, and the row is left
      // unmarked so the next reader/question pass may refresh it and the next
      // channel pass retries. A stale/unknown evidence refusal is counted
      // separately but remains a failure: silence caused by stale evidence must
      // not look like "nothing to ask".
      const msg = String((e as Error)?.message ?? e).slice(0, 160)
      if (msg.includes('STALE_EVIDENCE') || msg.includes('EVIDENCE_UNKNOWN')) {
        staleBlocked++
        // RECORD IT, so the row stops holding a capacity slot and the reader
        // gets a reason to rebuild the question from a current packet. Leaving
        // it merely "unmarked for the next pass" is what let three blocking
        // decisions sit undeliverable, because no next pass was ever going to
        // come for them. See stale-question-regeneration.ts.
        const n = markQuestionStaleBlocked(db, {
          caseId: r.case_id, questionHash: r.question_hash, error: msg,
        })
        if (n >= MAX_STALE_RETRIES) staleExhausted++
      }
      failures.push({ caseId: r.case_id, error: msg })
    }
  }
  // HELD MESSAGES GET AN ANSWER (review 2026-08-12, T-3).
  //
  // `holdOwnerMessage` kept the owner's words when they could not be attributed
  // — and nothing read the table, nothing set `resolved_at`, and he was never
  // told. From his side that is indistinguishable from the message being
  // dropped: he replies, nothing happens, silence. A held message with no reply
  // is the same silence with a better audit trail.
  //
  // The follow-up hands him the one action that resolves it: reply-to on the
  // question he means. `matchAnswerTarget` treats that as exact, so the next
  // round needs no guessing at all.
  //
  // SENT FIRST, MARKED AFTER. A delivery failure must leave the row open for the
  // next sweep, which is the whole reason the row exists.
  let heldAnswered = 0
  const open = outstandingOwnerQuestions(db, 5)
  for (const h of heldOwnerMessages(db, 5)) {
    if (h.channel !== cfg.channelId) continue
    try {
      await sendCosMessage(cfg, buildHeldFollowUp(h, open))
      markHeldResolved(db, h.heldId, 'visszakerdeztunk a csatornan')
      heldAnswered++
    } catch (e) {
      failures.push({ caseId: `held:${h.heldId}`, error: String((e as Error)?.message ?? e).slice(0, 160) })
    }
  }

  // THE OUTBOX, DRAINED PER CHANNEL. Producers with no state of their own to
  // hang a message on (the radar first) queue here instead of sending, so a
  // synchronous tick never waits on the network and a transient failure retries
  // instead of losing the message.
  //
  // EVERY configured channel is drained, not just the one the questions went to.
  // Istvan chose a separate bot for the radar (2026-08-11), so a drain bound to
  // the question channel would leave the radar queue growing behind a bot nobody
  // ever emptied — a queue with no drain is a silence, not a delay.
  let outboxPending = 0
  let outboxSent = 0
  const byChannel: Record<string, number> = {}
  for (const chan of loadChannelConfigs()) {
    if (!chan.chatId) {
      // Configured but not yet reachable: Telegram will not disclose the chat
      // until the owner has written to that bot once. Reported, not silent.
      failures.push({ caseId: `${chan.channelId}`, error: 'no chat_id yet (owner must message this bot once)' })
      continue
    }
    const queued = pendingOutbox(getDb(), chan.channelId ?? '')
    outboxPending += queued.length
    for (const q of queued) {
      try {
        const res = await sendCosMessage(chan, q.text)
        markOutboxSent(getDb(), q.outbox_id, `${res.chatId}:${res.messageId}`)
        outboxSent++
        byChannel[chan.channelId ?? '?'] = (byChannel[chan.channelId ?? '?'] ?? 0) + 1
      } catch (e) {
        const msg = String((e as Error)?.message ?? e)
        markOutboxFailed(getDb(), q.outbox_id, msg)
        failures.push({ caseId: `${q.kind}:${q.dedupe_key}`, error: msg.slice(0, 160) })
      }
    }
  }

  // A QUESTION THAT WENT STALE TOO OFTEN IS AN OPERATIONAL FAILURE, AND SAYS SO.
  // Regeneration is bounded on purpose; the whole point of the bound is that the
  // giving-up is LOUD. Reported even at zero, for the same reason as everything
  // else in this payload.
  const exhausted = exhaustedStaleQuestions(db)
  for (const q of exhausted) {
    failures.push({
      caseId: q.caseId,
      error: `REPEATED_STALE: regenerated ${q.retryCount}x and delivery still refuses it (${q.lastError ?? 'no error recorded'})`,
    })
  }

  console.log('CosChannel:', JSON.stringify({
    channel: cfg.channelId, pending: rows.length, sent, staleBlocked, staleExhausted,
    staleExhaustedCases: exhausted.map(q => q.caseId), failures,
    // Reported even at zero, same rule as the outbox: "nothing was held" and
    // "held messages are piling up unanswered" must not look the same.
    heldAnswered, heldOpen: heldOwnerMessages(db, 50).length,
    // Reported even when zero: "the outbox was empty" and "the outbox was never
    // drained" must not look the same in the cycle report. `outboxByChannel`
    // makes the split visible — one number for two bots would hide a channel
    // that never delivers.
    outboxPending, outboxSent, outboxByChannel: byChannel,
  }))
}

main().catch((e) => { console.log('CosChannel:', JSON.stringify({ sent: 0, failed: true, error: String(e?.message ?? e) })) })
