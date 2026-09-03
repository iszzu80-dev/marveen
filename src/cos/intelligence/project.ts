// PHASE 2 -- the one entry point, and the place the cross-surface invariants are
// enforced rather than assumed.
//
// Each surface is correct on its own; what this adds is the guarantees that only
// exist BETWEEN them:
//
//   - an opportunity never reaches the interrupt list, whatever its factors;
//   - the same case cannot be both an obligation and an opportunity;
//   - nothing here writes, so the canonical store stays the only case truth.
import type Database from 'better-sqlite3'
import { projectCommitments, type Commitment } from './commitments.js'
import { projectDecisions, type Decision } from './decisions.js'
import { projectOpportunities, type Opportunity } from './opportunities.js'
import {
  commitmentToAttention, decisionToAttention, selectAttention,
  type AttentionItem, type SelectionResult, type SurfacedRecord, type InterruptionPolicy,
} from './attention.js'
import { projectCaseAttention, caseAttentionToAttention, type CaseAttention } from './case-attention.js'

export interface IntelligenceProjection {
  commitments: Commitment[]
  decisions: Decision[]
  opportunities: Opportunity[]
  /** Attention a case earns on its OWN evidence, with no commitment behind it.
   *  A case can matter without anyone having promised anything. */
  caseAttention: CaseAttention[]
  attention: SelectionResult
  /** DERIVATION CONTRADICTIONS: the projection disagreeing with ITSELF while
   *  assembling this run -- two surfaces claiming the same case, or an asserted
   *  invariant breached. These are RUN FAULTS: they are caused by the code that
   *  just ran, they are fixable, and a cycle that sees one should go red.
   *  Empty is the normal case. */
  anomalies: string[]
  /** Commitments withheld from the owner's attention because the record says
   *  the obligation is DISCHARGED. Counted, never silent: if this number grows
   *  it means more closed work is being read, and if it ever hides something
   *  real the count is where that shows. */
  dischargedWithheld: number
  /** RECORD INTEGRITY FINDINGS: standing, historical defects in stored rows
   *  (a foreign object's status written onto a case event; a terminal row with
   *  no terminal event). Deliberately NOT anomalies.
   *
   *  These are not caused by the run and are not reconstructible -- we chose
   *  not to rewrite the history that carries them -- so they will be found on
   *  EVERY run, for ever. Feeding them to the cycle's failure list would have
   *  pinned the 10-minute digest permanently red, which teaches the reader to
   *  stop looking at `problems` and hides the next REAL fault in the same
   *  field. Reported and counted on every run so the number is never silent;
   *  never a failure. (2026-09-03, after doing exactly that for one cycle.) */
  integrityFindings: string[]
}

