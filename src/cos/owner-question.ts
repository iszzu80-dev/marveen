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
import type { ReaderEvidencePacket } from './reader.js'
import type { EvidencePlan } from './evidence-planner.js'

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
    .filter(s => s.kind === 'ASK_OWNER' || (s.blockedBy ?? '').toUpperCase() === 'ISTVAN')
    .map(s => s.label)
}

/**
 * Compose the question, or return null when there is nothing to ask.
 *
 * Null is the common case and must stay cheap: a case waiting on an external
 * party is not a case with a question for Istvan, and asking him anyway is how
 * a notification channel becomes noise and then becomes muted.
 */
export function buildOwnerQuestion(
  input: { caseId: string; domain: string; title: string; packet: ReaderEvidencePacket; plan: EvidencePlan },
): OwnerQuestion | null {
  const steps = ownerSteps(input.plan)
  const ballIsHis = input.packet.ballHolder === 'ISTVAN'
  if (steps.length === 0 && !ballIsHis) return null

  const missingFromHim = input.packet.missingRequirements
    .filter(m => m.whoHasIt.toUpperCase().includes('ISTVAN'))
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
  lines.push(...asks)

  if (input.packet.uncertainty.length > 0) {
    lines.push('')
    lines.push(`Bizonytalanság: ${input.packet.uncertainty.slice(0, 2).join('; ')}`)
  }
  lines.push('')
  lines.push(`(ügy: ${input.caseId} · magabiztosság: ${input.packet.confidence})`)

  const text = lines.join('\n')
  // The hash covers WHAT IS ASKED, not the whole packet: a new fact that does
  // not change the ask must not re-ask.
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
  /** Questions suppressed because the same ask is already outstanding. */
  alreadyAsked: number
  /** Cases read this pass with nothing to ask the owner. */
  nothingToAsk: number
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
export function askPendingOwnerQuestions(
  db: Database.Database,
  opts: { limit?: number; now?: number; maxOutstanding?: number } = {},
): AskResult {
  const limit = opts.limit ?? 2
  // A GLOBAL cap on unanswered questions, on top of the per-sweep bound.
  //
  // The per-sweep bound alone allows two an hour to become twelve: six sweeps,
  // two each, nobody answering. The thing that actually protects the channel is
  // not the rate, it is the size of the pile waiting on him — past a handful,
  // one more question does not get answered faster, it gets the channel muted.
  const maxOutstanding = opts.maxOutstanding ?? 5
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const result: AskResult = {
    asked: 0, alreadyAsked: 0, nothingToAsk: 0, heldBacklogFull: 0,
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

  let rows: Array<{ case_id: string; domain: string; packet_json: string; plan_json: string }> = []
  try {
    rows = db.prepare(
      `SELECT p.case_id, p.domain, p.packet_json, p.plan_json
       FROM case_evidence_packets p
       JOIN (
         SELECT case_id, MAX(created_at) AS created_at
         FROM case_evidence_packets WHERE packet_json IS NOT NULL GROUP BY case_id
       ) latest ON latest.case_id = p.case_id AND latest.created_at = p.created_at
       WHERE p.packet_json IS NOT NULL AND p.plan_json IS NOT NULL
         -- A finished case has no open question. Live 2026-08-11: a COMPLETED
         -- rental case produced one anyway, because this query only ever looked
         -- at packets and never at the case behind them.
         AND NOT EXISTS (
           SELECT 1 FROM personal_cases pc WHERE pc.case_id = p.case_id
             AND (pc.status IN ('COMPLETED','CANCELLED','ARCHIVED') OR pc.archived_at IS NOT NULL))
         AND NOT EXISTS (
           SELECT 1 FROM zst_cases zc WHERE zc.case_id = p.case_id
             AND (zc.status IN ('COMPLETED','CANCELLED','ARCHIVED') OR zc.archived_at IS NOT NULL))
       ORDER BY p.created_at DESC LIMIT 50`,
    ).all() as never
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

    const title = caseTitle(db, row.domain, row.case_id) ?? row.case_id
    const question = buildOwnerQuestion({
      caseId: row.case_id, domain: row.domain, title, packet, plan,
    })
    if (!question) { result.nothingToAsk++; continue }
    if (isHandled(db, row.case_id, row.domain, question.hash)) { result.alreadyAsked++; continue }
    // A REPLACEMENT is not an addition. When this case already has an open
    // question, asking the reworded one supersedes it — the pile waiting on him
    // does not grow, so the ceiling has nothing to protect against here.
    // Counting it would let a full queue block the very rewrite that makes a bad
    // question answerable, which is the opposite of what the ceiling is for.
    const replacesOwn = hasOtherOpenQuestion(db, row.case_id, question.hash)
    if (!replacesOwn && outstanding + netAdded >= maxOutstanding) { result.heldBacklogFull++; continue }

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
    db.prepare(
      `UPDATE cos_owner_questions SET superseded_at = ?
        WHERE case_id = ? AND question_hash != ? AND answered_at IS NULL AND superseded_at IS NULL`,
    ).run(now, row.case_id, question.hash)

    db.prepare(
      `INSERT INTO cos_owner_questions (case_id, domain, question_hash, question_text, asked_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (case_id, question_hash) DO UPDATE
         SET asked_at = excluded.asked_at, question_text = excluded.question_text,
             answered_at = NULL, answer_text = NULL, superseded_at = NULL`,
    ).run(row.case_id, row.domain, question.hash, question.text, now)

    createAgentMessage('cos-reader', 'marveen', question.text, 'cos-owner-question')
    appendDailyLog('marveen', `## COS kerdes Istvannak\n${question.text}`)
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

const YES = /^\s*(igen|ok(é|e)?|rendben|jó|jo|persze|mehet|yes|y)\b/i
const NO = /^\s*(nem|ne|elutasít|elutasit|no|n)\b/i

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
  input: { caseId: string; domain: string; text: string; now?: number },
): RecordedAnswer | null {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const open = db.prepare(
    `SELECT question_hash FROM cos_owner_questions
     WHERE case_id = ? AND answered_at IS NULL AND superseded_at IS NULL
     ORDER BY asked_at DESC LIMIT 1`,
  ).get(input.caseId) as { question_hash: string } | undefined
  if (!open) return null

  const choice: 'YES' | 'NO' | null = YES.test(input.text) ? 'YES' : (NO.test(input.text) ? 'NO' : null)
  const eventType = choice ? 'OWNER_DECISION' : 'OWNER_INFORMATION'

  db.prepare(
    `UPDATE cos_owner_questions SET answered_at = ?, answer_text = ?
     WHERE case_id = ? AND question_hash = ?`,
  ).run(now, input.text, input.caseId, open.question_hash)

  const table = input.domain === 'zst' ? 'zst_cases' : 'personal_cases'
  const row = db.prepare(`SELECT version FROM ${table} WHERE case_id = ?`).get(input.caseId) as
    { version: number } | undefined
  if (row) {
    const events = input.domain === 'zst' ? 'zst_case_events' : 'personal_case_events'
    db.prepare(
      `INSERT INTO ${events} (case_id, case_version, actor, event_type, reason, payload, source_system, created_at)
       VALUES (?, ?, 'istvan', ?, ?, ?, 'telegram', ?)`,
    ).run(
      input.caseId, row.version, eventType,
      input.text.slice(0, 500),
      JSON.stringify({ choice, answer: input.text, question_hash: open.question_hash }),
      now,
    )
  }
  return { caseId: input.caseId, questionHash: open.question_hash, eventType, choice }
}

/** The questions still waiting on him — so "what did it ask me?" is a query. */
export function outstandingOwnerQuestions(
  db: Database.Database, limit = 20,
): Array<{ caseId: string; domain: string; text: string; askedAt: number }> {
  try {
    return db.prepare(
      `SELECT case_id AS caseId, domain, question_text AS text, asked_at AS askedAt
       FROM cos_owner_questions WHERE answered_at IS NULL AND superseded_at IS NULL
       ORDER BY asked_at DESC LIMIT ?`,
    ).all(limit) as never
  } catch { return [] }
}
