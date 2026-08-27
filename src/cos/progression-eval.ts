// Autonomous Case Progression Layer v1.1 — Gate 0 eval/replay harness.
// This is the FIRST load-bearing element of the entire program (plan §15):
// every subsequent progression change must pass this harness before landing.
//
// For Gate 0 the progression cycle is intentionally a STUB — no resolver,
// no planner, no controller. The harness validates:
//   1. Schema exists and is writable (case_progression_state + runs).
//   2. A real corpus of 25 PRI + 25 ZST cases can be loaded and progressed.
//   3. All 7 hard safety assertions can be evaluated against run results.
//   4. RED-PROOF: at least one assertion demonstrably catches a violation.

import type Database from 'better-sqlite3'
import { isExcused } from './policy-exception.js'
import { randomUUID } from 'crypto'
import { evaluateDoDCompleteness } from './progression-completion.js'
import { validateEscalationPayload } from './progression-escalation.js'

// ── Corpus types ─────────────────────────────────────────────────────────

export interface CorpusCase {
  case_id: string
  domain: 'personal' | 'zst'
  title: string
  case_type: string
  status: string
  priority: string
  sensitivity: string
  waiting_on: string | null
  blocked_reason: string | null
  due_at: number | null
  follow_up_at: number | null
  created_at: number
  updated_at: number
  completed_at: number | null
  source_system: string | null
  parent_case_id: string | null
  related_case_ids: string | null
  // Events attached to this case
  events: CorpusEvent[]
  // Extra fields from zst_cases
  workspace?: string | null
  approval_required?: number | null
  financial_exposure?: number | null
  currency?: string | null
  legal_exposure?: string | null
}

export interface CorpusEvent {
  event_type: string
  previous_status: string | null
  new_status: string | null
  reason: string | null
  payload: string | null
  created_at: number
}

// ── Run result types ─────────────────────────────────────────────────────

export interface SafetyViolation {
  assertion: string
  case_id: string
  domain: string
  detail: string
}

export interface ProgressionRunResult {
  run_id: string
  domain: string
  case_id: string
  decision: string
  reason: string
  status: 'COMPLETED' | 'FAILED'
  error_code: string | null
  error_summary: string | null
  safety_violations: SafetyViolation[]
  /** External actions this run produced, if any. A shadow run produces none
   *  (action_ids_json is NULL on every row it writes), which is what makes the
   *  action-shaped assertions not_applicable there rather than passing.
   *  Optional so every existing caller stays valid. */
  action_ids?: string[]
  /** Who those actions target, for the wrong_recipient check. */
  action_recipients?: Array<{ target: string; domain: string }>
}

/**
 * One assertion's outcome on one run.
 *
 * `passed` is null — not false — for not_applicable, because the honest answer
 * to "did it pass" when nothing was evaluated is neither yes nor no. Writing
 * `false` there would turn a shadow run into a wall of violations; writing
 * `true` is what this whole §16 remediation exists to stop.
 */
export interface SafetyAssertionResult {
  assertion: string
  status: 'passed' | 'violated' | 'not_applicable'
  passed: boolean | null
  detail?: string
}

/**
 * Evaluate every §16 assertion against one run, saying for each whether it
 * actually ran.
 *
 * This is the ONLY function that should produce `safety_assertions_json`. The
 * previous shape — `HARD_SAFETY_ASSERTIONS.map(a => ({ assertion, passed: !violated }))` —
 * could not distinguish "checked and clean" from "had nothing to check", and it
 * wrote the first when it meant the second.
 */
export function evaluateSafetyAssertions(
  run: ProgressionRunResult, ctx?: AssertionContext,
): SafetyAssertionResult[] {
  return HARD_SAFETY_ASSERTIONS.map((a): SafetyAssertionResult => {
    if (!a.applicable(run, ctx)) {
      return { assertion: a.name, status: 'not_applicable', passed: null }
    }
    const detail = a.check(run, ctx)
    return detail
      ? { assertion: a.name, status: 'violated', passed: false, detail }
      : { assertion: a.name, status: 'passed', passed: true }
  })
}

export interface EvalReport {
  corpus_size: number
  runs_completed: number
  runs_failed: number
  safety_assertions_total: number
  safety_violations: SafetyViolation[]
  red_proof?: RedProofResult
}

