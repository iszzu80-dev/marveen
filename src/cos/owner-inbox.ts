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
import {
  recordOwnerAnswer, matchAnswerTarget, holdOwnerMessage,
  recordUnattributedResponse, buildDisambiguationPrompt,
} from './owner-question.js'

/** Istvan's own Telegram user id, as a LAST-RESORT default only.
 *
 *  MERGE 2026-08-13 (review T-4). The authorisation boundary on this path is
 *  "whose replies count", and it belongs in the deployment config, not in a
 *  constant inside a module: an owner-answer closes questions and writes
 *  OWNER_DECISION events onto cases, and a literal buried here is the line
 *  nobody finds on the next install. `handleOwnerUpdate` therefore takes the id
 *  from its caller, which reads `owner_id` from the bot config and REFUSES to
 *  poll at all when it is absent — refusing everything is the only safe reading
 *  of "nobody said who may decide".
 *
 *  Kept exported because the existing tests name it, and because a documented
 *  default is more honest than the same string appearing in three fixtures. */
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
  /** Set when a message could not be attributed: the ask-back to send, naming
   *  the tokens that were open at that moment. The poller sends it; it is
   *  carried on the RESULT rather than sent from here so this function stays a
   *  pure placement decision with no transport of its own. */
  disambiguationPrompt?: string
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
  ownerId: string = OWNER_ID,
): void {
  if (u.fromId !== ownerId) { result.rejected++; return }

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
    channel, chatId: u.chatId, replyToMessageId: u.replyToMessageId, text: u.text,
  })
  if (target === 'AMBIGUOUS') {
    // HOLD THE WORDS, not just the count. The cursor moves on and Telegram
    // will not serve this update again.
    //
    // AND RECORD IT AS ITS OWN STATE (owner decision 2026-09-02). It is written
    // as UNATTRIBUTED_RESPONSE with the tokens that were open at this instant,
    // because the previous shape of this branch is what froze the channel for
    // seventeen days: the failure had nowhere to live except in the fact that
    // five slots stayed full, so nobody could see it as a failure at all.
    //
    // NOTHING ELSE CHANGES. No question is answered, no slot is released, no
    // producer is paused. An attribution failure is one row about one message.
    const { candidateTokens } = recordUnattributedResponse(db, {
      channel, chatId: u.chatId, messageId: u.messageId, text: u.text,
    })
    result.ambiguous++
    result.disambiguationPrompt = buildDisambiguationPrompt(candidateTokens)
    return
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

