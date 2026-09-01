// PHASE 3 (P3-C) -- THE KANBAN IS A DERIVED HUMAN-ACTION VIEW, AND NOTHING ELSE.
//
// Owner ruling 2026-09-01: "A kezemet / donteset igenylo ugyek kerudjenek ki a
// Kanbanra. De a Kanban kizarolag DERIVED HUMAN-ACTION VIEW. Nem lehet canonical
// case source of truth; completion authority; action authorization; automatikus
// business-state valtozas forrasa. Egyiranyu projectionkent induljon."
//
// WHAT "ONE-WAY" MEANS HERE, CONCRETELY. This module contains no statement that
// writes to `personal_cases` or `zst_cases`, and no read of `kanban_cards.status`
// that feeds a case. Move a projected card to done and the case does not move;
// the next refresh will find the need still open and say so. The board is a
// window, and a window is not a lever.
//
// WHAT COUNTS AS A HUMAN-ACTION NEED, and why the list is short. Only two of the
// five case-attention reasons say the OWNER is the one who has to move:
//
//   USER_ACTION_REQUIRED        the record's own status says a selection, an
//                               approval or a fact only they hold is missing
//   AUTHORITATIVE_NOTICE_UNREAD a named authority sent a document and only the
//                               owner can collect it
//
// The other three are not his hands. EXPLICIT_DEADLINE_PASSED is a date that
// went by and may be anyone's work; BLOCKED_EXTERNAL_DEPENDENCY is somebody
// else's move; STALE_UNRESOLVED is a prompt to the engine, not to a person. A
// board that carried all five would be the case list again, and a board that is
// the case list is not a to-do list.
//
// THE BRIDGE CANNOT MINT URGENCY. It maps to `high` at the most, never `urgent`.
// Urgency on this board is a signal Istvan sets; a projection that could raise
// its own priority would inflate the label until it stopped meaning anything,
// which has happened here before.
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { projectCaseAttention, type CaseAttention, type CaseAttentionReason } from './intelligence/case-attention.js'

/** The reasons that mean "only the owner can move this". See the header. */
export const HUMAN_ACTION_REASONS: readonly CaseAttentionReason[] = Object.freeze([
  'USER_ACTION_REQUIRED', 'AUTHORITATIVE_NOTICE_UNREAD',
])

export const PROJECT_LABEL: Record<'personal' | 'zst', string> = {
  personal: 'CoS szemelyes', zst: 'CoS ZST',
}

/** Deterministic, so a re-run finds its own card instead of making a second one
 *  -- dedupe holds even if the index table were lost entirely. */
export function cardIdFor(namespace: string, caseId: string): string {
  return createHash('sha256').update(`cos-human-action:${namespace}:${caseId}`).digest('hex').slice(0, 8)
}

export interface HumanActionNeed {
  namespace: 'personal' | 'zst'
  caseId: string
  reason: CaseAttentionReason
  title: string
  whyHumanNeeded: string
  caseState: string
  /** ONLY a date the record actually states. A projected card never carries a
   *  due date the engine invented -- the owner asked for "due date csak ha
   *  provenance-olt", and `due_at` is the one field that is provenanced. */
  dueAt: number | null
  provenance: string
}

interface CaseRow {
  case_id: string
  title: string | null
  status: string
  due_at: number | null
}

/**
 * Derive the needs. Read-only, and the namespaces never meet: a personal case
 * cannot reach a ZST board row, because each call is given one table and one
 * label and is never handed both.
 */
export function humanActionNeeds(
  db: Database.Database, namespace: 'personal' | 'zst', now: number,
): HumanActionNeed[] {
  const table = namespace === 'personal' ? 'personal_cases' : 'zst_cases'
  const attention: CaseAttention[] = projectCaseAttention(db, namespace, now)
  const wanted = attention.filter((a) => HUMAN_ACTION_REASONS.includes(a.reason))
  if (!wanted.length) return []

  const rows = new Map(
    (db.prepare(
      `SELECT case_id, title, status, due_at FROM ${table} WHERE archived_at IS NULL`,
    ).all() as CaseRow[]).map((r) => [r.case_id, r]),
  )

  const out: HumanActionNeed[] = []
  for (const a of wanted) {
    const row = rows.get(a.caseId)
    if (!row) continue
    out.push({
      namespace,
      caseId: a.caseId,
      reason: a.reason,
      title: (row.title?.trim() || a.caseId).slice(0, 120),
      whyHumanNeeded: a.statement,
      caseState: row.status,
      dueAt: row.due_at ?? null,
      provenance: a.provenance?.map((p) => `${p.source}:${p.field ?? ''}`).join(', ') || 'CASE',
    })
  }
  // Deterministic order, so two runs over an unchanged store do the same things
  // in the same sequence.
  return out.sort((x, y) => (x.caseId < y.caseId ? -1 : x.caseId > y.caseId ? 1 : 0))
}

/** `high` for an uncollected authority document, `normal` for everything else.
 *  Never `urgent` -- see the header. */
export function priorityFor(need: HumanActionNeed, now: number): 'normal' | 'high' {
  if (need.reason === 'AUTHORITATIVE_NOTICE_UNREAD') return 'high'
  if (need.dueAt != null && need.dueAt < now) return 'high'
  return 'normal'
}

const REASON_TEXT: Record<string, string> = {
  USER_ACTION_REQUIRED: 'Csak te tudod mozditani: valasztas, jovahagyas vagy nalad levo teny hianyzik.',
  AUTHORITATIVE_NOTICE_UNREAD: 'Hatosagi irat erkezett, es nincs bizonyitek arra, hogy atvetted.',
}

/** The card body. Every one of the owner's minimum fields appears, and the
 *  header line says what the card IS -- a reader who never saw this design must
 *  not be able to mistake it for the case. */