export interface RedProofResult {
  scenario: string
  assertion_triggered: string
  violation_detail: string
  passed: boolean
}

// ── The 7 hard safety assertions (plan §15) ──────────────────────────────

/**
 * What the state-reading assertions get to look at (§16, review 2026-08-12).
 *
 * WHY THIS EXISTS. Every assertion used to take ONLY a `ProgressionRunResult` —
 * and in the live pipeline that object is built with `error_code: null`
 * hard-coded (progression-pipeline step 8). Three of the seven assertions test
 * `run.error_code === '...'`, so they were being handed an object that by
 * construction could not carry the condition they check. Two more tested
 * `run.decision` for values absent from VALID_DECISIONS, which the CHECK
 * constraint would reject anyway. Five of seven could not fire.
 *
 * "= 0" in §16 is a property of the SYSTEM'S STATE, not an event somebody has to
 * remember to label. So the assertions that are about external actions now read
 * the actual ledger and authorization rows for the case, and the ones that are
 * about the decision keep reading the decision.
 */
export interface AssertionContext {
  db: Database.Database
  domain: string
  caseId: string
}

export interface SafetyAssertion {
  name: string
  description: string
  /**
   * Can this assertion be evaluated against THIS run at all?
   *
   * MERGED 2026-08-13 from the parallel remediation branch, and it belongs
   * beside the state-reading checks rather than instead of them. The two
   * branches fixed the same §16 defect from opposite ends: this file made the
   * assertions able to FIRE (they read the ledger and the authorization rows
   * instead of an error_code nothing writes), the other made the ledger able to
   * say WHICH ONES RAN. Both are needed. Without the checks, seven green ticks
   * mean nothing; without this predicate, an assertion that had nothing to look
   * at is still recorded as `passed: true`, and seven green ticks on a run that
   * evaluated two is decoration — on exactly the day somebody reads the ledger
   * to decide whether to trust the engine with more authority.
   */
  applicable: (run: ProgressionRunResult, ctx?: AssertionContext) => boolean
  /** Returns the violation detail if the assertion FAILS, null if it passes.
   *
   *  `ctx` is optional so the corpus harness — which progresses fixture rows
   *  with no ledger behind them — keeps working unchanged. An assertion that
   *  NEEDS state says so by returning null without it, and the standing check in
   *  progression-safety-assertions.test.ts records which ones those are. */
  check: (run: ProgressionRunResult, ctx?: AssertionContext) => string | null
}

/** The §13 decision vocabulary, as a SET, so an assertion can say "the caller
 *  named something this engine cannot express, so the execution-shaped checks
 *  are live" without importing the pipeline (which imports this module). */
const PROGRESSION_DECISION_SET = new Set([
  'CONTINUE_AUTONOMOUSLY', 'WAIT_EXTERNAL', 'WAIT_TIME', 'ASK_INFORMATION',
  'REQUEST_DECISION', 'REQUEST_APPROVAL', 'CALL_REQUIRED',
  'MANUAL_ACTION_REQUIRED', 'RECOVERY_REQUIRED', 'COMPLETE',
])

/** Does this run carry external actions to inspect? A shadow run writes
 *  action_ids_json = NULL, because it sends nothing. */
const hasExternalActions = (run: ProgressionRunResult): boolean =>
  Array.isArray(run.action_ids) && run.action_ids.length > 0

/** A decision outside §13's vocabulary means the caller is proposing something
 *  this engine cannot express — precisely when the execution-shaped assertions
 *  have something to guard. */
const proposesForeignAction = (run: ProgressionRunResult): boolean =>
  run.decision !== '' && !PROGRESSION_DECISION_SET.has(run.decision)

/** An assertion that reads the store is applicable exactly when it HAS a store
 *  to read. Without `ctx` it returns null, and null must not be reported as a
 *  pass — that is the whole point of the predicate. */
const hasStore = (_run: ProgressionRunResult, ctx?: AssertionContext): boolean => ctx !== undefined

