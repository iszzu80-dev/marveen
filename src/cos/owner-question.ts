// The question that actually reaches Istvan (§10.4 Writer, first slice).
//
// WHAT WAS MISSING. The Reader produces a packet naming what is missing and who
// holds it, the planner turns that into steps, and both land in a table nobody
// reads. Istvan's question on 2026-08-11 was exactly this: "who thinks through
// what the lawyer wrote and what is needed from me — and it was supposed to come
// to me on Telegram." The thinking existed; the sentence never left the machine.
//
// WHY THIS IS DETERMINISTIC AND NOT A SECOND MODEL CALL. Same argument as the
// planner: the judgement already happened. The packet's facts and missing
// requirements are already written in Hungarian, already cited to sources, and
// already validated. Asking a model to rewrite them adds a second place where a
// detail can drift, in exchange for smoother prose. If the wording turns out to
// read badly, that is a reason to upgrade this file — not a reason to have built
// it as a model call first.
//
// WHAT IT WILL NOT DO. It asks; it never acts. No email, no draft queue, no
// approval. The only outbound is a bus message to the owner's own channel, which
// is the same path the outbound-recovery alert already uses — one owner-alert
// road, not two.
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { createAgentMessage, appendDailyLog } from '../db.js'
import { foldName, type ReaderEvidencePacket } from './reader.js'
import type { EvidencePlan } from './evidence-planner.js'
import { collectDecisionPackage, formatDeadline, type DecisionPackage } from './decision-package.js'
import { internalPlanLabels } from './progression-pipeline.js'
import { openApprovalRequestForQuestion, decideActionApproval } from './action-approval-request.js'
import { evaluatePreQuestionEvidence } from './pre-question-evidence.js'
import { COUNTS_AGAINST_CAP_SQL, clearStaleBlock } from './stale-question-regeneration.js'

export interface OwnerQuestion {
  caseId: string
  domain: string
  /** The text as Istvan will read it. */
  text: string
  /** Identity of the QUESTION, not of the run. A case whose situation has not
   *  changed asks the same question, which is how re-asking is suppressed
   *  without a timer — the same doctrine the pipeline uses for owner answers. */
  hash: string
}

/** Which steps are genuinely his to answer. */
function ownerSteps(plan: EvidencePlan): string[] {
  return plan.steps
    .filter(s => s.kind === 'ASK_OWNER' || foldName(s.blockedBy) === 'ISTVAN')
    .map(s => s.label)
}

/**
 * Compose the question, or return null when there is nothing to ask.
 *
 * Null is the common case and must stay cheap: a case waiting on an external
 * party is not a case with a question for Istvan, and asking him anyway is how
 * a notification channel becomes noise and then becomes muted.
 */
/**
 * Is this recommendation fit to put in front of Istvan?
 *
 * Measured on the live store 2026-08-16: of the two questions that carried a
 * recommendation at all, one read
 *
 *     "Javaslatom: Check for external response or escalate if overdue"
 *
 * — an internal English phrase, offered to a Hungarian reader as advice, with
 * "igen — csináljam így" underneath it. The options are what make this costly
 * rather than merely ugly: "yes" to a sentence that means nothing is an answer
 * that means nothing, and the system would have recorded it as a decision.
 *
 * REJECTS ON POSITIVE EVIDENCE ONLY. A Hungarian sentence without accents is
 * still a Hungarian sentence, so the test is not "does it look Hungarian" but
 * "is this a string the machine wrote to itself". Better no recommendation than
 * a meaningless one — silence is honest, a wrong recommendation is not.
 *
 * THE FIRST VERSION OF THIS FUNCTION WAS WRONG, AND THE LIVE STORE SAID SO.
 *
 * It was a regex over the English words in the one sample I had read: "check",
 * "escalate", "overdue". Seventeen tests green, merged — and one cycle later the
 * live question for PRI-SYS-2026-001 read "Javaslatom: Execute first recovery
 * action". None of my words, same defect, and my own test file would have
 * called it usable.
 *
 * The mistake was the instrument, not the word list. These strings are not
 * arbitrary English: they are the plan-step labels in buildRollingPlan, a CLOSED
 * SET of about two dozen, copied verbatim into nextBestAction.description. A set
 * you can enumerate does not need to be guessed at. So the primary test is now
 * exact membership in that set, derived by driving the planner — which also
 * means a label added tomorrow is covered without anyone remembering this file.
 *
 * The heuristics stay UNDERNEATH as a second net, for text that reaches the
 * recommendation from somewhere other than the planner.
 */
export function isUsableRecommendation(rec: string | null | undefined): boolean {
  const t = (rec ?? '').trim()
  if (t.length < 8) return false
  // PRIMARY: the machine's own vocabulary, enumerated rather than guessed.
  if (internalPlanLabels().has(t)) return false
  // Raw enum / status token leaking through: WAIT_EXTERNAL, RECOVERY_REQUIRED.
  if (/^[A-Z][A-Z0-9_]{4,}$/.test(t)) return false
  // Second net: internal English vocabulary, for a recommendation that did not
  // come from the planner. Kept deliberately narrow — a false reject here is a
  // real Hungarian recommendation silently thrown away.
  if (/\b(check|escalate|overdue|pending|external response|follow[- ]?up|awaiting|resolve|verify|proceed with)\b/i.test(t)) return false
  return true
}

/**
 * The ask, rewritten when the deadline has already passed.
 *
 * A question that says "collect the parcel with code X" and, three lines lower,
 * "Határidő: 2026-08-10 (6 napja lejárt)" contradicts itself in one message:
 * the ask is written as if actionable and the date says it is not. Nothing
 * reconciled them, and the owner had to do it in his head.
 *
 * After the date the decidable question is a different one — did it happen, or
 * did we miss it — and those two answers lead to opposite places: closure, or a
 * new task. Four such cases appeared on 2026-08-15/16 alone (EUR-váltás,
 * Macflats check-in, Control Tower, Waterpik).
 */
export function expiredAskPrefix(deadline: { at: number; kind: 'due' | 'follow_up' } | null | undefined, now: number): string | null {
  if (!deadline || deadline.at >= now) return null
  const days = Math.max(1, Math.round((now - deadline.at) / 86_400))
  return `• A HATÁRIDŐ ${days} NAPJA ELMÚLT. Ami most eldöntendő: megtörtént, vagy elmaradt?`
    + ` Ha megtörtént, lezárom; ha elmaradt, ez nem lezárás, hanem új teendő.`
}

