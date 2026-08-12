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
import { dirname } from 'node:path'
import { initDatabase, getDb } from '../src/db.js'
import { loadCosBotConfig, pollCosUpdates, looksLikeAQuestionBack } from '../src/cos/cos-telegram.js'
import { recordOwnerAnswer, matchAnswerTarget, holdOwnerMessage } from '../src/cos/owner-question.js'

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

  const updates = await pollCosUpdates(cfg, readOffset())
  // `ambiguous`: the owner wrote a plain message while SEVERAL questions were
  // open, so which case he meant cannot be known. Counted separately from
  // `unmatched` (nothing open at all) because the two need different responses:
  // one needs a question back to him, the other needs nothing.
  const result = { channel: cfg.channelId, read: updates.length, matched: 0, unmatched: 0, ambiguous: 0, rejected: 0, notAnAnswer: 0 }
  let highest = 0

  for (const u of updates) {
    highest = Math.max(highest, u.updateId)
    if (u.fromId !== cfg.ownerId) { result.rejected++; continue }

    // A question back is not an answer. Counted, not swallowed: the owner asked
    // something and deserves a reply, and the case must stay open.
    //
    // AND HELD, for the same reason the ambiguity branch below holds (review
    // 2026-08-12, T-2). This branch used to `continue` with only a counter, and
    // the cursor moves at the bottom of the loop — so the sentence was gone,
    // which is exactly the bug that was fixed three lines further down and not
    // here. The detector is deliberately crude and fail-CLOSED, so it fires on
    // ordinary answers too: `hogy`, `ki`, `mennyi` and `milyen` are as common as
    // conjunctions in Hungarian as they are as question words. Refusing to read
    // those as decisions is right; losing them is not.
    if (looksLikeAQuestionBack(u.text)) {
      holdOwnerMessage(db, {
        channel: cfg.channelId!, chatId: u.chatId, messageId: u.messageId, text: u.text,
        reason: 'visszakerdezesnek tunt, ezert nem lett dontesnek olvasva',
      })
      result.notAnAnswer++; continue
    }

    // WHICH CASE this message answers is decided by one tested function, not by
    // a rule inlined in a script: the guess it replaced wrote the owner's words
    // onto the wrong case (2026-08-11 16:40, Wizz Air answer landed on the NAV
    // case). See matchAnswerTarget.
    const target = matchAnswerTarget(db, {
      channel: cfg.channelId!, chatId: u.chatId, replyToMessageId: u.replyToMessageId,
    })
    if (target === 'AMBIGUOUS') {
      // HOLD THE WORDS, not just the count. The cursor moves below and Telegram
      // will not serve this update again.
      holdOwnerMessage(db, {
        channel: cfg.channelId!, chatId: u.chatId, messageId: u.messageId, text: u.text,
        reason: 'tobb nyitott kerdes, es az uzenet egyiket sem nevezte meg',
      })
      result.ambiguous++; continue
    }
    if (!target) { result.unmatched++; continue }
    const row = { case_id: target.caseId, domain: target.domain }

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
