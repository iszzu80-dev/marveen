// Read Istvan's replies on the CoS channel and land them on the right case.
//
// This is the half that makes the channel split safe rather than merely tidy:
// without it he would answer into a chat nobody reads, which is worse than the
// single-channel world we started from.
//
// WHICH QUESTION DOES A REPLY ANSWER?
//   1. If he used Telegram's reply-to, the message id names the question
//      exactly. That is the only unambiguous signal and it wins.
//   2. Otherwise the newest open question on this channel. Stated plainly
//      because it is a guess: with several questions outstanding, a bare "igen"
//      is genuinely ambiguous, and pretending otherwise would be the confident
//      wrong answer this system keeps being punished for.
//
// SENDER CHECK: only the owner's own user id is accepted. The bot is reachable
// by anyone who finds it, and an owner-answer is an authorisation-bearing act --
// it closes questions and writes OWNER_DECISION events onto cases.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { initDatabase, getDb } from '../src/db.js'
import { loadCosBotConfig, pollCosUpdates } from '../src/cos/cos-telegram.js'
import { recordOwnerAnswer } from '../src/cos/owner-question.js'

const OFFSET_PATH = 'store/.cos-telegram-offset'
const OWNER_ID = '8942301795'

function readOffset(): number {
  try { return Number(readFileSync(OFFSET_PATH, 'utf8').trim()) || 0 } catch { return 0 }
}
function writeOffset(v: number): void {
  mkdirSync(dirname(OFFSET_PATH), { recursive: true })
  writeFileSync(OFFSET_PATH, String(v))
}

async function main(): Promise<void> {
  initDatabase()
  const db = getDb()
  const cfg = loadCosBotConfig()
  if (!cfg?.chatId) {
    console.log('CosInbox:', JSON.stringify({ read: 0, failed: true, error: 'CoS bot not configured' })); return
  }

  const updates = await pollCosUpdates(cfg, readOffset())
  const result = { channel: cfg.channelId, read: updates.length, matched: 0, unmatched: 0, rejected: 0 }
  let highest = 0

  for (const u of updates) {
    highest = Math.max(highest, u.updateId)
    if (u.fromId !== OWNER_ID) { result.rejected++; continue }

    // Prefer the explicit reply target.
    let row: { case_id: string; domain: string } | undefined
    if (u.replyToMessageId) {
      row = db.prepare(
        `SELECT case_id, domain FROM cos_owner_questions
          WHERE channel = ? AND channel_target = ? AND answered_at IS NULL AND superseded_at IS NULL`,
      ).get(cfg.channelId, `${u.chatId}:${u.replyToMessageId}`) as never
    }
    if (!row) {
      row = db.prepare(
        `SELECT case_id, domain FROM cos_owner_questions
          WHERE channel = ? AND answered_at IS NULL AND superseded_at IS NULL
          ORDER BY asked_at DESC LIMIT 1`,
      ).get(cfg.channelId) as never
    }
    if (!row) { result.unmatched++; continue }

    const rec = recordOwnerAnswer(db, {
      caseId: row.case_id, domain: row.domain, text: u.text,
      channel: { channel: cfg.channelId!, target: u.chatId },
    })
    if (rec) result.matched++; else result.unmatched++
  }

  // Confirm only AFTER the answers are written. Telegram drops an update once a
  // higher offset is requested, so advancing the cursor first would turn a crash
  // into a lost answer instead of a repeated read.
  if (highest) writeOffset(highest + 1)
  console.log('CosInbox:', JSON.stringify(result))
}

main().catch((e) => { console.log('CosInbox:', JSON.stringify({ read: 0, failed: true, error: String(e?.message ?? e) })) })