export function projectIntelligence(
  db: Database.Database,
  namespace: 'personal' | 'zst',
  now: number,
  seen: readonly SurfacedRecord[] = [],
  policy?: InterruptionPolicy,
): IntelligenceProjection {
  const commitments = projectCommitments(db, namespace, now)
  const decisions = projectDecisions(db, namespace, now)
  const opportunities = projectOpportunities(db, namespace, now)
  const caseAttention = projectCaseAttention(db, namespace, now)

  const anomalies: string[] = []
  const integrityFindings: string[] = []

  // ── LIFECYCLE INTEGRITY, said out loud (owner ruling 2026-09-03) ──────────
  //
  // Both of these used to surface as a quiet UNKNOWN, which is the wrong shape:
  // UNKNOWN says "we could not tell", and these say "the record is broken in a
  // specific, nameable way". A silent UNKNOWN gets read as a thin record and
  // filed; a NAMED finding gets read as a defect and fixed.
  //
  // They go to `integrityFindings`, not `anomalies`: they are standing facts
  // about history we deliberately do not rewrite, so they are loud but never a
  // run failure. See the interface comment for what that cost when it was got
  // wrong.
  for (const c of commitments) {
    for (const f of c.foreignStatusEvents) {
      integrityFindings.push(
        `FOREIGN_STATUS_EVENT ${c.caseId}: case event ${f.eventId} carries '${f.value}', ` +
        `which is not a ${namespace} case status -- another object's lifecycle written onto the case. ` +
        `Not used as completion or reopen evidence.`,
      )
    }
    if (c.closureClass === 'TERMINAL_ROW_NO_EVENT') {
      integrityFindings.push(
        `TERMINAL_ROW_NO_EVENT ${c.caseId}: the row is ${'terminal'} and NO event carries a terminal status. ` +
        `Something set the status without going through the canonical transition, so there is no record of ` +
        `when or by what. Not reconstructible; stays UNKNOWN by design.`,
      )
    }
  }

  // A case that is BOTH owed and merely suggested means one of the two
  // derivations is wrong about it. Reported, and the obligation wins, because
  // under-suggesting is a much cheaper error than under-obliging.
  const owed = new Set(commitments.map((c) => c.caseId))
  const suggested = opportunities.filter((o) => owed.has(o.caseId))
  for (const o of suggested) {
    anomalies.push(
      `${o.caseId} appears as both a commitment and an opportunity (${o.opportunityKind}); ` +
      `the opportunity is dropped, because a thing that is owed is not merely available`,
    )
  }
  const cleanOpportunities = opportunities.filter((o) => !owed.has(o.caseId))

  // A DISCHARGED OBLIGATION IS NOT A TASK, however new it is to the reader.
  //
  // Measured live on 2026-09-03, and it is why this exists: of 48 personal
  // commitments, 9 were FULFILLED -- and all 9 were in the attention list. Every
  // item the attention digest surfaced on its first three runs was a closed
  // case. Two of them had a `next_action` that literally reads "Nincs további
  // teendő" and "A biztonsági incidens lezárva"; the owner was being asked to do
  // the sentence that says the matter is finished.
  //
  // The commitment projection reads closed cases ON PURPOSE -- it classifies the
  // QUALITY of a closure (fulfilled, reopened, unevidenced), and it must see them
  // to do that. The defect was one level out: the attention selector never asked
  // for the classification before putting the item in front of a person.
  //
  // The gate is the RECORD, not the calendar. A date can be wrong about whether
  // something still matters; "this obligation was discharged, here is the proof"
  // cannot. So: FULFILLED (proved here), IMPORTED_CLOSURE (somebody else asserted
  // it and we recorded the assertion) and SUPERSEDED (the work moved to another
  // case) are withheld. OPEN, EXPIRED, REOPENED and UNKNOWN still surface --
  // UNKNOWN especially, because "we cannot say it was done" is the one case where
  // silence would be a real loss.
  // CLOSED CLASSIFICATION IS NOT DELETED INFORMATION (owner ruling, 2026-09-03).
  // The rule is about ONE surface: a discharged commitment must not be presented
  // to the owner as an unfinished promise. It is not a global erasure. A case
  // whose commitment is discharged still raises case-level attention on its own
  // evidence, and IMPORTED_CLOSURE still speaks below, on the integrity surface,
  // because "somebody else asserted this was done and we hold no local proof" is
  // a real gap -- just not a task.
  const DISCHARGED: ReadonlySet<string> = new Set(['FULFILLED', 'IMPORTED_CLOSURE', 'SUPERSEDED'])
  const liveCommitments = commitments.filter((c) => !DISCHARGED.has(c.status))
  const dischargedWithheld = commitments.length - liveCommitments.length

  for (const c of commitments) {
    if (c.status !== 'IMPORTED_CLOSURE') continue
    integrityFindings.push(
      `IMPORTED_CLOSURE ${c.caseId}: the case was imported already closed, so no LOCAL evidence of ` +
      `fulfilment exists. Not an owner task -- the obligation is not presented as unfinished -- but ` +
      `the absence of local proof is recorded here rather than lost.`,
    )
  }

  // A case may raise attention on its own evidence AND carry a commitment. When
  // both exist the commitment is the more specific statement, so the case-level
  // item stands down rather than saying the same thing twice.
  // NOTE the deliberate asymmetry: this uses the LIVE commitments, not all of
  // them. A case whose commitment is discharged may still raise attention on its
  // own evidence, and suppressing that because a FINISHED promise "already
  // speaks for it" would silence the case twice over.
  const spokenFor = new Set(liveCommitments.map((c) => c.caseId))
  const standaloneAttention = caseAttention.filter((a) => !spokenFor.has(a.caseId))

  const obligations: AttentionItem[] = [
    ...liveCommitments.map((c) => commitmentToAttention(c, now)),
    ...decisions.map((d) => decisionToAttention(d, now)),
    ...standaloneAttention.map((a) => caseAttentionToAttention(a, now)),
  ]
  const oppItems: AttentionItem[] = cleanOpportunities.map((o) => ({
    element: o,
    band: 'OPPORTUNITY',
    factors: { risk: 0, urgency: 0, staleness: Math.min(1, o.recencySeconds / (14 * 86_400)), blockedness: 0, unresolvedContradiction: 0 },
    why: o.suggestion,
  }))

  const attention = selectAttention(obligations, oppItems, seen, now, policy)

  // The invariant, ASSERTED rather than trusted. If a later change ever lets an
  // opportunity into the interrupt list, this says so here instead of in
  // somebody's notification.
  const leaked = attention.interrupt.filter((i) => i.band === 'OPPORTUNITY')
  for (const l of leaked) {
    anomalies.push(`INVARIANT BREACH: opportunity ${l.element.id} reached the interrupt list`)
  }

  return {
    commitments, decisions, opportunities: cleanOpportunities, caseAttention, attention,
    anomalies, integrityFindings, dischargedWithheld,
  }
}