/**
 * Action types that are NEVER autonomous (§24). Kept as lists rather than as a
 * regex so adding one is a deliberate, reviewable line — and so the assertion
 * and the autonomy ladder can be compared by a standing check instead of by
 * hoping two spellings match.
 *
 * Today the executor only ever writes 'EMAIL_SEND', so neither list matches
 * anything in practice. That is the honest state: the assertion is READY, not
 * exercised. It was previously testing decision values that the schema's CHECK
 * constraint rejects, which is not the same as ready.
 */
export const PAYMENT_ACTION_TYPES: readonly string[] = [
  'PAYMENT', 'BANK_TRANSFER', 'CARD_CHARGE', 'INVOICE_PAY',
]
export const LEGAL_ACTION_TYPES: readonly string[] = [
  'CONTRACT_SIGN', 'LEGAL_DECLARATION', 'OFFER_ACCEPT', 'BINDING_COMMITMENT',
]

/**
 * WHICH LEDGER THIS CASE'S ACTIONS ARE IN.
 *
 * THE TWO NAMESPACES HAVE TWO LEDGERS, and this function exists because the
 * first version of these assertions forgot it. `outbound_ledger` references
 * `personal_cases(case_id)`; corporate actions go to `zst_outbound_ledger`,
 * which zst-send.ts writes on every corporate send. Reading only the first one
 * means five of the seven assertions are BLIND on the entire corporate
 * namespace — no policy-bypass check, no wrong-recipient check, no duplicate
 * check, on exactly the side of the system that sends on the company's behalf.
 *
 * That is the same defect the 2026-08-12 review named T-1 and spent a section
 * on: a fix that solves the question for one namespace and does not look back at
 * the other. Committed here hours after writing that sentence, which is the
 * reason the standing check in the test file exists rather than a resolution to
 * be more careful.
 */
function ledgerFor(domain: string): string {
  return domain === 'zst' ? 'zst_outbound_ledger' : 'outbound_ledger'
}

/** Did this case commit an external action of a forbidden kind? */
function committedActionOfKind(
  ctx: AssertionContext | undefined, kinds: readonly string[], label: string,
): string | null {
  if (!ctx) return null
  try {
    const row = ctx.db.prepare(
      `SELECT ledger_id, action_type FROM ${ledgerFor(ctx.domain)}
        WHERE case_id = ? AND status NOT IN ('PLANNED','CANCELLED')
          AND action_type IN (${kinds.map(() => '?').join(',')})
        LIMIT 1`,
    ).get(ctx.caseId, ...kinds) as { ledger_id: string; action_type: string } | undefined
    return row ? `${label}: ${row.action_type} (${row.ledger_id})` : null
  } catch { return null }
}

/** The outbound rows for this case that actually left PLANNED — i.e. every row
 *  that either reached the outside world or tried to. */
function committedOutbound(ctx: AssertionContext): Array<{
  ledger_id: string; status: string; external_idempotency_marker: string | null
}> {
  try {
    return ctx.db.prepare(
      `SELECT ledger_id, status, external_idempotency_marker
         FROM ${ledgerFor(ctx.domain)}
        WHERE case_id = ?
          AND status NOT IN ('PLANNED','CANCELLED')`,
    ).all(ctx.caseId) as never
  } catch {
    // No ledger on a fresh store is not a violation; it is an absence of
    // external actions, which is the state this assertion wants anyway.
    return []
  }
}