export function buildOwnerQuestion(
  input: {
    caseId: string; domain: string; title: string
    packet: ReaderEvidencePacket; plan: EvidencePlan
    /** §20 — the four elements the question used to be missing. Optional so the
     *  composer stays pure and every existing caller keeps working: without it
     *  the question is exactly what it was, with it the question is a Decision
     *  Package. Gathered by collectDecisionPackage, which does the DB reads. */
    pkg?: DecisionPackage
    /** Only used to say how far away the deadline is. */
    now?: number
  },
): OwnerQuestion | null {
  const steps = ownerSteps(input.plan)
  const ballIsHis = input.packet.ballHolder === 'ISTVAN'
  if (steps.length === 0 && !ballIsHis) return null

  const missingFromHim = input.packet.missingRequirements
    // FOLDED (review #6, H-3). `whoHasIt` is free text written by a model that
    // was asked to answer in Hungarian, so "István" arrives with the accent
    // roughly as often as without — and an ASCII comparison silently sorted the
    // same case into a different question each time.
    .filter(m => foldName(m.whoHasIt).includes('ISTVAN'))
  const lines: string[] = []
  lines.push(`❓ ${input.title}`)
  lines.push('')

  // The two or three facts that make the question answerable without opening
  // the case. More than that and it stops being a question.
  const context = input.packet.facts.slice(0, 3).map(f => `• ${f.statement}`)
  if (context.length > 0) {
    lines.push('Amit tudunk:')
    lines.push(...context)
    lines.push('')
  }

  // §20.2 — WHAT THE SYSTEM ALREADY DID. Placed before the ask, because it is
  // the context that changes the answer: "I already emailed them twice" and "I
  // have done nothing yet" call for different replies to the same question, and
  // until now the question said neither.
  const pkg = input.pkg
  if (pkg && pkg.handled.length > 0) {
    lines.push('Amit eddig elintéztem:')
    lines.push(...pkg.handled.slice(0, 5).map(h => `• ${h}`))
    lines.push('')
  }

  // §20.3 — the CAUSE. "Ami Tőled kell" names the symptom; this names why the
  // machine could not get past it on its own.
  if (pkg?.stoppedBecause) {
    lines.push(`Miért állt meg: ${pkg.stoppedBecause}`)
    lines.push('')
  }

  lines.push('Ami Tőled kell:')
  // A question that says only "a decision is needed" does not say WHAT to
  // decide, and an unanswerable question is noise wearing a question mark.
  // Live 2026-08-11: two of the first four questions degenerated to exactly
  // that, because the Reader put the ball on ISTVAN while attributing the
  // missing items to someone else. When that happens, name what is BLOCKED and
  // who holds it — that is the thing he is deciding about.
  const generic = (line: string): boolean =>
    /^[•\s]*(istvan|istván)\b.*(döntés|dontes)/i.test(line) || /döntés a következő lépésről/.test(line)
  let asks = missingFromHim.length > 0
    ? missingFromHim.map(m => `• ${m.what}${m.why ? ` — ${m.why}` : ''}`)
    : steps.map(s => `• ${s}`)
  if (asks.length === 0 || asks.every(generic)) {
    const blocked = input.packet.missingRequirements.map(
      m => `• ${m.what} (${m.whoHasIt})${m.why ? ` — ${m.why}` : ''}`,
    )
    asks = blocked.length > 0
      ? [`• döntés arról, hogyan tovább — ez akadályozza:`, ...blocked]
      : [`• döntés a következő lépésről (a rendszer nem talált konkrét hiányzó tételt)`]
  }
  // (2) After the deadline the ORIGINAL ask is no longer the decidable thing.
  // It stays visible — he may still want to do it — but it is no longer what
  // the question is about.
  //
  // DELIBERATELY OUTSIDE `asks`, so it is outside the hash. Not an oversight,
  // and not the same call as the recommendation's: this line CHANGES BY ITSELF,
  // every midnight, because it counts days. In the hash it would re-ask the same
  // dead question once a day forever, and `replacesOwn` would exempt every
  // repeat from the cooldown and the outstanding ceiling — the
  // four-questions-in-thirty-minutes failure described below, on a daily timer.
  // The open question's stored text is refreshed in place instead, so the count
  // he reads is today's without anything new going out.
  const expired = expiredAskPrefix(pkg?.deadline, input.now ?? Math.floor(Date.now() / 1000))
  if (expired) lines.push(expired)
  lines.push(...asks)

  const primaryUnknown = input.packet.uncertainty[0]
  if (primaryUnknown) {
    lines.push('')
    lines.push(`Amit magamtól nem tudok eldönteni: ${primaryUnknown}`)
  }

  // §20.5 and §20.4 — the suggestion, and what may be answered to it.
  //
  // In this order and not the reverse: options before a recommendation is a
  // menu, and a menu is what the owner already has. The recommendation is the
  // system doing the thinking it was built to do; the options exist so he can
  // refuse it in one word.
  // (1) NO RECOMMENDATION IS BETTER THAN A MEANINGLESS ONE. The options go with
  // it: "igen — csináljam így" under an unusable sentence turns a non-answer
  // into a recorded decision.
  if (pkg?.recommendation && isUsableRecommendation(pkg.recommendation)) {
    lines.push('')
    lines.push(`Javaslatom: ${pkg.recommendation}`)
    if (pkg.options.length > 0) {
      lines.push('Válaszolhatsz:')
      lines.push(...pkg.options.map(o => `• ${o}`))
    }
  }

  // (3) The first uncertainty is usually the REAL question — on the Waterpik
  // case it was "nem ismert, hogy István már átvette-e a csomagot", filed at the
  // bottom under a label that reads as a caveat. Lifted into the body, named as
  // what the system could not establish, because that is precisely why it is
  // asking instead of acting.
  const rest = input.packet.uncertainty.slice(1, 2)
  if (rest.length > 0) {
    lines.push('')
    lines.push(`Bizonytalanság: ${rest.join('; ')}`)
  }

  // §20.7 — the date. Last, and on its own line, because it is the one element
  // that is read at a glance and decides whether the rest is read now or later.
  if (pkg?.deadline) {
    lines.push('')
    lines.push(formatDeadline(pkg.deadline, input.now ?? Math.floor(Date.now() / 1000)))
  }

  lines.push('')
  lines.push(`(ügy: ${input.caseId} · magabiztosság: ${input.packet.confidence})`)

  const text = lines.join('\n')
  // The hash covers WHAT IS ASKED, not the whole packet: a new fact that does
  // not change the ask must not re-ask.
  //
  // §20 CHANGES NOTHING HERE, AND THAT IS THE SECOND VERSION OF THIS LINE.
  //
  // The first version added the recommendation to the hash, reasoning that
  // "Javaslatom: X" and "Javaslatom: Y" are different questions because one word
  // of his answer means something different against each. The reasoning is
  // sound; the consequence was not, and it was measured within the hour.
  //
  // A changed hash makes `hasOtherOpenQuestion` true, and `replacesOwn`
  // deliberately EXEMPTS a replacement from both the six-hour cooldown and the
  // outstanding ceiling -- an exemption written for a REWORDING that makes a
  // vague question answerable, not for a stream of fresh proposals. The next
  // best action is re-planned whenever the case's status moves, so with the
  // recommendation in the hash, one case sent FOUR questions in thirty minutes
  // with its reading completely unchanged. That is the failure ASK_COOLDOWN_SEC
  // exists to stop, arriving through a door §20 had just opened.
  //
  // So the hash stays what it was: the identity of the ASK. A changed proposal
  // about an unchanged ask is not a new question -- it is the engine changing
  // its mind, and it does not get to interrupt him for that. The open question's
  // stored text is refreshed in place instead (see isHandled's caller below), so
  // the current proposal is what the dashboard and the eventual answer see.
  const hash = createHash('sha256')
    .update([input.caseId, ...asks].join(''))
    .digest('hex')
    .slice(0, 32)
  return { caseId: input.caseId, domain: input.domain, text, hash }
}

export interface AskResult {
  asked: number
  /** Questions NOT asked because too many are already waiting on him.
   *  Reported rather than silent: a channel that went quiet because of a cap
   *  must not look like a system with nothing to ask. */
  heldBacklogFull: number
  /** E2: WHAT is being held, by class. A number alone cannot tell an
   *  authorization gate from a shopping question. */
  heldByClass: Partial<Record<QuestionClass, number>>
  /** The oldest few held asks, so a starving class is visible without a query. */
  heldTop: Array<{ caseId: string; cls: QuestionClass; ageSec: number }>
  /** False when the approval table is absent and the ordering degraded to two
   *  classes. Never silent: an order that quietly stopped ordering is worse
   *  than one that never did. */
  priorityOrdered: boolean
  /** Questions suppressed because the same ask is already outstanding. */
  alreadyAsked: number
  /** Cases read this pass with nothing to ask the owner. */
  nothingToAsk: number
  /** Cases whose stored reading is OLDER than the case itself — asked from such
   *  a packet, the question describes a world that has moved on. Counted, not
   *  silent: the next reader pass refreshes them. */
  staleReading: number
  /** Cases held back because they asked recently and got no answer. Counted for
   *  the same reason as everything else here: a channel that went quiet because
   *  of a rule must not look like a system with nothing to say. */
  cooldown: number
  /** Questions NOT asked because the fact was already in the system, with
   *  provenance (owner invariant 2026-09-02).
   *
   *  COUNTED AND NAMED, never silent. A suppression is the one outcome here
   *  that LOOKS like health -- the channel is quiet and the backlog is short --
   *  so if it were merely not-asked it would be indistinguishable from a reader
   *  that found nothing, which is the exact confusion that let QADBD sit for
   *  twenty-two days. */
  answeredByEvidence: number
  /** Which case, and which surface answered it. */
  answeredByEvidenceDetail: Array<{ caseId: string; surfaces: string; reason: string }>
  /** §11 C-invariant: candidate cases the scan window (50) never looked at.
   *
   *  Every other count here explains a case the sweep SAW and declined. This one
   *  covers the cases it did not see at all, which until now were invisible in
   *  exactly the way the ordering fix above makes matter: once the order is by
   *  deadline, the cases past the window are the least urgent ones — but only
   *  a number can say whether the window is holding back three cases or three
   *  hundred. */
  windowExhausted: number
}

/** Has this exact question already been HANDLED — either still waiting for an
 *  answer, or answered and nothing has moved since?
 *
 *  The second half is the 2026-08-11 fix. The old check only suppressed
 *  UNANSWERED questions, on the reasoning that "once an answer is recorded, the
 *  same question may legitimately be asked again if the situation returns". The
 *  situation returning is the right trigger; the code never checked for it. So
 *  within twenty minutes of Istvan answering five questions, two came straight
 *  back — same case, same ask, nothing changed — and the UPSERT below wiped
 *  `answered_at` on the way, making them look like they had never been answered.
 *
 *  Getting an answer must not be what causes the question to reappear. That is
 *  the fastest way to teach someone to stop answering.
 *
 *  "Moved since" is the case's own updated_at: if the case has not changed since
 *  the answer landed, there is nothing new to ask about. */
function isHandled(db: Database.Database, caseId: string, domain: string, hash: string): boolean {
  try {
    const row = db.prepare(
      `SELECT answered_at FROM cos_owner_questions
       WHERE case_id = ? AND question_hash = ? AND superseded_at IS NULL`,
    ).get(caseId, hash) as { answered_at: number | null } | undefined
    if (!row) return false
    if (row.answered_at == null) return true          // still waiting on him
    const table = domain === 'zst' ? 'zst_cases' : 'personal_cases'
    const c = db.prepare(`SELECT updated_at FROM ${table} WHERE case_id = ?`).get(caseId) as
      { updated_at: number } | undefined
    // Answered and the case has not moved since -> nothing new to ask.
    return c == null || c.updated_at <= row.answered_at
  } catch {
    // No table yet: nothing can be outstanding. Returning true here would mute
    // the channel on a fresh install, which is the failure worth avoiding.
    return false
  }
}

/** Seconds a stored reading may lag the case before it counts as stale. */
export const STALE_READING_GRACE_SEC = 120

/**
 * Did the OWNER say something about this case after the reading was taken?
 *
 * THE GRACE WINDOW DOES NOT APPLY TO HIS OWN WORDS, and this is not a tuning
 * choice — it is what the window is for and what it is not for.
 *
 * `STALE_READING_GRACE_SEC` exists because intake, reading and `updated_at` land
 * within the same cycle in arbitrary order, seconds apart; without it a
 * perfectly fresh question would be discarded as stale. That argument covers
 * machine writes racing each other. It does not cover an owner answer, because
 * an owner answer is the single event most likely to make the stored question
 * wrong.
 *
 * MEASURED, 2026-08-16. Istvan answered the OneDrive question at 00:44:15
 * ("Én voltam, rendben volt" — the deletion was intentional). At 00:44:52,
 * thirty-seven seconds later and comfortably inside the 120s window, the sweep
 * asked him about the SAME case from a pre-answer packet, and what it asked was:
 *
 *     "Istvan 'YES' döntése (event:245) kontextusa nem világos"
 *
 * — the exact ambiguity he had just resolved. From where he sits that is not a
 * follow-up question, it is the system not listening. The one thing a question
 * channel cannot afford.
 */
