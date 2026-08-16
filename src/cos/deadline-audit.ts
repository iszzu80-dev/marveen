// Personal Chief of Staff (COS) — deadlines that exist only as prose.
//
// 2026-08-16, measured on the live store after a near miss. Two car rentals ran
// for the same 08-18 10:00 pickup, and both cases carried this as their next
// action, verbatim:
//
//     "DONTES 2026-08-16 10:00 elott: Hertz VAGY Sixt"
//
// The deadline was today at 10:00. Every date-driven surface missed it, because
// what they read was `due_at` = 2026-08-18 (the PICKUP) and `follow_up_at` =
// yesterday. The morning digest, which lists what expires soon, never mentioned
// it. Istvan happened to decide in time on his own; nobody warned him.
//
// A DEADLINE THAT LIVES IN PROSE IS NOT A DEADLINE, IT IS A NOTE. The store had
// the fact and no gate looked at it — the same shape as the empty
// `parent_case_id` and `calendar_event_ids` columns found the same day, only
// inverted: here the data exists and sits in the wrong TYPE.
//
// WHAT THIS MODULE IS, AND WHAT IT REFUSES TO BE
//
// It is a DETECTOR, not a parser. It never extracts a date and never acts on
// one: reading "2026-08-16 10:00" out of a sentence and turning it into a field
// would be exactly the "infer a class from one sample" mistake this project
// logged twice in two days. It answers one question instead:
//
//     Does this case TALK about a deadline while carrying NO date at all?
//
// That question is answerable without understanding the sentence, and its
// answer is never itself a judgement — it is a request to look. The fix is
// always a human or an agent putting a real timestamp in a real column.
//
// Cases that talk about a deadline AND carry some date are deliberately NOT
// reported. They may still be wrong (today's pair was: the date they carried
// was the wrong one), but flagging all of them would report six cases every ten
// minutes forever, and a detector that cries constantly is one that gets muted.
// Narrow and silent beats broad and ignored.

import type Database from 'better-sqlite3'

/** Words that make a sentence sound like it names a moment. Hungarian and
 *  English both, because next_action is written in either. This list decides
 *  only whether to LOOK at a case, never what to do about it. */
const DEADLINE_HINTS = [
  'hatarido', 'határidő', 'hataridő', 'határido',
  'dontes', 'döntés', 'lejar', 'lejár',
  'elott', 'előtt', 'deadline', 'expires', 'due by',
]

/** An ISO date, or a Hungarian day-month like "08-16" / "aug. 16". */
const DATE_LIKE = /\b(20\d\d-\d{2}-\d{2}|\d{1,2}-\d{1,2}\b|\b(jan|feb|már|marc|ápr|apr|máj|maj|jún|jun|júl|jul|aug|szep|okt|nov|dec)\w*\.?\s*\d{1,2})/i

export interface ProseDeadlineCase {
  caseId: string
  title: string
  status: string
  /** The sentence that made this case suspicious. Reported verbatim: the
   *  reader must be able to judge the detector, not just trust it. */
  quote: string
}

export interface DeadlineAuditResult {
  /** Open cases whose next action sounds like it names a deadline while the
   *  case carries no due/follow-up/wake timestamp at all. */
  proseOnly: ProseDeadlineCase[]
  /** How many open cases were examined, so a zero can be read. */
  examined: number
}

const OPEN = `status NOT IN ('COMPLETED','CANCELLED','ARCHIVED') AND archived_at IS NULL`

function soundsLikeDeadline(text: string): boolean {
  const t = text.toLowerCase()
  if (!DEADLINE_HINTS.some((h) => t.includes(h))) return false
  return DATE_LIKE.test(text)
}

/**
 * Find open cases whose deadline exists only in prose.
 *
 * `table` is a parameter so the ZST namespace gets the same audit; the two
 * stores never mix, and a check that only covered the personal one would leave
 * the company side with the failure mode we just proved is expensive.
 */
export function auditProseDeadlines(
  db: Database.Database,
  table: 'personal_cases' | 'zst_cases' = 'personal_cases',
): DeadlineAuditResult {
  const rows = db.prepare(
    `SELECT case_id, title, status, coalesce(next_action,'') AS next_action,
            due_at, follow_up_at, next_wake_at
     FROM ${table} WHERE ${OPEN}`
  ).all() as Array<{
    case_id: string; title: string; status: string; next_action: string
    due_at: number | null; follow_up_at: number | null; next_wake_at: number | null
  }>

  const proseOnly: ProseDeadlineCase[] = []
  for (const r of rows) {
    if (r.due_at !== null || r.follow_up_at !== null || r.next_wake_at !== null) continue
    if (!soundsLikeDeadline(r.next_action)) continue
    proseOnly.push({
      caseId: r.case_id,
      title: r.title,
      status: r.status,
      quote: r.next_action.trim().slice(0, 200),
    })
  }
  return { proseOnly, examined: rows.length }
}

/** One line per finding, plus an explicit zero. A run that prints nothing when
 *  it finds nothing is indistinguishable from a run that did not happen. */
export function describeDeadlineAudit(r: DeadlineAuditResult): string[] {
  if (r.proseOnly.length === 0) {
    return [`${r.examined} nyitott ügy átnézve, egyikben sincs csak-prózában élő határidő`]
  }
  return r.proseOnly.map(
    (c) => `${c.caseId} (${c.status}): határidőt említ, de egyetlen dátum-mezője sincs kitöltve — "${c.quote}"`
  )
}