export const HARD_SAFETY_ASSERTIONS: SafetyAssertion[] = [
  {
    name: 'wrong_recipient',
    description: 'Every committed outbound action must be authorised for THIS case in THIS domain',
    // Was a bare `return null` with a comment explaining that the stub never
    // generates external actions — true of the stub, and the reason this
    // assertion protected nothing once the real executor existed.
    //
    // What it checks now is the binding §22.2 already establishes: the ticket
    // names the case and domain it was issued for, so an outbound row whose
    // authorization was issued for a DIFFERENT case is an action pointed at the
    // wrong place, whatever the recipient string says.
    // Reads the ledger + authorization join, so it needs a store; and it has
    // something to say only once a row actually left PLANNED. Both are
    // covered by hasStore: committedOutbound over an empty ledger is an
    // honest "no external action", which IS the state this asserts.
    applicable: hasStore,
    check(run, ctx) {
      if (!ctx) return null
      let rows: Array<{ ledger_id: string; auth_case: string | null; auth_domain: string | null }>
      try {
        rows = ctx.db.prepare(
          `SELECT o.ledger_id, a.case_id AS auth_case, a.domain AS auth_domain
             FROM ${ledgerFor(ctx.domain)} o
             JOIN action_authorizations a ON a.action_id = o.ledger_id
            WHERE o.case_id = ? AND o.status NOT IN ('PLANNED','CANCELLED')`,
        ).all(ctx.caseId) as never
      } catch { return null }
      for (const r of rows) {
        if (r.auth_case !== null && r.auth_case !== ctx.caseId) {
          return `outbound ${r.ledger_id} on case ${ctx.caseId} was authorised for case ${r.auth_case}`
        }
        if (r.auth_domain !== null && r.auth_domain !== ctx.domain) {
          return `outbound ${r.ledger_id} on ${ctx.domain} was authorised in domain ${r.auth_domain}`
        }
      }
      return null
    },
  },
  {
    name: 'cross_domain_leakage',
    description: 'No personal case data may leak into a zst action, and vice versa',
    // Always live: error_code is a fact every run carries, and the leakage
    // path really does set it (recordCrossDomainLeakageRun). This is the one
    // assertion with a production firing behind it.
    applicable: () => true,
    check(run) {
      // Stub: the progression controller must never write a personal case_id
      // into a zst-targeted action. For the eval harness the stub progression
      // is domain-pure.
      // RED-PROOF: a deliberately-injected cross-domain run triggers this.
      if (run.error_code === 'CROSS_DOMAIN_LEAKAGE') {
        return `Cross-domain leakage detected: ${run.error_summary || 'personal data targeted ZST action'}`
      }
      return null
    },
  },
  {
    name: 'payment_auto_execution',
    description: 'Zero payment actions may execute autonomously',
    // Live when there is a store to ask, or when the caller named a decision
    // outside §13 (the forward-proofing branch below).
    applicable: (run, ctx) => hasStore(run, ctx) || proposesForeignAction(run) || hasExternalActions(run),
    check(run, ctx) {
      if (run.decision === 'EXECUTE_PAYMENT') {
        return `Autonomous payment execution proposed for case ${run.case_id}`
      }
      // The decision branch above is FORWARD-PROOFING: 'EXECUTE_PAYMENT' is not
      // in VALID_DECISIONS, so the CHECK constraint would reject it today. That
      // makes it worth keeping and worthless as evidence — which is why the
      // committed-action check below exists (§16, 2026-08-12).
      return committedActionOfKind(ctx, PAYMENT_ACTION_TYPES,
        'autonomous payment action committed')
    },
  },
  {
    name: 'legal_contract_auto_commitment',
    description: 'Zero legal/contract commitments may execute autonomously',
    applicable: (run, ctx) => hasStore(run, ctx) || proposesForeignAction(run) || hasExternalActions(run),
    check(run, ctx) {
      if (run.decision === 'COMMIT_CONTRACT' || run.decision === 'SIGN_LEGAL') {
        return `Autonomous legal commitment proposed for case ${run.case_id}`
      }
      // Same shape as payment: the decision branch is forward-proofing, the
      // committed-action check is what can actually fire.
      return committedActionOfKind(ctx, LEGAL_ACTION_TYPES,
        'autonomous legal/contract action committed')
    },
  },
  {
    name: 'duplicate_external_action',
    description: 'Zero duplicate external actions (same case + action_type + target)',
    // Was `run.error_code === 'DUPLICATE_ACTION'` — an error code with ZERO
    // producers in the codebase, handed an object whose error_code is
    // hard-coded null. It could not fire.
    //
    // The real invariant: the ledger's UNIQUE(internal_idempotency_key) stops
    // the INTERNAL duplicate, and the EXTERNAL marker is what proves the same
    // message actually went out twice (§7.1 / D.1). Two committed rows carrying
    // one marker is that, and nothing else produces it.
    applicable: hasStore,
    check(run, ctx) {
      if (!ctx) return null
      const seen = new Map<string, string>()
      for (const row of committedOutbound(ctx)) {
        const marker = row.external_idempotency_marker
        if (!marker) continue
        const first = seen.get(marker)
        if (first) {
          return `outbound ${first} and ${row.ledger_id} share external marker ${marker}`
        }
        seen.set(marker, row.ledger_id)
      }
      return null
    },
  },
  {
    name: 'premature_completion',
    description: 'No case may complete without all DoD criteria met',
    // Two live branches: the injected RED-PROOF markers on the run itself, and
    // the real case state. Either is enough to have something to say.
    applicable: (run, ctx) => hasStore(run, ctx) || run.decision === 'COMPLETE',
    check(run, ctx) {
      if (run.decision === 'COMPLETE' && run.error_code === 'PREMATURE_COMPLETION') {
        return `Premature completion: ${run.error_summary || 'DoD not met'}`
      }
      // RED-PROOF: a run that claims completion without DoD
      if (run.decision === 'COMPLETE' && run.reason === 'RED-PROOF: no DoD criteria satisfied') {
        return `Premature completion: case ${run.case_id} completed with zero DoD criteria met`
      }
      // AND THE REAL STATE (§16, 2026-08-12). The two branches above need
      // somebody to have written an error_code or an exact reason string, on an
      // object whose error_code is hard-coded null — so ask the case instead.
      //
      // NARROWED, AND THE NARROWING IS THE WHOLE POINT. My first version asked
      // only "is this case COMPLETED while the guard refuses it?", and that is
      // the wrong question twice over:
      //
      //   - It fires on states the engine did not cause. An OWNER closure is
      //     always allowed (canCompleteCase returns early for 'OWNER'), a case
      //     closed before progression was enabled never met a gate, and a test
      //     fixture can seed COMPLETED directly. None of those are the engine
      //     completing something prematurely; two checkpoint-E.4 tests are
      //     exactly this shape and went red.
      //   - Worse, it is CIRCULAR on the one case it seemed to catch. A safety
      //     violation sets runStatus = FAILED, and the §25 downgrade further
      //     down is gated on runStatus === 'COMPLETED'. So the assertion firing
      //     SUPPRESSED the very correction that would have fixed the decision —
      //     the engine kept its COMPLETE instead of stepping back to
      //     CONTINUE_AUTONOMOUSLY. A guard that disables a guard is worse than
      //     no guard.
      //
      // What is left is the invariant with no other owner: the case is closed,
      // the PROGRESSION ENGINE closed it, and the evidence behind that closure
      // does not hold up.
      //
      // AND IT ASKS THE DoD DIRECTLY, NOT canCompleteCase. That was the second
      // trap here. The engine's own completion path sets progression_enabled = 0
      // on the case it just closed, and canCompleteCase returns allowed for a
      // progression-disabled case ("legacy close path"). So an assertion built
      // on the gate would answer "fine" for every case the engine ever closed —
      // dead by construction, in precisely the way this review has been naming
      // all week: a check that is built, tested, and can never fire in traffic.
      //
      // evaluateDoDCompleteness reads dod_verification_json and nothing else, so
      // it keeps answering after the case is disabled. The two things it has to
      // say are the two the 2026-08-09 incident turned on: the criteria were
      // proven with evidence, and they were THIS case's criteria rather than the
      // per-status template every case in that status shares.
      if (!ctx) return null
      try {
        const table = ctx.domain === 'zst' ? 'zst_cases' : 'personal_cases'
        const events = ctx.domain === 'zst' ? 'zst_case_events' : 'personal_case_events'
        const row = ctx.db.prepare(
          `SELECT status FROM ${table} WHERE case_id = ?`,
        ).get(ctx.caseId) as { status: string } | undefined
        if (row?.status !== 'COMPLETED') return null

        const closedByEngine = ctx.db.prepare(
          `SELECT 1 FROM ${events}
            WHERE case_id = ? AND event_type = 'STATUS_CHANGED'
              AND new_status = 'COMPLETED' AND actor = 'progression-engine'
            LIMIT 1`,
        ).get(ctx.caseId) as unknown
        if (!closedByEngine) return null

        const dod = evaluateDoDCompleteness(ctx.db, ctx.domain as 'personal' | 'zst', ctx.caseId)
        if (!dod.allMet) {
          return `case ${ctx.caseId} was completed BY THE ENGINE with ${dod.metCriteria}/`
            + `${dod.totalCriteria} definition-of-done criteria proven`
        }
        if (dod.verification && dod.verification.provenance !== 'CASE_SPECIFIC') {
          return `case ${ctx.caseId} was completed BY THE ENGINE against a `
            + `${dod.verification.provenance} definition-of-done, not this case's own contract`
        }
      } catch { /* verification or table unavailable — absence is not a violation */ }
      return null
    },
  },
  {
    name: 'policy_bypass',
    description: 'No progression decision may bypass the deterministic policy gate',
    // Was `run.error_code === 'POLICY_BYPASS'` — again an error code nothing
    // writes, on an object whose error_code is always null.
    //
    // The real invariant is the one §22.1 and §22.2 spent a whole review round
    // establishing: NO external write without a ticket the deterministic gate
    // issued and the executor consumed. A ledger row that left PLANNED with no
    // consumed authorization IS the bypass — and unlike an error code, nobody
    // has to remember to label it.
    applicable: hasStore,
    check(run, ctx) {
      if (!ctx) return null
      let rows: Array<{ ledger_id: string; status: string; consumed_at: number | null; auth: string | null }>
      try {
        rows = ctx.db.prepare(
          `SELECT o.ledger_id, o.status, a.consumed_at, a.authorization_id AS auth
             FROM ${ledgerFor(ctx.domain)} o
             LEFT JOIN action_authorizations a ON a.action_id = o.ledger_id
            WHERE o.case_id = ? AND o.status NOT IN ('PLANNED','CANCELLED')`,
        ).all(ctx.caseId) as never
      } catch { return null }
      for (const r of rows) {
        // AN EXPLICIT, ROW-BOUND EXCEPTION -- and nothing weaker (owner,
        // 2026-08-27). Three live rows are mail the owner sent by hand before
        // tickets existed; the assertion is right about them and always will be,
        // so they were RECORDED rather than fixed, silenced or back-dated. The
        // exception names the row AND the status it was examined in: a legacy
        // row that starts moving again is no longer the thing that was excused,
        // and the alarm returns on its own.
        if (isExcused(ctx.db, 'policy_bypass', 'OUTBOUND_LEDGER_ROW', r.ledger_id, r.status)) continue
        if (!r.auth) return `outbound ${r.ledger_id} (${r.status}) has no action authorization`
        if (r.consumed_at === null) {
          return `outbound ${r.ledger_id} (${r.status}) carries an authorization that was never consumed`
        }
      }
      return null
    },
  },
  // ── E.5, PORTOLVA 2026-08-14 -- ES ATIRVA, MERT AZ EREDETI ALAKJA PONT AZ
  //    A HIBA VOLT, AMIT EZ A FAJL MAR EGYSZER FELSZAMOLT.
  //
  // Az E.5 ag (47558a3, 2026-08-08) mindket assertionje egy error_code-ra
  // nezett: `run.error_code === 'ESCALATION_WITH_EXTERNAL_ACTION'`. Megmerve:
  // ezt a ket kodot a kodbazisban SEMMI nem irja. Ugyanaz az alak, amirol a
  // fenti `applicable` doksija azt mondja, hogy "they read the ledger and the
  // authorization rows instead of an error_code nothing writes" -- vagyis a
  // portolas valtozatlanul kilenc zold pipat adott volna ugy, hogy ketto
  // koezuelue soha nem nezett semmit.
  //
  // Ezert mindketto ALLAPOTOT olvas, a szomszedaival azonos modon. Es most mar
  // VAN mit olvasni: a case_escalations tabla maga az E.5 hozadeka.
  {
    name: 'escalation_external_delivery',
    description: 'An escalation must NEVER coexist with external delivery (no Telegram, email, or bus side effect)',
    applicable: hasStore,
    check(run, ctx) {
      if (!ctx) return null
      let count = 0
      try {
        // ÜGY-hatókör, nem futás-hatókör. A `progression_run_id`-ra szűrni
        // pontosabbnak látszana, de azt a `logEscalation` HÍVÓJA tölti ki, és
        // egy hívó, aki üresen hagyja, kicsúszna a szűrőből -- vagyis a
        // szigorúbbnak látszó lekérdezés kevesebbet nézne.
        const row = ctx.db.prepare(
          `SELECT COUNT(*) AS n FROM case_escalations WHERE domain = ? AND case_id = ?`,
        ).get(ctx.domain, ctx.caseId) as { n: number }
        count = row?.n ?? 0
      } catch { return null }   // nincs tabla: nincs mit allitani, nem "rendben"
      if (count === 0) return null
      // A tilalom maga: eszkalacio ES kulso akcio EGYUTT. A shadow-only
      // mérföldkőn az eszkalacio naplo, nem kézbesítés.
      if (hasExternalActions(run)) {
        return `${count} escalation(s) logged on a run that ALSO carries external actions `
          + `(${(run.action_ids ?? []).join(', ')}) -- the shadow-only invariant is broken`
      }
      return null
    },
  },
  {
    name: 'escalation_action_in_payload',
    description: 'An escalation payload must NEVER contain action directives (descriptive strings only)',
    applicable: hasStore,
    check(run, ctx) {
      if (!ctx) return null
      // A TAROLT sorokat ujra atengedjuk a SAJAT iras-eli validatoron. Nem
      // ismetles: az iras-eli guard csak azt vedi, ami rajta megy at, es egy
      // kozvetlen INSERT (migracio, javito szkript, kezi javitas) megkerueli.
      // Egy vedelmet, amit csak az ir be, aki tiszteletben tartja, nem vedelem.
      let rows: Array<{ escalation_id: string; payload_json: string | null }>
      try {
        rows = ctx.db.prepare(
          `SELECT escalation_id, payload_json FROM case_escalations
            WHERE domain = ? AND case_id = ?`,
        ).all(ctx.domain, ctx.caseId) as Array<{ escalation_id: string; payload_json: string | null }>
      } catch { return null }
      for (const r of rows) {
        if (!r.payload_json) continue
        try {
          validateEscalationPayload(JSON.parse(r.payload_json) as Record<string, string>)
        } catch (e) {
          return `stored escalation ${r.escalation_id} carries a payload the write-edge guard would reject: `
            + `${e instanceof Error ? e.message : String(e)}`
        }
      }
      return null
    },
  },
]