function ownerSpokeSince(db: Database.Database, domain: string, caseId: string, since: number): boolean {
  const events = domain === 'zst' ? 'zst_case_events' : 'personal_case_events'
  try {
    const row = db.prepare(
      `SELECT 1 AS x FROM ${events}
        WHERE case_id = ?
          AND event_type IN ('OWNER_DECISION', 'OWNER_INFORMATION', 'OWNER_CONFIRMATION')
          AND created_at > ?
        LIMIT 1`,
    ).get(caseId, since) as { x: number } | undefined
    return row !== undefined
  } catch {
    // No such table on this install. Absence of an events table is not
    // evidence that he stayed silent, but it is also not something this guard
    // can decide — the caller's existing staleness check still runs.
    return false
  }
}

/** How long one case must stay quiet after asking, unless the owner answers.
 *
 *  Live on 2026-08-11: ONE case produced THREE questions in twenty minutes.
 *  20:20 "what should be done with this invoice?", answered at 20:21; 20:30
 *  "does 'parking' mean a line item on the invoice?", which I resolved myself;
 *  20:40 "please confirm the follow-up date Marveen proposed" — the Reader had
 *  read my own note, which said in so many words that Istvan could override the
 *  date, and turned it into a question.
 *
 *  Each one was individually defensible. Together they are a case talking to its
 *  owner every ten minutes, which is how a channel gets muted — and the ceiling
 *  does not catch it, because the ceiling bounds the PILE, not the RATE per case.
 *
 *  Six hours is not a magic number: it is "not again this working session". An
 *  ANSWER clears it immediately, so a conversation the owner is actually having
 *  is never slowed down — only a case talking to itself is. */
export const ASK_COOLDOWN_SEC = 6 * 3600

/** How many candidate cases one sweep looks at. Everything past it is reported
 *  as `windowExhausted`, never silently dropped. */
export const QUESTION_SCAN_WINDOW = 50

/** The candidate set: every case whose latest reading could still produce a
 *  question. Written once and used by both the page and its count, because two
 *  hand-kept copies of a clause this long describe different sets within a
 *  release, and then the "how many are left" number is about a different
 *  population than the list it accompanies. */
const QUESTION_CANDIDATES_SQL = `
  FROM case_evidence_packets p
  JOIN (
    SELECT case_id, MAX(created_at) AS created_at
    FROM case_evidence_packets WHERE packet_json IS NOT NULL GROUP BY case_id
  ) latest ON latest.case_id = p.case_id AND latest.created_at = p.created_at
  LEFT JOIN personal_cases pc ON pc.case_id = p.case_id AND p.domain <> 'zst'
  LEFT JOIN zst_cases      zc ON zc.case_id = p.case_id AND p.domain =  'zst'
  WHERE p.packet_json IS NOT NULL AND p.plan_json IS NOT NULL
    -- A finished case has no open question. Live 2026-08-11: a COMPLETED rental
    -- case produced one anyway, because this query only ever looked at packets
    -- and never at the case behind them.
    --
    -- Aliased away from the outer pc/zc on purpose: an inner alias that shadows
    -- an outer one is legal and unreadable, and the next person to touch the
    -- ORDER BY would be reading the wrong row.
    AND NOT EXISTS (
      SELECT 1 FROM personal_cases xp WHERE xp.case_id = p.case_id
        AND (xp.status IN ('COMPLETED','CANCELLED','ARCHIVED') OR xp.archived_at IS NOT NULL))
    AND NOT EXISTS (
      SELECT 1 FROM zst_cases xz WHERE xz.case_id = p.case_id
        AND (xz.status IN ('COMPLETED','CANCELLED','ARCHIVED') OR xz.archived_at IS NOT NULL))`

/** A deadline this close is treated as hard: it lands inside the window in which
 *  an answer can still change the outcome. Beyond it, a deadline is a date, and
 *  what decides the order is materiality. */
export const DEADLINE_IMMINENT_SEC = 72 * 3600

/** Priority as a sort key. Anything unrecognised sorts last rather than
 *  silently in the middle, so a typo in the column never gets promoted. */
const PRIORITY_RANK_SQL = `CASE COALESCE(pc.priority, zc.priority)
  WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END`

/**
 * §11.2 E (card `0d2121a9`). The order in which cases get to ask.
 *
 * This query used to end `ORDER BY p.created_at DESC` — the created_at of the
 * EVIDENCE PACKET, so the most recently read case asked first. That is the
 * "pure latest read order" the spec names and rejects, and it is not a
 * theoretical problem: the sweep bound (50) and the ask ceiling (5 outstanding)
 * are both real, so whatever sorts first consumes them. A case whose deadline
 * passed last week, read a week ago, sat behind every case read this morning —
 * permanently, because a case that is not read again never moves up.
 *
 * The order now is deadline class, then materiality, then oldest waiting:
 *
 *  0. overdue          — the deadline is behind us; nothing outranks this
 *  1. imminent         — inside DEADLINE_IMMINENT_SEC
 *  2. has a deadline   — a date exists, it is not near
 *  3. no deadline      — nothing to be late for
 *
 * Materiality breaks ties inside a class, and `due_at ASC` then `packet_at ASC`
 * break the rest — oldest first, so the queue drains rather than churns. Sorting
 * by the raw timestamp instead of by class would have made materiality dead
 * weight: two deadlines are almost never equal to the second.
 *
 * The joins are domain-scoped. The exclusion subqueries below are deliberately
 * not — an exclusion that matches across domains can only suppress a question,
 * never invent one, and that is the safe direction to be loose in.
 */
/**
 * E2 — WHICH QUESTION GETS ONE OF THE FIVE SLOTS.
 *
 * The ceiling was always there and the ORDER never was. Whoever the sweep
 * reached first took a slot, so on 2026-08-31 the five open questions were a
 * Cloudflare plan choice, a magnetic mount forward, a NAV notice from 07-10, a
 * missing run log and a LinkedIn trial -- while the Teraszszigetelés decision
 * had gone 48+ engine wake-ups without ever being asked, and every approval
 * request the Phase 2 gate depends on queued behind the same wall.
 *
 * An approval-driven phase whose approvals compete with "which Waterpik" is not
 * an approval-driven phase. Three classes, and each one is read from STRUCTURE,
 * never from the wording of the question:
 *
 *   0 SAFETY_APPROVAL    the case has an UNDECIDED action-approval request.
 *                        This is the authorization gate itself; if it cannot
 *                        ask, the engine cannot act, and Checkpoint E is a
 *                        queue rather than a capability.
 *   1 BLOCKING_DECISION  the case is parked in AWAITING_SELECTION /
 *                        AWAITING_APPROVAL: the engine has done everything it
 *                        can and is stopped until a person answers.
 *   2 NORMAL             everything else -- the reader enriching a case that
 *                        is otherwise progressing perfectly well.
 *
 * Ordering only. Nothing here raises the ceiling, supersedes anybody's open
 * question, or decides on his behalf which one he sees; it decides which one is
 * ASKED when there is room for one. Preemption would change what is already on
 * his board, and that is his call, not a sort order's.
 *
 * STARVATION: the existing keys stay, unchanged, below the class -- deadline
 * bucket, priority, due date, and finally packet age ASCENDING. A NORMAL that
 * loses a slot keeps ageing and therefore keeps climbing against its own class.
 * Nothing is dropped: what does not fit is HELD, and held is recomputed from
 * the store every sweep rather than written into a second table that can drift
 * from it.
 */
export const QUESTION_CLASS_NAMES = ['SAFETY_APPROVAL', 'BLOCKING_DECISION', 'NORMAL'] as const
export type QuestionClass = typeof QUESTION_CLASS_NAMES[number]

const APPROVAL_TABLE = 'cos_action_approval_requests'

