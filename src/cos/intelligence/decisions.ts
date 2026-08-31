// PHASE 2 -- DECISIONS.
//
// A decision object separates three things this codebase has repeatedly seen
// collapse into one sentence:
//
//   FACT            the store says X
//   INFERENCE       therefore probably Y, by a rule stated here
//   RECOMMENDATION  a person might choose Z
//
// The collapse matters because a recommendation that inherits a fact's
// confidence reads like an observation, and an inference presented as a fact is
// how a guess acquires authority it never earned.
//
// AND THE LINE THAT IS NOT NEGOTIABLE:
//
//     "NE legyen action authorization. HUMAN_DECISION továbbra sem egyenlő
//      külső művelet jóváhagyásával."
//
// A decision object records that a choice EXISTS and what bears on it. It never
// says the choice was made, and it never says anything may be executed. The
// E3 axes settled what a contradiction is; this settles what a decision is, and
// the two share the rule that describing is not permitting.
import type Database from 'better-sqlite3'
import {
  type Confidence, type Epistemic, type IntelligenceElement, type Provenance,
  combineConfidence, elementId, makeElement,
} from './element.js'

/** Which axis of the E3 taxonomy this decision sits on. Reused deliberately:
 *  inventing a second vocabulary for the same distinctions is how two surfaces
 *  start disagreeing about the same case. */
export type DecisionAxis =
  | 'HUMAN_DEPENDENCY'            // does a person have to supply something?
  | 'ENGINE_EXECUTION_PERMISSION' // may the engine take the next internal step?
  | 'EXTERNAL_SIDE_EFFECT'        // may a concrete outward act happen?
  | 'TERMINALITY'                 // is it actually done?

export interface DecisionInput {
  kind: Epistemic
  statement: string
  provenance: Provenance[]
  confidence: Confidence
}

export interface Decision extends IntelligenceElement {
  axis: DecisionAxis
  /** What is being decided, phrased as a question rather than an instruction. */
  question: string
  /** The three layers, kept apart. A reader can see which is which without
   *  trusting the prose. */
  basis: {
    facts: DecisionInput[]
    inferences: DecisionInput[]
    recommendations: DecisionInput[]
  }
  /** Who can settle it. NOT whether it is settled, and NOT permission. */
  decidableBy: 'OWNER' | 'ENGINE' | 'EITHER'
  /** True when the record already carries an answer. A decision that is settled
   *  is still not an authorization -- the gates decide that, separately. */
  settled: boolean
}

interface CaseRow {
  case_id: string; title: string; status: string
  next_action: string | null; blocked_reason: string | null; waiting_on: string | null
  due_at: number | null; updated_at: number
  proj_wait_condition?: string | null; proj_blocked_reason?: string | null
}

/** Statuses in which the record itself says a person is being waited on. */
const AWAITING_PERSON = new Set(['AWAITING_SELECTION', 'INFO_REQUIRED', 'INFORMATION_REQUIRED'])
const BLOCKED = new Set(['BLOCKED'])

export function decisionsForCase(row: CaseRow, namespace: 'personal' | 'zst', now: number): Decision[] {
  const out: Decision[] = []
  const caseProv: Provenance = { source: 'CASE', ref: row.case_id, observedAt: row.updated_at, field: 'status' }

  const push = (
    axis: DecisionAxis, question: string, decidableBy: Decision['decidableBy'],
    basis: Decision['basis'], settled: boolean,
  ): void => {
    const all = [...basis.facts, ...basis.inferences, ...basis.recommendations]
    const provenance = all.flatMap((b) => b.provenance)
    // The element's own kind is the WEAKEST layer present: a decision resting on
    // an inference is not a fact, however many facts sit underneath it.
    const kind: Epistemic = basis.recommendations.length ? 'RECOMMENDATION'
      : basis.inferences.length ? 'INFERENCE' : 'FACT'
    out.push({
      ...makeElement({
        id: elementId('decision', namespace, row.case_id, axis),
        kind, caseId: row.case_id, namespace,
        statement: question,
        provenance: provenance.length ? provenance : [caseProv],
        confidence: combineConfidence(all.map((b) => b.confidence)),
        contradiction: { state: 'NONE' },
      }, now),
      axis, question, basis, decidableBy, settled,
    })
  }

  if (AWAITING_PERSON.has(row.status)) {
    push('HUMAN_DEPENDENCY',
      `Does ${row.case_id} have the information or selection it is waiting for?`,
      'OWNER',
      {
        facts: [{
          kind: 'FACT', statement: `case status is ${row.status}`,
          provenance: [caseProv], confidence: 'HIGH',
        }],
        inferences: [{
          kind: 'INFERENCE',
          statement: 'the case cannot advance until a person supplies something',
          provenance: [caseProv], confidence: 'HIGH',
        }],
        // No recommendation: what to ask is the question surface's job, and
        // duplicating it here would let two surfaces phrase the same ask
        // differently.
        recommendations: [],
      },
      false)
  }

  if (BLOCKED.has(row.status)) {
    const reason = row.blocked_reason ?? row.proj_blocked_reason ?? null
    push('ENGINE_EXECUTION_PERMISSION',
      `Can the engine take the next internal step on ${row.case_id}, or is the block real?`,
      'EITHER',
      {
        facts: [{
          kind: 'FACT', statement: reason ? `blocked: ${reason}` : 'blocked with no reason recorded',
          provenance: [{ ...caseProv, field: 'blocked_reason' }],
          confidence: reason ? 'HIGH' : 'LOW',
        }],
        inferences: reason ? [] : [{
          kind: 'INFERENCE',
          statement: 'a block with no reason cannot be evaluated, so it cannot be cleared either',
          provenance: [caseProv], confidence: 'MEDIUM',
        }],
        recommendations: [],
      },
      false)
  }

  return out
}

/** Project decisions across a namespace. Reads only. */
export function projectDecisions(
  db: Database.Database, namespace: 'personal' | 'zst', now: number, limit = 500,
): Decision[] {
  const table = namespace === 'personal' ? 'personal_cases' : 'zst_cases'
  const rows = db.prepare(
    `SELECT case_id, title, status, next_action, blocked_reason, waiting_on, due_at, updated_at
     FROM ${table} WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
  ).all(limit) as CaseRow[]
  return rows.flatMap((r) => decisionsForCase(r, namespace, now))
}
