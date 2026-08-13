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
// it closes questions and writes OWNER_DECISION events onto cases. The id comes
// from the bot config (`owner_id`), not from a literal in this file: it is
// deployment-local identity, and a constant buried in a poller is the line
// nobody finds on the next install.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, getDb } from '../src/db.js'
import { loadCosBotConfig, pollCosUpdates } from '../src/cos/cos-telegram.js'
import { handleOwnerUpdate, type PollResult } from '../src/cos/owner-inbox.js'

const OFFSET_PATH = 'store/.cos-telegram-offset'

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

  // WHOSE replies count, from config (review 2026-08-12, T-4). No owner id means
  // no owner answers: refusing everything is the only safe reading of "nobody
  // said who may decide", and it is reported rather than looking like silence.
  if (!cfg.ownerId) {
    console.log('CosInbox:', JSON.stringify({
      read: 0, failed: true,
      error: 'no owner_id in the CoS bot config — owner answers cannot be authorised',
    }))
    return
  }

  // WHOSE replies count, from config (review 2026-08-12, T-4). No owner id means
  // no owner answers: refusing everything is the only safe reading of "nobody
  // said who may decide", and it is reported rather than looking like silence.
  // Kept through the 2026-08-13 merge that moved the per-message branches into
  // owner-inbox.ts — the extraction made every branch testable, and this guard
  // is the one that decides whether those branches run for the right person.
  if (!cfg.ownerId) {
    console.log('CosInbox:', JSON.stringify({
      read: 0, failed: true,
      error: 'no owner_id in the CoS bot config — owner answers cannot be authorised',
    }))
    return
  }

  const updates = await pollCosUpdates(cfg, readOffset())
  // `ambiguous`: the owner wrote a plain message while SEVERAL questions were
  // open, so which case he meant cannot be known. Counted separately from
  // `unmatched` (nothing open at all) because the two need different responses:
  // one needs a question back to him, the other needs nothing.
  const result: PollResult = { channel: cfg.channelId, read: updates.length, matched: 0, unmatched: 0, ambiguous: 0, rejected: 0, notAnAnswer: 0 }
  let highest = 0

  for (const u of updates) {
    highest = Math.max(highest, u.updateId)
    handleOwnerUpdate(db, cfg.channelId!, u, result, cfg.ownerId)
  }

  // Confirm only AFTER the answers are written. Telegram drops an update once a
  // higher offset is requested, so advancing the cursor first would turn a crash
  // into a lost answer instead of a repeated read.
  if (highest) writeOffset(highest + 1)
  console.log('CosInbox:', JSON.stringify(result))
}

// Only poll when this file is the process entry point: the handler above is
// imported by the tests, and importing it must not talk to Telegram.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.log('CosInbox:', JSON.stringify({ read: 0, failed: true, error: String(e?.message ?? e) })) })
}