function approvalTablePresent(db: Database.Database): boolean {
  try {
    return db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`,
    ).get(APPROVAL_TABLE) !== undefined
  } catch { return false }
}

/** The class expression, or a constant when the approval table is absent.
 *
 *  A store without the table is an older one, not a broken one, and the whole
 *  ask loop is wrapped in a try that would turn a missing-table error into
 *  "no candidates" -- silence where questions should be. So the absence
 *  degrades the ORDER, explicitly, and never the asking. */
function questionClassSql(hasApprovals: boolean): string {
  const approvalArm = hasApprovals
    ? `WHEN EXISTS (SELECT 1 FROM ${APPROVAL_TABLE} ar
                     WHERE ar.case_id = p.case_id AND ar.domain = p.domain
                       AND ar.decided_at IS NULL) THEN 0`
    : ''
  return `CASE
    ${approvalArm}
    WHEN COALESCE(pc.status, zc.status) IN ('AWAITING_SELECTION','AWAITING_APPROVAL') THEN 1
    ELSE 2
  END`
}

const QUESTION_ORDER_TAIL = `
  CASE
    WHEN COALESCE(pc.due_at, zc.due_at) IS NULL THEN 3
    WHEN COALESCE(pc.due_at, zc.due_at) <= @now THEN 0
    WHEN COALESCE(pc.due_at, zc.due_at) <= @now + ${DEADLINE_IMMINENT_SEC} THEN 1
    ELSE 2
  END,
  ${PRIORITY_RANK_SQL},
  COALESCE(pc.due_at, zc.due_at) ASC,
  p.created_at ASC`

/** Has this case already asked recently, with no answer since?
 *
 *  Deliberately NOT keyed on the question's hash: the failure is a case that
 *  keeps finding new things to ask, so a rule that only suppressed IDENTICAL
 *  questions would have stopped none of the three. */
function askedRecently(db: Database.Database, caseId: string, now: number): boolean {
  try {
    const row = db.prepare(
      `SELECT MAX(asked_at) AS last_ask, MAX(COALESCE(answered_at, 0)) AS last_answer
         FROM cos_owner_questions WHERE case_id = ?`,
    ).get(caseId) as { last_ask: number | null; last_answer: number } | undefined
    if (!row?.last_ask) return false
    // An answer since the last ask means the owner is engaged with this case;
    // the next question is part of that exchange, not noise on top of it.
    if (row.last_answer >= row.last_ask) return false
    return now - row.last_ask < ASK_COOLDOWN_SEC
  } catch { return false }
}

function caseUpdatedAt(db: Database.Database, domain: string, caseId: string): number {
  const table = domain === 'zst' ? 'zst_cases' : 'personal_cases'
  try {
    const r = db.prepare(`SELECT updated_at FROM ${table} WHERE case_id = ?`).get(caseId) as
      { updated_at: number } | undefined
    return r?.updated_at ?? 0
  } catch { return 0 }
}

/** Does this case already have a DIFFERENT open question? Then a new ask is a
 *  replacement, not an addition. */
function hasOtherOpenQuestion(db: Database.Database, caseId: string, hash: string): boolean {
  try {
    const row = db.prepare(
      `SELECT 1 FROM cos_owner_questions
       WHERE case_id = ? AND question_hash != ? AND answered_at IS NULL AND superseded_at IS NULL`,
    ).get(caseId, hash)
    return row !== undefined
  } catch { return false }
}

/**
 * Turn stored readings into questions on the owner's channel.
 *
 * Reads the newest packet per case that has not produced a question yet. The
 * bound is per sweep, because a burst of twelve questions at 3am is
 * indistinguishable from spam and gets the channel muted.
 */
/** Where the owner's questions go. Resolved by the caller so the domain layer
 *  never has to know a chat id -- and so the split can be rolled out by config
 *  rather than by editing this file. */
export interface OwnerChannel {
  /** 'telegram' | 'bus' | ... -- the transport family. */
  channel: string
  /** The address within it (a Telegram chat id). Opaque here on purpose. */
  target: string
}

export function askPendingOwnerQuestions(
  db: Database.Database,
  opts: { limit?: number; now?: number; maxOutstanding?: number; channel?: OwnerChannel } = {},
): AskResult {
  const limit = opts.limit ?? 2
  // A GLOBAL cap on unanswered questions, on top of the per-sweep bound.
  //
  // The per-sweep bound alone allows two an hour to become twelve: six sweeps,
  // two each, nobody answering. The thing that actually protects the channel is
  // not the rate, it is the size of the pile waiting on him — past a handful,
  // one more question does not get answered faster, it gets the channel muted.
  const maxOutstanding = opts.maxOutstanding ?? MAX_OUTSTANDING_QUESTIONS
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const result: AskResult = {
    asked: 0, alreadyAsked: 0, nothingToAsk: 0, heldBacklogFull: 0, staleReading: 0, cooldown: 0,
    windowExhausted: 0, heldByClass: {}, heldTop: [], priorityOrdered: false,
    answeredByEvidence: 0, answeredByEvidenceDetail: [],
  }

  // Questions that GREW the open pile this sweep. A superseding rewrite does
  // not, so it must not consume a ceiling slot.
  let netAdded = 0
  let outstanding = 0
  try {
    outstanding = (db.prepare(
      `SELECT COUNT(*) AS n FROM cos_owner_questions WHERE answered_at IS NULL AND superseded_at IS NULL`,
    ).get() as { n: number }).n
  } catch { outstanding = 0 }

  let rows: Array<{ case_id: string; domain: string; packet_json: string; plan_json: string; packet_at: number; progression_run_id: string | null; question_class?: number }> = []
  try {
    // E2: class first, then everything the order already weighed. The class is
    // computed in SQL rather than after the fetch on purpose -- the scan window
    // is a LIMIT on this ORDER BY, so classifying afterwards would let a safety
    // approval fall off the end of the window and never be seen at all.
    const cls = questionClassSql(approvalTablePresent(db))
    result.priorityOrdered = true
    rows = db.prepare(
      `SELECT p.case_id, p.domain, p.packet_json, p.plan_json, p.created_at AS packet_at,
              p.progression_run_id, ${cls} AS question_class
       ${QUESTION_CANDIDATES_SQL}
       ORDER BY ${cls}, ${QUESTION_ORDER_TAIL} LIMIT ${QUESTION_SCAN_WINDOW}`,
    ).all({ now }) as never
    // The window's overflow, counted rather than probed. A `LIMIT window + 1`
    // trick would only ever answer "at least one more", and the number is the
    // whole point: three cases past the window is a bound doing its job, three
    // hundred is a queue nobody is draining. The count reuses the candidate
    // clause verbatim so the two can never describe different sets.
    const total = (db.prepare(`SELECT COUNT(*) AS n ${QUESTION_CANDIDATES_SQL}`).get({ now }) as { n: number }).n
    result.windowExhausted = Math.max(0, total - rows.length)
  } catch {
    return result
  }

  for (const row of rows) {
    if (result.asked >= limit) break
    let packet: ReaderEvidencePacket
    let plan: EvidencePlan
    try {
      packet = JSON.parse(row.packet_json) as ReaderEvidencePacket
      plan = JSON.parse(row.plan_json) as EvidencePlan
    } catch { continue }

    // A READING OLDER THAN THE CASE IS NOT A READING OF THIS CASE.
    //
    // Live 2026-08-11: I read a contract case's email body and wrote its real
    // content onto the case at 16:51. Minutes later the sweep asked Istvan the
    // ORIGINAL question -- "the intake is only an email reference, it contains
    // no contract information" -- because the question is composed from the
    // stored packet, and that packet was from 08:40. Eight hours of new facts,
    // invisible to the sentence he would have read.
    //
    // The grace window is not decoration: intake, reading and the case's own
    // updated_at land within the same cycle, seconds apart in arbitrary order
    // (one live pair was 22 seconds). A strict comparison would call that
    // staleness and silence a perfectly fresh question. Measured before writing
    // this: 11% of cases with packets were genuinely stale, almost all because
    // an owner answer or a correction had landed since -- exactly the ones that
    // must NOT be asked from the old reading.
    if (row.packet_at + STALE_READING_GRACE_SEC < caseUpdatedAt(db, row.domain, row.case_id)) {
      result.staleReading++
      continue
    }
    // ...and the same check WITHOUT the grace window when the owner himself
    // spoke. See ownerSpokeSince: the window is for machine writes racing each
    // other inside one cycle, never for his answer.
    if (ownerSpokeSince(db, row.domain, row.case_id, row.packet_at)) {
      result.staleReading++
      continue
    }

    const title = caseTitle(db, row.domain, row.case_id) ?? row.case_id
    // §20 — the Decision Package. THE CALLER IS THE POINT: buildOwnerQuestion
    // has been able to take a `pkg` since it was written, and a package nobody
    // collects is the defect this review has spent a week naming. Gathered here,
    // once per question, from state that already exists.
    const pkg = collectDecisionPackage(db, row.domain === 'zst' ? 'zst' : 'personal', row.case_id)
    const question = buildOwnerQuestion({
      caseId: row.case_id, domain: row.domain, title, packet, plan, pkg, now,
    })
    if (!question) { result.nothingToAsk++; continue }

    // THE PRE-QUESTION EVIDENCE GATE (owner invariant, 2026-09-02).
    //
    // Before interrupting him, look for the fact. The rule used to be "a column
    // I selected is NULL, therefore ask", and that is how QADBD asked for a
    // contract's text that had been extracted the same day and summarised into
    // the case's own description -- then held a channel slot for twenty-two
    // days.
    //
    // Suppression is all-or-nothing and it is COUNTED. A question that is not
    // asked because we already know the answer looks, from every metric, exactly
    // like a reader that found nothing to ask. Naming it is what keeps this gate
    // from becoming the next silent failure.
    const requirements = packet.missingRequirements
      .filter(m => foldName(m.whoHasIt).includes('ISTVAN'))
      .map(m => m.what)
    if (requirements.length > 0) {
      const gate = evaluatePreQuestionEvidence(db, {
        namespace: row.domain === 'zst' ? 'zst' : 'personal',
        caseId: row.case_id, requirements,
      })
      if (gate.suppress) {
        const surfaces = [...new Set(gate.verdicts.flatMap(v => v.hits.map(h => h.surface)))].join(',')
        result.answeredByEvidence++
        result.answeredByEvidenceDetail.push({
          caseId: row.case_id, surfaces, reason: gate.summary,
        })
        continue
      }
    }

    if (isHandled(db, row.case_id, row.domain, question.hash)) {
      // SUPPRESSED, BUT KEEP THE RUN CURRENT. The ask is unchanged, so it must
      // not go out twice -- but the case has been read again since, in a NEWER
      // run. If the row kept pointing at the first one, the eventual answer
      // would name a run whose decision no longer matches the current one, and
      // consumeOwnerAnswer would call the answer stale and drop it. That is the
      // same H-2 loop coming back through a different door: the question the
      // owner is looking at RIGHT NOW is the one his answer has to attach to.
      if (row.progression_run_id) {
        db.prepare(
          `UPDATE cos_owner_questions SET progression_run_id = ?
            WHERE case_id = ? AND question_hash = ? AND answered_at IS NULL AND superseded_at IS NULL`,
        ).run(row.progression_run_id, row.case_id, question.hash)
        // THE REGENERATION COMPLETES HERE (owner directive 2026-09-02). The ask
        // is unchanged, so this is the same question with the same hash and the
        // same token -- semantic identity preserved by construction. What has
        // changed is the run it points at, which is exactly what the delivery
        // gate refused. Lifting the block lets the next channel pass try again
        // against a current watermark.
        clearStaleBlock(db, row.case_id, question.hash)
      }
      // AND REFRESH THE TEXT, WITHOUT RE-NOTIFYING (§20, 2026-08-12).
      //
      // The ask is unchanged, so nothing new goes out -- that is the whole point
      // of this branch. But the Decision Package around the ask CAN have moved:
      // the engine re-planned, another mail went out, the deadline came closer.
      // Leaving the stored text at its first version means the dashboard, the
      // held-message follow-up, and anyone reading the row later see a proposal
      // the engine no longer makes.
      //
      // Text only. `asked_at` is deliberately NOT touched: it is what the
      // cooldown measures from, and refreshing it would turn a silent update
      // into a permanently postponed one.
      db.prepare(
        `UPDATE cos_owner_questions SET question_text = ?
          WHERE case_id = ? AND question_hash = ? AND answered_at IS NULL AND superseded_at IS NULL`,
      ).run(question.text, row.case_id, question.hash)
      result.alreadyAsked++; continue
    }
    // A REPLACEMENT is not an addition. When this case already has an open
    // question, asking the reworded one supersedes it — the pile waiting on him
    // does not grow, so the ceiling has nothing to protect against here.
    // Counting it would let a full queue block the very rewrite that makes a bad
    // question answerable, which is the opposite of what the ceiling is for.
    const replacesOwn = hasOtherOpenQuestion(db, row.case_id, question.hash)

    // ONE CASE, ONE NEW QUESTION PER SESSION — unless he answered.
    //
    // Placed HERE, after both earlier checks, on purpose:
    //   - after `isHandled`, so an identical repeat is still reported as
    //     `alreadyAsked`; the more specific diagnosis is the more useful one.
    //   - and exempting `replacesOwn`, because a REWRITE of a question he is
    //     already looking at does not add anything to his pile — it makes a
    //     vague question answerable, which is the opposite of noise. Holding
    //     that back would leave him with the worse wording and call it quiet.
    if (!replacesOwn && askedRecently(db, row.case_id, now)) { result.cooldown++; continue }

    if (!replacesOwn && outstanding + netAdded >= maxOutstanding) {
      result.heldBacklogFull++
      // BACKPRESSURE, NAMED. A bare counter cannot tell "five trivia questions
      // are holding the channel" from "an authorization gate is waiting behind
      // them", and those need opposite responses. Held is derived from the
      // store on every sweep, so it survives a restart without a second table
      // that can disagree with the first.
      const k = QUESTION_CLASS_NAMES[row.question_class ?? 2] ?? 'NORMAL'
      result.heldByClass[k] = (result.heldByClass[k] ?? 0) + 1
      if (result.heldTop.length < 5) {
        result.heldTop.push({ caseId: row.case_id, cls: k, ageSec: Math.max(0, now - row.packet_at) })
      }
      continue
    }

    // Record BEFORE sending. A crash between the two costs an unasked question,
    // which a later sweep re-derives; the other order costs a duplicate every
    // sweep until someone notices.
    // UPSERT, not INSERT. The row is keyed by (case_id, question_hash), so a
    // question that was answered and later becomes relevant again collides with
    // its own history — found by the test for exactly that path. Re-asking
    // resets the ask and clears the previous answer here; the answer itself is
    // not lost, because it was appended to the case events when it arrived, and
    // that record is the append-only one.
    // SUPERSEDE the case's other open questions first.
    //
    // The key is (case_id, question_hash), and the hash is of the ASK. So a
    // REWORDED question about the same case does not collide — it opens a second
    // row while the first stays unanswered. That happened on 2026-08-11: I
    // improved the Valencia deposit question at 07:35, the vague 07:28 version
    // ("Istvan döntése szükséges") stayed open, and the result was one case
    // occupying two of the five ceiling slots and asking Istvan the same thing
    // twice, once badly.
    //
    // One case can have at most one open question. The old row is marked
    // superseded, not answered — see the column comment in schema.ts.
    //
    // THE TOKEN IS INHERITED ACROSS A SUPERSEDE (found by live readback,
    // 2026-09-02). A regenerated question is reworded by the model, so its ask
    // hash differs and it opens a NEW row -- and the first cut gave that row a
    // new token. Measured on the live store: PRI-DQ-2026-001 went Q39FB ->
    // Q4ABB in a single cycle. A name that changes while the owner is deciding
    // is worse than no name: he copies it, answers ten minutes later, and the
    // token he types no longer exists.
    //
    // Inheriting is safe precisely because of the rule immediately above: one
    // case has at most one open question. So the token names "the open question
    // on this case", which is exactly the thing he needs to point at, and
    // uniqueness is preserved because the old row is closed in the same
    // statement.
    // THE RETRY COUNT IS INHERITED TOO (found by live readback, 2026-09-02).
    //
    // The bound lives on the question ROW, and a reworded regeneration opens a
    // NEW row -- so the counter restarted every time and the bound could never
    // be reached. Measured on the live store: PRI-HOME-2026-004 had four rows
    // with counts 2, 1, 2, 1. A bound that resets whenever the model chooses
    // different words is not a bound; it is a comment.
    //
    // Inherited for the same reason as the token, and it is the same object:
    // "the open question on this case". The count therefore accumulates across
    // rewordings, which is exactly the thing the owner asked to become a
    // visible operational failure.
    const inherited = db.prepare(
      `SELECT token, stale_retry_count AS retries FROM cos_owner_questions
        WHERE case_id = ? AND question_hash != ? AND answered_at IS NULL
          AND superseded_at IS NULL
        ORDER BY stale_retry_count DESC LIMIT 1`,
    ).get(row.case_id, question.hash) as { token: string | null; retries: number } | undefined

    db.prepare(
      `UPDATE cos_owner_questions SET superseded_at = ?, token = NULL
        WHERE case_id = ? AND question_hash != ? AND answered_at IS NULL AND superseded_at IS NULL`,
    ).run(now, row.case_id, question.hash)

    // THE RUN ID TRAVELS WITH THE QUESTION. Without it the answer cannot name
    // what it is answering, and the engine drops it (review #6, H-2) -- so the
    // owner's reply closes the question and moves nothing, and the next sweep
    // asks him the same thing again.
    db.prepare(
      `INSERT INTO cos_owner_questions
         (case_id, domain, question_hash, question_text, asked_at, channel, channel_target,
          progression_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (case_id, question_hash) DO UPDATE
         SET asked_at = excluded.asked_at, question_text = excluded.question_text,
             answered_at = NULL, answer_text = NULL, superseded_at = NULL,
             channel = excluded.channel, channel_target = excluded.channel_target,
             progression_run_id = excluded.progression_run_id`,
    ).run(row.case_id, row.domain, question.hash, question.text, now,
          opts.channel?.channel ?? null, opts.channel?.target ?? null,
          row.progression_run_id ?? null)

    // THE TOKEN IS ASSIGNED AFTER THE ROW EXISTS AND BEFORE THE TEXT GOES OUT.
    // That order is the whole contract: a message carrying a token whose row was
    // never written would invite an answer nothing can bind, which is the exact
    // failure this replaces.
    // A regenerated question is no longer stale-blocked: it was just rebuilt
    // from a current packet, which is the whole point of the regeneration.
    clearStaleBlock(db, row.case_id, question.hash)
    if (inherited?.token) {
      db.prepare(
        `UPDATE cos_owner_questions SET token = ?
          WHERE case_id = ? AND question_hash = ? AND token IS NULL`,
      ).run(inherited.token, row.case_id, question.hash)
    }
    if (inherited && inherited.retries > 0) {
      db.prepare(
        `UPDATE cos_owner_questions SET stale_retry_count = ?
          WHERE case_id = ? AND question_hash = ? AND stale_retry_count < ?`,
      ).run(inherited.retries, row.case_id, question.hash, inherited.retries)
    }
    const token = ensureQuestionToken(db, row.case_id, question.hash)
    const outbound = question.text + replyContractLine(token)

    createAgentMessage('cos-reader', 'marveen', outbound, 'cos-owner-question')
    appendDailyLog('marveen', `## COS kerdes Istvannak (${token})\n${outbound}`)
    result.asked++
    if (!replacesOwn) netAdded++
  }
  return result
}

function caseTitle(db: Database.Database, domain: string, caseId: string): string | null {
  const table = domain === 'zst' ? 'zst_cases' : 'personal_cases'
  try {
    const row = db.prepare(`SELECT title FROM ${table} WHERE case_id = ?`).get(caseId) as { title?: string } | undefined
    return row?.title ?? null
  } catch { return null }
}


// ── The answer path ───────────────────────────────────────────────────────
//
// A question with nowhere to put the answer is half a channel. Istvan answers on
// Telegram, and this is where that sentence becomes something the engine can
// consume: the outstanding question is closed, and a case EVENT is appended so
// the pipeline's existing owner-answer consumption picks it up on the next run.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not interpret the answer into a
// decision beyond the plainest yes/no. Card 78e81155 ("interpret the owner's
// free-text answer AT ANSWER TIME, as a proposal he confirms") is the real
// version of that, and guessing here would put words in his mouth on a case
// record that is append-only. Free text is stored as INFORMATION, verbatim.

// A YES/NO IS A WHOLE SENTENCE, NOT A PREFIX.
//
// The old pair matched a prefix and nothing else: /^\s*(igen|ok|jó|…)\b/. So
// "Jó kérdés, még gondolkodom" — a sentence that says the opposite — was
// recorded as OWNER_DECISION{choice:'YES'}, and on an approval question that
// used to be enough to move the case to READY under the words "Owner approved
// the request". "Nem tudom" read as NO in exactly the same way.
//
// The rule now: the answer counts as a decision only when the WHOLE message is
// the decision — the word, optionally with punctuation, optionally with one of
// the short intensifiers people actually type ("igen, mehet", "ok rendben").
// Anything longer is a sentence, and a sentence is INFORMATION: it is stored
// verbatim, the engine does not advance on it, and the owner is not second-
// guessed. That is the codebase's fail-closed posture and the 2026-08-11
// postmortem's finding in one line — a wrong pairing is worse than none.
//
// Note the deliberate asymmetry with the old list: bare "y"/"n" are gone. A
// single letter is as likely to be a typo as an answer, and this is the input
// that grants approvals.
const AFFIRM = '(igen|ok|oké|oke|okay|rendben|jó|jo|persze|mehet|yes|jöhet|johet|csináld|csinald)'
const DENY = '(nem|ne|no|elutasítom|elutasitom|elutasít|elutasit|nem kell|hagyjuk)'
const CLOSER = '[\\s.!,;:]*'
const YES = new RegExp(`^${CLOSER}${AFFIRM}(${CLOSER}${AFFIRM})*${CLOSER}$`, 'i')
const NO = new RegExp(`^${CLOSER}${DENY}(${CLOSER}${DENY})*${CLOSER}$`, 'i')

export interface RecordedAnswer {
  caseId: string
  questionHash: string
  eventType: 'OWNER_DECISION' | 'OWNER_INFORMATION'
  choice: 'YES' | 'NO' | null
}

/**
 * Record Istvan's answer to the newest outstanding question on a case.
 *
 * Returns null when there is no outstanding question — answering a case nobody
 * asked about would write an event the engine cannot attribute, which is worse
 * than losing the sentence.
 */
export function recordOwnerAnswer(
  db: Database.Database,
  input: { caseId: string; domain: string; text: string; now?: number; channel?: OwnerChannel },
): RecordedAnswer | null {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  // CHANNEL-AWARE MATCHING. When the answer names the channel it arrived on,
  // only questions asked on that channel may absorb it. Without this the split
  // would silently mis-attribute: an answer typed in the dev chat could close a
  // question the CoS chat is still displaying, and the owner would see a
  // question he had already answered somewhere else.
  //
  // MATCHES ON `channel`, NOT on `channel_target`. The two columns answer
  // different questions: `channel` is WHICH CHANNEL, `channel_target` is WHICH
  // MESSAGE on it (chatId:messageId, written by the sender so a Telegram
  // reply-to can name one question exactly). The first version compared the
  // answer's channel address against channel_target and therefore matched
  // nothing at all -- caught live on the first poll, which reported
  // `unmatched: 2` instead of mis-attributing. Failing closed is why it was
  // merely wrong and not damaging.
  //
  // `asked_at <= now` keeps a message that arrived BEFORE the question from
  // being read as its answer -- the first two updates on the new bot were
  // "/start" and "Hi", sent while the questions were still queued.
  //
  // A question with NO recorded channel (asked before the split) still matches
  // anything -- it predates the distinction, and refusing it would strand every
  // question asked today.
  //
  // THE DOMAIN IS PART OF THE MATCH (review 2026-08-12, T-5). It used to be
  // ignored here while the EVENT was written to the domain's own table, so a
  // caller that passed the wrong domain closed the question and wrote nothing:
  // the answer vanished and the question looked answered. The live caller reads
  // the domain off the matched row, so this could not fire today — but the next
  // caller (an HTTP route, a CLI) is under no obligation to be that careful, and
  // a guard that depends on every future caller being careful is not a guard.
  const open = input.channel
    ? db.prepare(
        `SELECT question_hash, progression_run_id FROM cos_owner_questions
         WHERE case_id = ? AND domain = ? AND answered_at IS NULL AND superseded_at IS NULL
           AND (channel IS NULL OR channel = ?)
           AND asked_at <= ?
         ORDER BY asked_at DESC LIMIT 1`,
      ).get(input.caseId, input.domain, input.channel.channel, now) as
        { question_hash: string; progression_run_id: string | null } | undefined
    : db.prepare(
        `SELECT question_hash, progression_run_id FROM cos_owner_questions
         WHERE case_id = ? AND domain = ? AND answered_at IS NULL AND superseded_at IS NULL
         ORDER BY asked_at DESC LIMIT 1`,
      ).get(input.caseId, input.domain) as
        { question_hash: string; progression_run_id: string | null } | undefined
  if (!open) return null

  const choice: 'YES' | 'NO' | null = YES.test(input.text) ? 'YES' : (NO.test(input.text) ? 'NO' : null)
  const eventType = choice ? 'OWNER_DECISION' : 'OWNER_INFORMATION'

  // ── The scoped action approval (P4 closure) ─────────────────────────────
  //
  // WHERE THE TICKET IS BORN. If the question being answered is an approval
  // REQUEST -- one this case opened because Invariant E refused a high-risk step
  // -- then an explicit yes runs the deterministic gate and issues a §22.2
  // ticket bound to that exact action, and the id travels in the answer event so
  // the next progression run can consume it.
  //
  // THREE OUTCOMES, and the two that grant nothing are the point:
  //
  //   plain YES on an approval question   → gate → ticket → id in the payload
  //   plain NO                            → the request is spent as REJECTED
  //   anything else (free text)           → OWNER_INFORMATION, request UNTOUCHED
  //
  // The third is the owner's first mandatory counter-example: information and a
  // decision must not manufacture an authorization. It is enforced structurally
  // rather than by a check -- the only branch that calls the issuer is the one
  // that already established the message was a bare yes to an approval request.
  //
  // AND A YES TO SOMETHING ELSE GRANTS NOTHING EITHER. The lookup is by QUESTION
  // HASH, so answering an ordinary reader question on a case that also has an
  // open approval request cannot decide the approval: different question, no
  // row, no ticket.
  let authorizationId: string | null = null
  let approvalNote: string | null = null
  const pendingApproval = openApprovalRequestForQuestion(db, input.domain, input.caseId, open.question_hash)
  if (pendingApproval && choice !== null) {
    const decided = decideActionApproval(db, pendingApproval.request_id, choice === 'YES' ? 'APPROVE' : 'REJECT', now)
    if (decided.ok) authorizationId = decided.authorizationId
    else approvalNote = decided.reason
  }

  db.prepare(
    `UPDATE cos_owner_questions SET answered_at = ?, answer_text = ?
     WHERE case_id = ? AND domain = ? AND question_hash = ?`,
  ).run(now, input.text, input.caseId, input.domain, open.question_hash)

  const table = input.domain === 'zst' ? 'zst_cases' : 'personal_cases'
  const row = db.prepare(`SELECT version FROM ${table} WHERE case_id = ?`).get(input.caseId) as
    { version: number } | undefined
  if (row) {
    const events = input.domain === 'zst' ? 'zst_case_events' : 'personal_case_events'
    // source_reference NAMES THE RUN THE QUESTION CAME FROM. consumeOwnerAnswer
    // refuses an answer without it -- it cannot verify WHICH question was
    // answered, so it treats the event as stale and returns null. Until this
    // line existed, every answer arriving from Telegram was written and then
    // silently discarded by its own consumer, and the loop closed: answer ->
    // question released -> case unchanged -> same packet -> same question sent
    // again (review #6, H-2, reproduced: two identical messages after
    // answering).
    const info = db.prepare(
      `INSERT INTO ${events} (case_id, case_version, actor, event_type, reason, payload,
                              source_system, source_reference, created_at)
       VALUES (?, ?, 'istvan', ?, ?, ?, 'telegram', ?, ?)`,
    ).run(
      input.caseId, row.version, eventType,
      input.text.slice(0, 500),
      JSON.stringify({
        choice, answer: input.text, question_hash: open.question_hash,
        // Present ONLY when a gate issued one. `approvalReferenceOf` reads this
        // field and nothing else, so an answer that did not earn a ticket cannot
        // carry a claim to one.
        ...(authorizationId ? { authorizationId } : {}),
        ...(approvalNote ? { approvalRefused: approvalNote } : {}),
      }),
      open.progression_run_id ?? null,
      now,
    )

    // AND WAKE THE CASE. Found live on 2026-08-11, twenty minutes after the
    // source_reference fix went in: Istvan answered a question, the event was
    // written and correctly attached — and `decideTrigger` still said "nothing
    // has changed and no new deadline has arrived", so the engine was never
    // going to look at it.
    //
    // The trigger's state hash reads `last_event_id` from the case row. That
    // column was written by NOTHING: zero cases out of 106 had it set, and a
    // grep found no writer at all. So an EVENT-ONLY change — which is exactly
    // what an owner answer is — could not make a case eligible. The answer path
    // had three doors in a row: no caller, then no reference, and then no wake.
    //
    // Set here rather than in the shared event-append helper on purpose: the
    // engine writes its own events during a run, so waking on EVERY event would
    // make each run schedule the next one. Which event classes deserve a wake is
    // a real question and it is carded; an OWNER ANSWER is the one case that
    // needs no argument.
    // BOTH COLUMNS, because two different guards read them and an answer has to
    // be visible to both.
    //
    // `last_event_id` is what the progression trigger hashes — without it the
    // engine never looks at the case (found live 20:10 tonight).
    //
    // `updated_at` is what the READER's staleness guard compares its packet
    // against. Found twenty minutes later, same root cause, different victim: a
    // question went out to Istvan on a case that already carried his answer,
    // because the reading was from 08:32, the answer landed at 18:10, and the
    // case row still said it had last changed two days earlier. The guard was
    // working perfectly on an input that lied.
    //
    // Setting it to the answer's own timestamp keeps the "answered and nothing
    // moved since" suppression intact — that check is `updated_at <=
    // answered_at`, and equal satisfies it.
    db.prepare(`UPDATE ${table} SET last_event_id = ?, updated_at = ? WHERE case_id = ?`)
      .run(Number(info.lastInsertRowid), now, input.caseId)

    // AND MAKE IT DUE. The two columns above make the case ELIGIBLE (the trigger
    // sees a new state); this makes it VISIBLE to the sweep, which only looks at
    // cases whose next_progression_at has come round. The heartbeat now backs a
    // quiet case off by fifteen minutes, and an answer must not sit behind that
    // backoff — an owner who answers and sees nothing happen for a quarter of an
    // hour stops answering.
    try {
      db.prepare(
        `UPDATE case_progression_state SET next_progression_at = ?, updated_at = ?
          WHERE case_id = ? AND progression_enabled = 1`,
      ).run(now, now, input.caseId)
    } catch { /* no progression table on this store: nothing to wake */ }
  }
  return { caseId: input.caseId, questionHash: open.question_hash, eventType, choice }
}


/** Which case an incoming channel message answers.
 *
 *  `{ caseId, domain }` when it is knowable, `'AMBIGUOUS'` when several
 *  questions are open and the message names none of them, `null` when nothing
 *  is open at all.
 *
 *  THE GUESS THAT USED TO LIVE HERE COST A REAL MISATTRIBUTION. On 2026-08-11 at
 *  16:40 Istvan answered about the Wizz Air invoice; the rule was "take the
 *  newest open question", the newest happened to be the NAV mailbox case, and
 *  his sentence was written onto that case. Everything downstream then treated
 *  the guess as his word — including me, who built a card on it and reported it
 *  back to him. He corrected it five hours later.
 *
 *  A wrong attribution is worse than none: the wrong case gains a decision he
 *  never made, and the right one stays open. So ambiguity is now reported, not
 *  resolved. */
// ── THE CORRELATION TOKEN ───────────────────────────────────────────────────
//
// Owner decision, 2026-09-02, after the channel stood frozen for seventeen days.
//
// WHAT ACTUALLY FROZE IT. On 2026-08-16 an answer arrived reading "Én voltam,
// rendben van". Five questions were open; the message named none of them; the
// rule correctly refused to guess, held the words and asked back. Nothing came
// back. Because an open question is never superseded to make room -- the right
// promise -- the five slots stayed occupied and no question was answered for
// seventeen days, while seventeen more queued behind them including three
// blocking decisions.
//
// So the missing piece was never the refusal. It was that the owner had no way
// to NAME a question. The token is that way: four hex characters he can type.
//
// Preference order the owner set, and the order matchAnswerTarget implements:
//   A) channel-native reply/thread binding, when the transport offers one
//   B) an explicit token
//   C) semantic attribution ONLY when exactly one question could be meant
const TOKEN_ALPHABET = /^Q[0-9A-F]{4,12}$/
const TOKEN_MIN_LEN = 4
const TOKEN_MAX_LEN = 12

/** The token a hash would produce at a given length. Deterministic, so the same
 *  row yields the same candidate on every machine and after every restart. */
export function deriveQuestionToken(questionHash: string, len = TOKEN_MIN_LEN): string {
  return `Q${questionHash.slice(0, len).toUpperCase()}`
}

/**
 * The token for this question row, assigned once and never changed.
 *
 * Collisions are resolved by LENGTHENING, and the result is persisted, because
 * a token whose length depends on what else is open would rename itself between
 * two sends -- and the owner has already copied the old one into a message.
 * Uniqueness is additionally enforced by a partial unique index, so this
 * function being wrong cannot produce two questions with one name.
 */
export function ensureQuestionToken(
  db: Database.Database, caseId: string, questionHash: string,
): string {
  const existing = db.prepare(
    `SELECT token FROM cos_owner_questions WHERE case_id = ? AND question_hash = ?`,
  ).get(caseId, questionHash) as { token: string | null } | undefined
  if (existing?.token) return existing.token

  for (let len = TOKEN_MIN_LEN; len <= TOKEN_MAX_LEN; len++) {
    const candidate = deriveQuestionToken(questionHash, len)
    const taken = db.prepare(
      `SELECT 1 FROM cos_owner_questions
        WHERE token = ? AND NOT (case_id = ? AND question_hash = ?)`,
    ).get(candidate, caseId, questionHash)
    if (taken) continue
    db.prepare(
      `UPDATE cos_owner_questions SET token = ? WHERE case_id = ? AND question_hash = ?`,
    ).run(candidate, caseId, questionHash)
    return candidate
  }
  // Twelve hex characters colliding means the hash itself repeated; that is a
  // different bug and must not be papered over with a random name.
  throw new Error(`no free token for question ${caseId}/${questionHash}`)
}

/** The line appended to every outbound question so the reply has a contract. */
export function replyContractLine(token: string): string {
  return `\n\nVálasz: ${token}: <a válaszod>`
}

/**
 * Find the token the owner named, if any.
 *
 * Deliberately strict about SHAPE (Q + 4-12 hex) and deliberately loose about
 * decoration: "Válasz: Q33DB: nem kell", "q33db - nem kell" and a bare "Q33DB"
 * all resolve. The strictness is what keeps an ordinary Hungarian sentence from
 * accidentally naming a question; the looseness is what keeps the owner from
 * having to remember a syntax at 7am.
 *
 * Returning a token is NOT the same as accepting it: the caller still has to
 * find a row with that token, so a typo fails closed rather than binding to
 * whatever was nearest.
 */
export function parseAnswerToken(text: string): string | null {
  const m = /(?:^|[^0-9A-Za-z])([Qq][0-9A-Fa-f]{4,12})(?![0-9A-Za-z])/.exec(text)
  if (!m) return null
  const token = m[1].toUpperCase()
  return TOKEN_ALPHABET.test(token) ? token : null
}

/** Tokens of the questions currently open on a channel, oldest first — the
 *  candidate list a disambiguation prompt has to offer. */
export function openQuestionTokens(
  db: Database.Database, channel: string,
): Array<{ token: string; caseId: string; domain: string; title: string | null }> {
  return db.prepare(
    `SELECT token, case_id AS caseId, domain, question_text AS title
       FROM cos_owner_questions
      WHERE channel = ? AND answered_at IS NULL AND superseded_at IS NULL
        AND token IS NOT NULL
      ORDER BY asked_at ASC`,
  ).all(channel) as never
}

export type AnswerTarget = { caseId: string; domain: string } | 'AMBIGUOUS' | null

export function matchAnswerTarget(
  db: Database.Database,
  input: { channel: string; chatId?: string; replyToMessageId?: number; text?: string },
): AnswerTarget {
  // (A) An explicit Telegram reply names the question exactly — no ambiguity to
  // resolve, however many are open.
  if (input.replyToMessageId && input.chatId) {
    const exact = db.prepare(
      `SELECT case_id AS caseId, domain FROM cos_owner_questions
        WHERE channel = ? AND channel_target = ? AND answered_at IS NULL AND superseded_at IS NULL`,
    ).get(input.channel, `${input.chatId}:${input.replyToMessageId}`) as
      { caseId: string; domain: string } | undefined
    if (exact) return exact
  }
  // (B) An explicit token. Scoped to the channel it arrived on for the same
  // reason the reply binding is: a token typed in one chat must not close a
  // question the other chat is still displaying.
  //
  // A token that matches NOTHING OPEN is not treated as "no token given" —
  // falling through to the single-open branch would let a typo answer an
  // unrelated question, which is precisely the mis-attribution this whole
  // mechanism exists to prevent. It returns AMBIGUOUS so the words are kept and
  // the owner is asked again.
  const named = input.text ? parseAnswerToken(input.text) : null
  if (named) {
    const hit = db.prepare(
      `SELECT case_id AS caseId, domain FROM cos_owner_questions
        WHERE channel = ? AND token = ? AND answered_at IS NULL AND superseded_at IS NULL`,
    ).get(input.channel, named) as { caseId: string; domain: string } | undefined
    return hit ?? 'AMBIGUOUS'
  }
  // (C) Semantic attribution, and only where it cannot be wrong: exactly one
  // question is open, so there is nothing to confuse it with.
  const open = db.prepare(
    `SELECT case_id AS caseId, domain FROM cos_owner_questions
      WHERE channel = ? AND answered_at IS NULL AND superseded_at IS NULL
      ORDER BY asked_at DESC LIMIT 2`,
  ).all(input.channel) as Array<{ caseId: string; domain: string }>
  if (open.length === 0) return null
  if (open.length === 1) return open[0]
  return 'AMBIGUOUS'
}

/**
 * An answer arrived and we could not tell which question it answers.
 *
 * THE ONE INVARIANT: this is a LOCAL data state, never a channel-wide lock. No
 * question is marked answered, no capacity slot changes, no producer stops. The
 * seventeen-day freeze happened because an attribution failure was allowed to
 * become the channel's state; recording it as a row about ONE MESSAGE is the
 * structural fix, not a nicer error message.
 *
 * The candidate tokens are frozen INTO THE ROW at the moment of the failure, so
 * a disambiguation prompt written later asks about the questions that were
 * actually open when he wrote, rather than whatever is open when somebody
 * finally looks.
 */
export function recordUnattributedResponse(
  db: Database.Database,
  input: { channel: string; chatId?: string; messageId?: number; text: string; now?: number },
): { candidateTokens: string[] } {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const candidates = openQuestionTokens(db, input.channel).map(q => q.token)
  db.prepare(
    `INSERT INTO cos_channel_held
       (channel, chat_id, message_id, text, reason, received_at, state, candidate_tokens)
     VALUES (?, ?, ?, ?, ?, ?, 'UNATTRIBUTED_RESPONSE', ?)
     ON CONFLICT (channel, message_id) DO UPDATE
       SET state = 'UNATTRIBUTED_RESPONSE',
           candidate_tokens = excluded.candidate_tokens`,
  ).run(
    input.channel, input.chatId ?? null, input.messageId ?? null, input.text,
    `valasz, de nem hozzarendelheto: ${candidates.length} nyitott kerdes, es az uzenet egyiket sem nevezte meg`,
    now, JSON.stringify(candidates),
  )
  return { candidateTokens: candidates }
}

/** The one-line ask-back for an unattributed answer. Names the tokens, so the
 *  next message can be one word plus a token. */
export function buildDisambiguationPrompt(candidateTokens: string[]): string {
  if (candidateTokens.length === 0) {
    return 'Kaptam egy valaszt, de nincs nyitott kerdes, amire vonatkozhatna. Felirtam, nem veszett el.'
  }
  return [
    'Megvan a valaszod, de nem tudom, melyik kerdesre. Nem talalgatok, mert egy rossz hozzarendeles',
    'a te szavaidat tenne egy olyan ugyre, amit nem is emlitettel.',
    `Nyitott kerdesek: ${candidateTokens.join(', ')}`,
    'Ird ujra igy: "Valasz: <TOKEN>: ..." -- a szoveged megvan, nem kell ujragepelned.',
  ].join('\n')
}

/**
 * Surface an existing open question again, under the SAME identity.
 *
 * NOT a new question: no row is created, no capacity slot is consumed, the hash
 * and the token do not move. The owner was explicit that an old question must
 * not expire but must be re-raisable, and that supersede is for a genuinely
 * changed ask — never for freeing a slot.
 */
export function restateQuestion(
  db: Database.Database,
  input: { caseId: string; questionHash: string; now?: number },
): { token: string; restateCount: number; text: string } | null {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const row = db.prepare(
    `SELECT question_text, token, restate_count FROM cos_owner_questions
      WHERE case_id = ? AND question_hash = ? AND answered_at IS NULL AND superseded_at IS NULL`,
  ).get(input.caseId, input.questionHash) as
    { question_text: string; token: string | null; restate_count: number } | undefined
  if (!row) return null
  const token = row.token ?? ensureQuestionToken(db, input.caseId, input.questionHash)
  // asked_at is NOT touched: it is when the question was first put to him, and
  // moving it would erase the age that makes a three-week-old blocking decision
  // visible as one.
  db.prepare(
    `UPDATE cos_owner_questions
        SET restated_at = ?, restate_count = restate_count + 1
      WHERE case_id = ? AND question_hash = ?`,
  ).run(now, input.caseId, input.questionHash)
  return { token, restateCount: (row.restate_count ?? 0) + 1, text: row.question_text }
}


/** Keep an owner message that could not be attributed to a case.
 *
 *  Because "held" has to mean the WORDS are kept, not just a counter. The first
 *  live firing of the ambiguity rule counted the message and let the Telegram
 *  cursor move past it, and Telegram does not re-serve an update once a higher
 *  offset is requested — so the sentence was gone. Idempotent per message. */
export function holdOwnerMessage(
  db: Database.Database,
  input: { channel: string; chatId?: string; messageId?: number; text: string; reason: string; now?: number },
): void {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO cos_channel_held (channel, chat_id, message_id, text, reason, received_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (channel, message_id) DO NOTHING`,
  ).run(input.channel, input.chatId ?? null, input.messageId ?? null, input.text, input.reason, now)
}

/** Owner messages still waiting to be placed. */
export function heldOwnerMessages(
  db: Database.Database, limit = 20,
): Array<{ heldId: number; channel: string; text: string; reason: string; receivedAt: number }> {
  try {
    return db.prepare(
      `SELECT held_id AS heldId, channel, text, reason, received_at AS receivedAt
         FROM cos_channel_held WHERE resolved_at IS NULL
         ORDER BY received_at ASC LIMIT ?`,
    ).all(limit) as never
  } catch { return [] }
}

/**
 * What to send back about a message that could not be placed (review
 * 2026-08-12, T-3).
 *
 * WHY A REPLY AND NOT JUST A ROW. `holdOwnerMessage` kept the words, which was
 * the fix for losing them — but nothing read the table, nothing set
 * `resolved_at`, and the owner got NO answer at all. From his side: he replies,
 * nothing happens, and he is not told the message was not understood. A held
 * message with no reply is the same silence as a dropped one, with a better
 * audit trail.
 *
 * WHAT THE TEXT HAS TO DO. Not apologise — hand him the one action that
 * resolves it. `matchAnswerTarget` already treats a Telegram reply-to as the
 * exact, unambiguous signal, so the follow-up quotes what he wrote and lists the
 * open questions by name: replying to one of THOSE messages lands the answer
 * without any guessing.
 *
 * Pure on purpose: it takes the rows, returns the string, and touches nothing.
 * The sending and the marking are the caller's, so a delivery failure leaves the
 * row open for the next sweep instead of marking it dealt-with.
 */
export function buildHeldFollowUp(
  held: { text: string; reason: string },
  open: Array<{ caseId: string; text: string }>,
): string {
  const quoted = held.text.length > 200 ? `${held.text.slice(0, 200)}…` : held.text
  const lines = [
    '❓ Ezt nem tudtam ügyhöz kötni:',
    `„${quoted}"`,
    '',
    `Ok: ${held.reason}`,
  ]
  if (open.length > 0) {
    lines.push('')
    // The titles are what he sees in the channel, so naming them is enough to
    // pick one. The instruction is the point: reply-to is the only signal that
    // needs no guessing, and it is the one the matcher prefers.
    lines.push('Nyitott kérdések — válaszolj közvetlenül arra az üzenetre (reply):')
    for (const q of open.slice(0, 5)) {
      lines.push(`• ${firstLine(q.text)} (${q.caseId})`)
    }
  } else {
    // Saying so matters: "I could not place it" reads very differently when
    // there is nothing open at all, and that is a different bug to report.
    lines.push('')
    lines.push('Jelenleg nincs nyitott kérdés, amihez köthetném.')
  }
  return lines.join('\n')
}

/** The question's own first line — its title as it appeared in the channel. */
function firstLine(text: string): string {
  const line = (text.split('\n')[0] ?? '').replace(/^❓\s*/, '').trim()
  return line.length > 80 ? `${line.slice(0, 80)}…` : (line || '(cím nélkül)')
}

/** Mark a held message as dealt with. Called only AFTER the reply left the
 *  machine — the other order turns one delivery failure into a lost message,
 *  which is the exact bug this whole table exists to prevent. */
export function markHeldResolved(
  db: Database.Database, heldId: number, resolution: string, now?: number,
): void {
  db.prepare(
    `UPDATE cos_channel_held SET resolved_at = ?, resolution = ?
      WHERE held_id = ? AND resolved_at IS NULL`,
  ).run(now ?? Math.floor(Date.now() / 1000), resolution, heldId)
}

/** The questions still waiting on him — so "what did it ask me?" is a query. */
/**
 * How many unanswered questions Istvan may have in front of him at once.
 *
 * Exported because a second reader now needs it — the daily digest, which has
 * to say "the channel is full" without re-typing the number. Two copies of a
 * limit drift, and then one surface reports a ceiling the other does not
 * enforce.
 */
export const MAX_OUTSTANDING_QUESTIONS = 5

export interface QuestionCapacity {
  open: number
  cap: number
  /** At or above the ceiling: NEW questions are held, not asked. */
  full: boolean
  /** The open ones, oldest first — answering ANY of them frees a slot. */
  questions: Array<{ caseId: string; text: string; askedAt: number }>
}

/**
 * The state of the owner-question channel.
 *
 * Exists because the ceiling is invisible from Istvan's side. It is measured —
 * `heldBacklogFull` has been counting held questions in the cycle telemetry all
 * along — but a measurement that never reaches the person it concerns is not
 * the same as knowing. On 2026-08-15 nineteen cases wanted to ask and could
 * not, five questions had been open for up to four days, and nothing said so
 * anywhere he looks.
 *
 * The ceiling itself is right: past a handful, one more question does not get
 * answered faster, it gets the channel muted. So the fix is not a bigger
 * ceiling or an exemption for one kind — it is that being full has to be
 * VISIBLE, with the names of what is blocking it, because answering any one of
 * them is what frees the next.
 */
/**
 * WHAT IS HELD BEHIND A FULL CHANNEL, and of what class.
 *
 * Derived from the store on every call, deliberately: a second table recording
 * "held" would be a copy of a fact the candidate query already answers, and a
 * copy is a thing that can disagree with the original. This one cannot go
 * stale, and it survives a restart for the same reason.
 *
 * The class expression is the SAME one the ask loop orders by. If those two
 * ever diverge, the report would describe a queue nobody is serving.
 */
export function heldOwnerQuestionBacklog(
  db: Database.Database, now = Math.floor(Date.now() / 1000),
): {
  total: number
  byClass: Array<{ cls: QuestionClass; count: number }>
  top: Array<{ caseId: string; cls: QuestionClass; ageSec: number }>
} {
  const empty = { total: 0, byClass: [] as Array<{ cls: QuestionClass; count: number }>, top: [] }
  let rows: Array<{ case_id: string; question_class: number; packet_at: number }> = []
  try {
    const cls = questionClassSql(approvalTablePresent(db))
    rows = db.prepare(
      `SELECT p.case_id, p.created_at AS packet_at, ${cls} AS question_class
       ${QUESTION_CANDIDATES_SQL}
       ORDER BY ${cls}, ${QUESTION_ORDER_TAIL}`,
    ).all({ now }) as never
  } catch { return empty }
  if (!rows.length) return empty
  const counts = new Map<QuestionClass, number>()
  for (const r of rows) {
    const k = QUESTION_CLASS_NAMES[r.question_class] ?? 'NORMAL'
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return {
    total: rows.length,
    byClass: QUESTION_CLASS_NAMES.filter(c => counts.has(c)).map(c => ({ cls: c, count: counts.get(c)! })),
    top: rows.slice(0, 3).map(r => ({
      caseId: r.case_id,
      cls: QUESTION_CLASS_NAMES[r.question_class] ?? 'NORMAL',
      ageSec: Math.max(0, now - r.packet_at),
    })),
  }
}

export function ownerQuestionCapacity(db: Database.Database): QuestionCapacity {
  const questions = outstandingOwnerQuestions(db, MAX_OUTSTANDING_QUESTIONS * 4)
    .map(q => ({ caseId: q.caseId, text: q.text, askedAt: q.askedAt }))
    .sort((a, b) => a.askedAt - b.askedAt)
  return {
    open: questions.length, cap: MAX_OUTSTANDING_QUESTIONS,
    full: questions.length >= MAX_OUTSTANDING_QUESTIONS, questions,
  }
}

export function outstandingOwnerQuestions(
  db: Database.Database, limit = 20,
): Array<{ caseId: string; domain: string; text: string; askedAt: number }> {
  try {
    return db.prepare(
      // STALE-BLOCKED QUESTIONS DO NOT COUNT (owner directive 2026-09-02).
      // One that delivery refuses cannot be answered, so a seat held for it
      // starves the questions that CAN be -- the second freeze, measured on
      // three blocking decisions that sat undeliverable while the cap read
      // full. See stale-question-regeneration.ts.
      `SELECT case_id AS caseId, domain, question_text AS text, asked_at AS askedAt
       FROM cos_owner_questions WHERE ${COUNTS_AGAINST_CAP_SQL}
       ORDER BY asked_at DESC LIMIT ?`,
    ).all(limit) as never
  } catch { return [] }
}
