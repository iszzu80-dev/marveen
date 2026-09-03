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
import { caseThreadIds } from './case-sources.js'

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
  created_at?: number | null
  /** Last outbound send on this case — the actual "inquiry" the letter refers to. */
  last_sent_at?: number | null
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
  //
  // GRAPH CUTOVER, 2026-09-03: asked of the case-source graph, not of the
  // `gmail_thread_ids` column. A case whose threads live only in the graph
  // (every Sheet-migrated case, including the whole pool investigation) used to
  // fail this test and be refused a follow-up for "no prior correspondence",
  // while carrying up to eleven threads of it.
  if (caseThreadIds(db, 'personal', caseId).threadIds.length === 0) {
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
  // Case-insensitive: a subject already carrying "RE:" or "re:" was getting a
  // second prefix, so a follow-up on a follow-up read "Re: RE: …".
  const subject = /^re:/i.test(c.lastSubject.trim()) ? c.lastSubject : `Re: ${c.lastSubject}`
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

/** WHICH THREAD DOES A FOLLOW-UP GO INTO, now that a case can have several.
 *
 *  Until the graph existed this was `gmail_thread_ids[0]` -- defensible only
 *  because the column never held a second element. It does now, so element zero
 *  is an arbitrary choice with a real cost: a nudge delivered into the wrong
 *  thread reads, to the person receiving it, as a letter about a different
 *  matter entirely.
 *
 *  The rule is "where the conversation actually is": the thread with the most
 *  recent known message, counting both what we ingested (`email_processing`)
 *  and what we sent (`outbound_ledger.thread_ref`). One thread needs no
 *  tie-break. Several threads with nothing to separate them is NOT resolved by
 *  picking one -- it is reported as ambiguous and skipped, because a wrong
 *  choice here is worse than no letter. */
export function pickReplyThread(
  db: Database.Database, caseId: string,
): { threadId?: string; code?: string; reason?: string } {
  const threads = caseThreadIds(db, 'personal', caseId).threadIds
  if (threads.length === 0) {
    return { code: 'no_prior_conversation', reason: 'nincs egyértelmű címzett vagy szál az ügyön' }
  }
  if (threads.length === 1) return { threadId: threads[0] }

  const lastActivity = (threadId: string): number | null => {
    const inbound = db.prepare(
      `SELECT MAX(created_at) AS t FROM email_processing WHERE thread_id = ?`,
    ).get(threadId) as { t: number | null }
    let outbound: { t: number | null } = { t: null }
    try {
      outbound = db.prepare(
        `SELECT MAX(COALESCE(applied_at, created_at)) AS t FROM outbound_ledger WHERE thread_ref = ?`,
      ).get(threadId) as { t: number | null }
    } catch { /* the ledger is optional on a fresh store */ }
    const vals = [inbound?.t, outbound?.t].filter((v): v is number => typeof v === 'number')
    return vals.length ? Math.max(...vals) : null
  }

  const scored = threads.map((t) => ({ t, at: lastActivity(t) }))
    .filter((x): x is { t: string; at: number } => x.at !== null)
    .sort((a, b) => b.at - a.at)

  if (scored.length === 0) {
    return { code: 'ambiguous_thread',
      reason: `${threads.length} szál tartozik az ügyhöz és egyikről sincs helyben ismert üzenet — nem találgatunk, melyikbe menjen a levél` }
  }
  if (scored.length > 1 && scored[0].at === scored[1].at) {
    return { code: 'ambiguous_thread',
      reason: `${scored.length} szálon ugyanakkor volt az utolsó ismert üzenet — nem dönthető el, melyikben folyik a beszélgetés` }
  }
  return { threadId: scored[0].t }
}

/** Cases the system may draft a follow-up for right now, with the reasons for
 *  everything it left alone — a sweep that reports only what it did is
 *  indistinguishable from one that looked at nothing. */
export function sweepFollowUpCandidates(
  db: Database.Database, now: number, limit = 10,
): { eligible: Array<FollowUpCandidate>; skipped: Array<{ caseId: string; code: string; reason: string }> } {
  // The scan window is bounded so one sweep cannot walk the whole store, but a
  // bound nobody reports is a silent truncation: cases past it were never
  // considered and nothing said so. One extra row is fetched purely to detect
  // that the window was full, and the exhaustion is reported as a skip.
  const scanWindow = limit * 3
  const rows = db.prepare(
    `SELECT c.case_id, c.title, c.status, c.waiting_on, c.next_action_owner,
            c.follow_up_at, c.gmail_thread_ids, c.created_at,
            (SELECT MAX(COALESCE(l.applied_at, l.created_at))
               FROM outbound_ledger l
              WHERE l.case_id = c.case_id
                AND l.status IN ('VERIFIED','APPLIED_UNVERIFIED')) AS last_sent_at
     FROM personal_cases c
     WHERE c.archived_at IS NULL AND c.status IN ('WAITING_EXTERNAL','FOLLOW_UP_DUE')
     ORDER BY c.follow_up_at LIMIT ?`
  ).all(scanWindow + 1) as CaseRow[]

  const eligible: FollowUpCandidate[] = []
  const skipped: Array<{ caseId: string; code: string; reason: string }> = []
  for (const r of rows) {
    const e = followUpEligibility(db, r.case_id, now)
    if (!e.eligible) { skipped.push({ caseId: r.case_id, code: e.code, reason: e.reason }); continue }
    const pick = pickReplyThread(db, r.case_id)
    const recipient = (r.waiting_on ?? '').match(/[\w.+-]+@[\w.-]+/)?.[0]
    if (!pick.threadId || !recipient) {
      // The address must come from the case, never be inferred. A follow-up sent
      // to a guessed address is a new first contact, which is exactly what C
      // forbids.
      //
      // And a case with SEVERAL threads and no way to tell which one the
      // counterparty is in is not a case to guess about: `pickReplyThread`
      // returns no thread and says why, rather than taking element zero. A
      // follow-up in the wrong thread reads, to the recipient, as a letter
      // about something else.
      skipped.push({ caseId: r.case_id, code: pick.code ?? 'no_prior_conversation',
        reason: pick.reason ?? 'nincs egyértelmű címzett vagy szál az ügyön' })
      continue
    }
    const thread = pick.threadId
    eligible.push({
      caseId: r.case_id, title: r.title, recipient, threadId: thread,
      // The letter tells a REAL counterparty how long it has been since the
      // inquiry, so the number has to be that. It used to be measured from
      // follow_up_at — the moment the follow-up became DUE, typically days
      // after the inquiry itself — and the letter stated it as "days since the
      // inquiry". A wrong number in a letter over Istvan's name is not a
      // rounding issue. Measured from the last send on the case, or from when
      // the case opened if nothing was ever sent from here.
      waitingSinceDays: Math.floor((now - (r.last_sent_at ?? r.created_at ?? now)) / DAY),
      lastSubject: r.title,
    })
    if (eligible.length >= limit) break
  }
  if (rows.length > scanWindow) {
    skipped.push({
      caseId: '—', code: 'scan_window_exhausted',
      reason: `a vizsgált ablak (${scanWindow} ügy) betelt — a határidő szerint hátrébb lévő ügyeket ez a futás nem nézte meg`,
    })
  }
  return { eligible, skipped }
}