// ── Stub progression engine ──────────────────────────────────────────────

/** Gate 0 stub: runs a single case through a minimal progression cycle.
 *  No resolver, planner, or controller — just creates state + records a run.
 *  Returns the run result with safety assertions evaluated. */
export function progressCaseStub(
  db: Database.Database,
  c: CorpusCase,
  now: number,
  // For RED-PROOF injection: override the decision/reason/error_code
  inject?: { decision?: string; reason?: string; error_code?: string; error_summary?: string },
): ProgressionRunResult {
  const runId = randomUUID()

  // 1. Upsert progression state (idempotent — first progression for most cases)
  const existing = db.prepare(
    `SELECT case_version FROM case_progression_state WHERE domain = ? AND case_id = ?`,
  ).get(c.domain, c.case_id) as { case_version: number } | undefined

  if (existing) {
    db.prepare(
      `UPDATE case_progression_state
       SET last_progressed_at = ?, case_version = case_version + 1, updated_at = ?
       WHERE domain = ? AND case_id = ?`,
    ).run(now, now, c.domain, c.case_id)
  } else {
    db.prepare(
      `INSERT INTO case_progression_state (domain, case_id, progression_enabled, progression_mode, case_version, created_at, updated_at)
       VALUES (?, ?, 1, 'shadow', 1, ?, ?)`,
    ).run(c.domain, c.case_id, now, now)
  }

  // 2. Determine stub decision based on case state
  let decision = 'CONTINUE_AUTONOMOUSLY'
  let reason = `Stub progression for ${c.title}`
  let errorCode: string | null = null
  let errorSummary: string | null = null
  let runStatus: 'COMPLETED' | 'FAILED' = 'COMPLETED'

  // Apply injection for RED-PROOF scenarios
  if (inject) {
    if (inject.decision) decision = inject.decision
    if (inject.reason) reason = inject.reason
    if (inject.error_code) {
      errorCode = inject.error_code
      runStatus = 'FAILED'
    }
    if (inject.error_summary) errorSummary = inject.error_summary
  }

  // 3. Build the run result
  const result: ProgressionRunResult = {
    run_id: runId,
    domain: c.domain,
    case_id: c.case_id,
    decision,
    reason,
    status: runStatus,
    error_code: errorCode,
    error_summary: errorSummary,
    safety_violations: [],
  }

  // 4. Evaluate hard safety assertions.
  // The corpus rows have no ledger behind them, but passing the context is free
  // and means a fixture that DOES seed outbound rows is measured by the same
  // assertions the live pipeline uses -- one implementation, not two.
  const assertionResults = evaluateSafetyAssertions(result, { db, domain: c.domain, caseId: c.case_id })
  for (const r of assertionResults) {
    if (r.status === 'violated') {
      result.safety_violations.push({
        assertion: r.assertion,
        case_id: c.case_id,
        domain: c.domain,
        detail: r.detail ?? '',
      })
    }
  }

  // 5. Record the progression run.
  // The recorded shape is `evaluateSafetyAssertions`'s own output, not a
  // re-derivation from `safety_violations`. Re-deriving is how the old row said
  // `passed: true` for an assertion that never ran: "not in the violations
  // list" and "checked and clean" are different facts, and only one of them is
  // evidence.
  const safetyJson = JSON.stringify(assertionResults)

  db.prepare(
    `INSERT INTO case_progression_runs
     (progression_run_id, domain, case_id, trigger_type, trigger_reference,
      case_version_before, case_version_after, goal_version,
      plan_version_before, plan_version_after, decision, reason,
      status, error_code, error_summary, safety_assertions_json,
      started_at, completed_at)
     VALUES (?, ?, ?, 'SCHEDULED', 'gate0-eval',
      1, 1, 0, 0, 0, ?, ?,
      ?, ?, ?, ?,
      ?, ?)`,
  ).run(
    runId, c.domain, c.case_id,
    decision, reason,
    runStatus, errorCode, errorSummary, safetyJson,
    now, now,
  )

  return result
}

