// Deliver the owner's pending questions to the CoS channel, and record WHERE
// each one went so the answer can find its way back.
//
// Runs after the reader/ask step. Deliberately a separate step from asking:
// askPendingOwnerQuestions decides WHAT to ask and writes the row; this decides
// whether the sentence actually left the machine. Merging them would make a
// delivery failure look like "nothing to ask", which is the failure mode this
// whole subsystem keeps re-learning.

import { initDatabase, getDb } from '../src/db.js'
import { loadCosBotConfig, sendCosMessage } from '../src/cos/cos-telegram.js'

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
  const rows = db.prepare(
    `SELECT case_id, domain, question_hash, question_text FROM cos_owner_questions
      WHERE answered_at IS NULL AND superseded_at IS NULL
        AND (channel IS NULL OR channel != ?)
      ORDER BY asked_at ASC LIMIT 10`,
  ).all(cfg.channelId) as Array<{ case_id: string; domain: string; question_hash: string; question_text: string }>

  let sent = 0
  const failures: Array<{ caseId: string; error: string }> = []
  for (const r of rows) {
    try {
      const res = await sendCosMessage(cfg, r.question_text)
      db.prepare(
        `UPDATE cos_owner_questions SET channel = ?, channel_target = ?
          WHERE case_id = ? AND question_hash = ?`,
      ).run(cfg.channelId, `${res.chatId}:${res.messageId}`, r.case_id, r.question_hash)
      sent++
    } catch (e) {
      // One undeliverable question must not stop the rest, and the row is left
      // unmarked so the next run retries it rather than losing it.
      failures.push({ caseId: r.case_id, error: String((e as Error)?.message ?? e).slice(0, 160) })
    }
  }
  console.log('CosChannel:', JSON.stringify({
    channel: cfg.channelId, pending: rows.length, sent, failures,
  }))
}

main().catch((e) => { console.log('CosChannel:', JSON.stringify({ sent: 0, failed: true, error: String(e?.message ?? e) })) })