export function describeCard(need: HumanActionNeed, refreshedAt: number): string {
  const iso = (t: number) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16)
  return [
    'SZARMAZTATOTT NEZET (CoS human-action projection). Ez a kartya nem az ugy',
    'igazsaga: nem zar le ugyet, nem hagy jova semmit, es a mozgatasa a CoS-ben',
    'semmit nem valtoztat. Az ugy allapotat a CoS tartja.',
    '',
    `Ugy: ${need.caseId}`,
    `Nevter: ${need.namespace}`,
    `Miert kell ember: ${REASON_TEXT[need.reason] ?? need.reason}`,
    `Az ugy sajat mondata: ${need.whyHumanNeeded}`,
    `Az ugy allapota most: ${need.caseState}`,
    `Hatarido: ${need.dueAt != null ? iso(need.dueAt) : 'nincs provenance-olt hatarido'}`,
    `Forras: ${need.provenance}`,
    `Utoljara frissitve: ${iso(refreshedAt)}`,
  ].join('\n')
}

export interface ProjectionRow {
  namespace: string
  case_id: string
  card_id: string
  reason: string
  first_projected_at: number
  last_refreshed_at: number
  closed_at: number | null
  close_reason: string | null
}

export interface SyncResult {
  namespace: 'personal' | 'zst'
  needs: number
  created: number
  refreshed: number
  closed: number
  /** A deterministic card id already existed and this bridge does not own it.
   *  Refused rather than overwritten: a human's card is not ours to reuse. */
  refusedForeign: string[]
  /** Cards this bridge owns that a person has moved. Reported, never acted on --
   *  the board is not a completion authority. */
  movedByHuman: string[]
}

/**
 * One namespace, one pass. Creates what is new, refreshes what still stands,
 * closes what the case side resolved, and touches nothing else.
 */
export function syncKanbanProjection(
  db: Database.Database, namespace: 'personal' | 'zst', now = Math.floor(Date.now() / 1000),
): SyncResult {
  const needs = humanActionNeeds(db, namespace, now)
  const byCase = new Map(needs.map((n) => [n.caseId, n]))

  const existing = db.prepare(
    `SELECT * FROM kanban_human_action_projection WHERE namespace = ?`,
  ).all(namespace) as ProjectionRow[]
  const byExisting = new Map(existing.map((r) => [r.case_id, r]))

  const res: SyncResult = {
    namespace, needs: needs.length, created: 0, refreshed: 0, closed: 0,
    refusedForeign: [], movedByHuman: [],
  }

  const getCard = db.prepare('SELECT id, status, title FROM kanban_cards WHERE id = ?')
  const insertCard = db.prepare(
    `INSERT INTO kanban_cards (id, title, description, status, assignee, priority, project, due_date, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, 'planned', 'istvan', ?, ?, ?, ?, ?, ?)`,
  )
  // The UPDATE deliberately does NOT touch `status`. A person may have moved the
  // card; the projection refreshes what it knows (the words, the priority, the
  // date) and leaves where the card sits alone, because where it sits is the
  // human's statement and not ours.
  const updateCard = db.prepare(
    `UPDATE kanban_cards SET title = ?, description = ?, priority = ?, due_date = ?, updated_at = ? WHERE id = ?`,
  )
  const maxSort = db.prepare(
    `SELECT MAX(sort_order) m FROM kanban_cards WHERE status = 'planned' AND archived_at IS NULL`,
  )
  const upsertIndex = db.prepare(
    `INSERT INTO kanban_human_action_projection
       (namespace, case_id, card_id, reason, first_projected_at, last_refreshed_at, closed_at, close_reason)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT(namespace, case_id) DO UPDATE SET
       reason = excluded.reason, last_refreshed_at = excluded.last_refreshed_at,
       closed_at = NULL, close_reason = NULL`,
  )

  const tx = db.transaction(() => {
    for (const need of needs) {
      const cardId = cardIdFor(namespace, need.caseId)
      const prev = byExisting.get(need.caseId)
      const card = getCard.get(cardId) as { id: string; status: string; title: string } | undefined

      if (card && !prev) {
        // A card with our deterministic id exists and no index row claims it.
        // It is somebody else's, or the leftover of an index we lost. Either way
        // it is not ours to rewrite.
        res.refusedForeign.push(cardId)
        continue
      }
      const body = describeCard(need, now)
      const prio = priorityFor(need, now)
      if (!card) {
        const m = (maxSort.get() as { m: number | null })?.m ?? -1
        insertCard.run(cardId, need.title, body, prio, PROJECT_LABEL[namespace], need.dueAt, m + 1, now, now)
        res.created++
      } else {
        if (card.status !== 'planned') res.movedByHuman.push(cardId)
        updateCard.run(need.title, body, prio, need.dueAt, now, cardId)
        res.refreshed++
      }
      upsertIndex.run(namespace, need.caseId, cardId, need.reason, prev?.first_projected_at ?? now, now)
    }

    // THE NEED WENT AWAY ON THE CASE SIDE. The card is archived and the index
    // says why. This is the projection updating itself, which the owner allowed;
    // the reverse -- a closed card closing a case -- is the thing that must
    // never exist, and there is no code here that could do it.
    for (const row of existing) {
      if (row.closed_at != null || byCase.has(row.case_id)) continue
      db.prepare(`UPDATE kanban_cards SET archived_at = ?, updated_at = ? WHERE id = ?`)
        .run(now, now, row.card_id)
      db.prepare(
        `UPDATE kanban_human_action_projection SET closed_at = ?, close_reason = ?
           WHERE namespace = ? AND case_id = ?`,
      ).run(now, 'the case no longer needs the owner', namespace, row.case_id)
      res.closed++
    }
  })
  tx()
  return res
}
