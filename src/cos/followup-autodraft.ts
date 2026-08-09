// Personal Chief of Staff (COS) — drafting a follow-up without being asked.
//
// Owner decision, 2026-08-10, option C. Presented as three:
//   A — the system only writes when Istvan asks.
//   B — the system offers a draft for anything it thinks needs one.
//   C — the system writes ONLY to continue a conversation that already exists,
//       where the ball is with the other side and the deadline has passed.
// He chose C, and the restriction is the whole design: a first approach to
// somebody new is never composed on the system's initiative.
//
// Why C is the safe one, stated plainly because the code enforces it: the risk
// of B is not that the system writes something wrong — a wrong draft is visible,
// the text is right there. The risk is VOLUME. An approval box that fills up
// every morning turns into a queue of yes-clicks, and at that point the owner's
// approval has stopped being a decision. C keeps the box small by construction.
//
// This module only decides WHETHER and drafts WHAT. Nothing here sends; the
// draft lands in the approval door like any other, and Istvan releases it.

import type Database from 'better-sqlite3'

export interface FollowUpCandidate {
  caseId: string
  title: string
  /** The counterparty we are already corresponding with. */
  recipient: string
  threadId: string
  waitingSinceDays: number
  lastSubject: string
}

export interface EligibilityResult {
  eligible: boolean
  /** Machine-readable refusal, so a "no" can be inspected rather than guessed. */
  code: 'ok' | 'no_prior_conversation' | 'ball_not_with_them' | 'not_overdue'
    | 'already_drafted' | 'too_many_followups' | 'case_not_waiting'
  reason: string
}

/** Days past the follow-up date before a nudge is warranted. */
export const OVERDUE_GRACE_DAYS = 2
/** How many follow-ups this system will compose on its own for one case. */
export const MAX_AUTO_FOLLOWUPS = 2

const DAY = 86400

interface CaseRow {
  case_id: string
  title: string
  status: string
  waiting_on: string | null
  next_action_owner: string | null
  follow_up_at: number | null
  gmail_thread_ids: string | null
}

/**
 * May the system compose a follow-up for this case on its own?
 *
 * Every refusal below is a different way option B would have gone wrong, so
 * they are checked separately and named separately.
 */
export function followUpEligibility(
  db: Database.Database, caseId: string, now: number,
): EligibilityResult {
  const c = db.prepare(
    `SELECT case_id, title, status, waiting_on, next_action_owner, follow_up_at, gmail_thread_ids
     FROM personal_cases WHERE case_id = ?`
  ).get(caseId) as CaseRow | undefined
  if (!c) return { eligible: false, code: 'case_not_waiting', reason: `nincs ilyen ügy: ${caseId}` }

  // C's core restriction: an existing conversation, or nothing.
  if (!c.gmail_thread_ids) {
    return { eligible: false, code: 'no_prior_conversation',
      reason: 'nincs korábbi levelezés — első megkeresést a rendszer sosem fogalmaz magától' }
  }
  if (c.status !== 'WAITING_EXTERNAL' && c.status !== 'FOLLOW_UP_DUE') {
    return { eligible: false, code: 'case_not_waiting', reason: `az ügy ${c.status}, nem külső válaszra vár` }
  }
  // The ball must be with them. If it is with Istvan, a nudge to the other side
  // is not just useless, it is embarrassing.
  const owner = (c.next_action_owner ?? '').toLowerCase()
  if (owner === 'istván' || owner === 'istvan' || owner === 'marveen') {
    return { eligible: false, code: 'ball_not_with_them', reason: `a labda nálad van (${c.next_action_owner})` }
  }
  if (c.follow_up_at === null || c.follow_up_at > now - OVERDUE_GRACE_DAYS * DAY) {
    return { eligible: false, code: 'not_overdue',
      reason: c.follow_up_at === null ? 'nincs utánkövetési dátum' : 'még nem járt le a türelmi idő' }
  }

  // Never draft a second copy of something already waiting for a decision.
  const pending = db.prepare(
    `SELECT COUNT(*) AS n FROM outbound_ledger WHERE case_id = ? AND status = 'PLANNED'`
  ).get(caseId) as { n: number }
  if (pending.n > 0) {
    return { eligible: false, code: 'already_drafted', reason: 'már vár egy piszkozat a jóváhagyásodra' }
  }

  // And stop nagging. After two automatic nudges the problem is not the
  // wording, and a third letter is the system talking to itself.
  const sent = db.prepare(
    `SELECT COUNT(*) AS n FROM outbound_ledger
     WHERE case_id = ? AND outbound_kind = 'FOLLOW_UP' AND status NOT IN ('CANCELLED','FAILED_TERMINAL')`
  ).get(caseId) as { n: number }
  if (sent.n >= MAX_AUTO_FOLLOWUPS) {
    return { eligible: false, code: 'too_many_followups',
      reason: `${sent.n} utánkövetés már elment — a következő lépés nem egy újabb levél` }
  }

  return { eligible: true, code: 'ok', reason: 'futó levelezés, náluk a labda, lejárt a határidő' }
}