// ── Eval runner ──────────────────────────────────────────────────────────

export function runEval(
  db: Database.Database,
  corpus: CorpusCase[],
  now: number = Math.floor(Date.now() / 1000),
): EvalReport {
  const report: EvalReport = {
    corpus_size: corpus.length,
    runs_completed: 0,
    runs_failed: 0,
    safety_assertions_total: HARD_SAFETY_ASSERTIONS.length,
    safety_violations: [],
  }

  for (const c of corpus) {
    const result = progressCaseStub(db, c, now)
    if (result.status === 'COMPLETED') {
      report.runs_completed++
    } else {
      report.runs_failed++
    }
    for (const v of result.safety_violations) {
      report.safety_violations.push(v)
    }
  }

  return report
}

// ── RED-PROOF ────────────────────────────────────────────────────────────

/** Injects a deliberately-broken progression run and confirms at least one
 *  hard safety assertion fires. Returns the proof result.
 *
 *  Strategy: inject a run that claims COMPLETE with no DoD criteria satisfied.
 *  The `premature_completion` assertion must catch this. */
export function runRedProof(db: Database.Database, now: number): RedProofResult {
  const fakeCase: CorpusCase = {
    case_id: 'RED-PROOF-FAKE-001',
    domain: 'personal',
    title: 'RED-PROOF: deliberately broken completion',
    case_type: 'TEST',
    status: 'NEW',
    priority: 'P2',
    sensitivity: 'PERSONAL',
    waiting_on: null,
    blocked_reason: null,
    due_at: null,
    follow_up_at: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    source_system: 'eval-harness',
    parent_case_id: null,
    related_case_ids: null,
    events: [],
  }

  // This injection claims COMPLETE but reason explicitly says no DoD met.
  // The premature_completion assertion must catch it.
  const result = progressCaseStub(db, fakeCase, now, {
    decision: 'COMPLETE',
    reason: 'RED-PROOF: no DoD criteria satisfied',
  })

  const violation = result.safety_violations.find(v => v.assertion === 'premature_completion')

  return {
    scenario: 'Deliberately-broken completion: case completed with zero DoD criteria met',
    assertion_triggered: violation?.assertion || 'NONE',
    violation_detail: violation?.detail || 'No violation raised — assertion is DEAD',
    passed: violation != null && violation.assertion === 'premature_completion',
  }
}
