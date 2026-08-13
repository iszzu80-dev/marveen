// Placing ONE owner message that arrived on the CoS channel.
//
// Extracted from scripts/cos-channel-poll.ts so the branches below can be driven
// by tests rather than only by a live Telegram poll. That matters more here than
// it usually does: every branch decides whether the owner's words SURVIVE the
// Telegram offset advancing past them, and Telegram does not re-serve an update
// once a higher offset has been requested.
//
// THE INVARIANT: handleOwnerUpdate must not return without either writing the
// answer (recordOwnerAnswer) or holding the text (holdOwnerMessage). The single
// exception is a message from somebody who is not the owner — that one is not
// his to keep.

import type Database from 'better-sqlite3'
import { looksLikeAQuestionBack } from './cos-telegram.js'
import { recordOwnerAnswer, matchAnswerTarget, holdOwnerMessage } from './owner-question.js'

/** Istvan's own Telegram user id. The bot is reachable by anyone who finds it,
 *  and an owner-answer is an authorisation-bearing act — it closes questions and
 *  writes OWNER_DECISION events onto cases. */
export const OWNER_ID = '8942301795'

/** What one poll produced. Every branch below either RECORDS the owner's words
 *  or writes them to the hold table — never merely counts them. */
export interface PollResult {
  channel?: string
  read: number
  matched: number
  unmatched: number
  ambiguous: number
  rejected: number
  notAnAnswer: number
}

export interface OwnerUpdate {
  updateId: number
  fromId?: string
  chatId?: string
  messageId?: number
  replyToMessageId?: number
  text: string
}

/**
 * Place ONE owner message. Exported so the branches below are driven by tests
 * rather than only by a live Telegram poll — every one of them decides whether
 * the owner's words survive the offset advancing past them.
 *
 * THE INVARIANT: this function must not return without either writing the
 * answer (recordOwnerAnswer) or holding the text (holdOwnerMessage). The one
 * exception is a message from somebody who is not the owner, which is not his
 * to keep. Everything else Telegram will never serve again.
 */
export function handleOwnerUpdate(
  db: Database.Database, channel: string, u: OwnerUpdate, result: PollResult,
): void {
  if (u.fromId !== OWNER_ID) { result.rejected++; return }

  // A question back is not an answer — and counting it is not keeping it.
  //
  // INCIDENT SHAPE (review 2026-08-13). This branch used to increment
  // `notAnAnswer` and drop the TEXT, while the offset advanced past the update;
  // Telegram never serves it again. So the owner asked the system something and
  // the words ceased to exist — nothing could ever reply to him. The 2026-08-11
  // postmortem's lesson, in its own words: "fail closed is only protection if
  // the withheld thing actually survives". It is held exactly like an ambiguous
  // answer, and for the same reason.
  if (looksLikeAQuestionBack(u.text)) {
    holdOwnerMessage(db, {
      channel, chatId: u.chatId, messageId: u.messageId, text: u.text,
      reason: 'a tulajdonos visszakerdezett -- ez nem valasz, valaszolni kell ra',
    })
    result.notAnAnswer++; return
  }

  // WHICH CASE this message answers is decided by one tested function, not by
  // a rule inlined in a script: the guess it replaced wrote the owner's words
  // onto the wrong case (2026-08-11 16:40, Wizz Air answer landed on the NAV
  // case). See matchAnswerTarget.
  const target = matchAnswerTarget(db, {
    channel, chatId: u.chatId, replyToMessageId: u.replyToMessageId,
  })
  if (target === 'AMBIGUOUS') {
    // HOLD THE WORDS, not just the count. The cursor moves on and Telegram
    // will not serve this update again.
    holdOwnerMessage(db, {
      channel, chatId: u.chatId, messageId: u.messageId, text: u.text,
      reason: 'tobb nyitott kerdes, es az uzenet egyiket sem nevezte meg',
    })
    result.ambiguous++; return
  }
  if (!target) {
    // Nothing was open at all. Still his words, still gone once the offset
    // moves, so they are held rather than counted away.
    holdOwnerMessage(db, {
      channel, chatId: u.chatId, messageId: u.messageId, text: u.text,
      reason: 'nincs nyitott kerdes ezen a csatornan, amire ez valasz lehetne',
    })
    result.unmatched++; return
  }

  const rec = recordOwnerAnswer(db, {
    caseId: target.caseId, domain: target.domain, text: u.text,
    channel: { channel, target: u.chatId ?? '' },
  })
  if (rec) { result.matched++; return }
  // The target was found and the write did NOT happen (the question was
  // answered/superseded between the match and the write, or the case moved on).
  // Counting it `unmatched` and moving the offset past it loses the owner's
  // words for the same reason as above — hold them.
  holdOwnerMessage(db, {
    channel, chatId: u.chatId, messageId: u.messageId, text: u.text,
    reason: `a valasz nem irodott be (${target.domain}/${target.caseId}) -- a kerdes idokozben lezarult vagy felulirodott`,
  })
  result.unmatched++
}