export interface DraftedFollowUp {
  subject: string
  body: string
}

/**
 * Compose the follow-up.
 *
 * Deliberately a typed template, not free text. §3.3 allows autonomous send only
 * from a typed template, and while this draft still needs Istvan's click, the
 * same reasoning applies to what the system writes unprompted: a generated
 * paragraph that he skims and approves is exactly how something he did not mean
 * ends up over his name.
 */
export function draftFollowUp(c: FollowUpCandidate): DraftedFollowUp {
  const subject = c.lastSubject.startsWith('Re:') ? c.lastSubject : `Re: ${c.lastSubject}`
  const body = [
    'Tisztelt Címzett!',
    '',
    `A korábbi levelemre még nem kaptam választ, ezért szeretnék rákérdezni: hol tart az ügy?`,
    '',
    `Az ügy: ${c.title}`,
    `A megkeresés óta eltelt: ${c.waitingSinceDays} nap`,
    '',
    'Ha bármilyen adat hiányzik hozzá tőlem, kérem jelezzék.',
    '',
    'Köszönettel,',
    'Szabó István',
  ].join('\n')
  return { subject, body }
}

/** Cases the system may draft a follow-up for right now, with the reasons for
 *  everything it left alone — a sweep that reports only what it did is
 *  indistinguishable from one that looked at nothing. */
export function sweepFollowUpCandidates(
  db: Database.Database, now: number, limit = 10,
): { eligible: Array<FollowUpCandidate>; skipped: Array<{ caseId: string; code: string; reason: string }> } {
  const rows = db.prepare(
    `SELECT case_id, title, status, waiting_on, next_action_owner, follow_up_at, gmail_thread_ids
     FROM personal_cases
     WHERE archived_at IS NULL AND status IN ('WAITING_EXTERNAL','FOLLOW_UP_DUE')
     ORDER BY follow_up_at LIMIT ?`
  ).all(limit * 3) as CaseRow[]

  const eligible: FollowUpCandidate[] = []
  const skipped: Array<{ caseId: string; code: string; reason: string }> = []
  for (const r of rows) {
    const e = followUpEligibility(db, r.case_id, now)
    if (!e.eligible) { skipped.push({ caseId: r.case_id, code: e.code, reason: e.reason }); continue }
    const thread = (() => { try { return (JSON.parse(r.gmail_thread_ids ?? '[]') as string[])[0] } catch { return undefined } })()
    const recipient = (r.waiting_on ?? '').match(/[\w.+-]+@[\w.-]+/)?.[0]
    if (!thread || !recipient) {
      // The address must come from the case, never be inferred. A follow-up sent
      // to a guessed address is a new first contact, which is exactly what C
      // forbids.
      skipped.push({ caseId: r.case_id, code: 'no_prior_conversation',
        reason: 'nincs egyértelmű címzett vagy szál az ügyön' })
      continue
    }
    eligible.push({
      caseId: r.case_id, title: r.title, recipient, threadId: thread,
      waitingSinceDays: Math.floor((now - (r.follow_up_at ?? now)) / DAY),
      lastSubject: r.title,
    })
    if (eligible.length >= limit) break
  }
  return { eligible, skipped }
}
