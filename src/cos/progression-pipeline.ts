// Autonomous Case Progression Layer v1.1 — the engine that moves cases.
// Checkpoint B (card 4a809934): first checkpoint with actual progression LOGIC.
// Checkpoint C (card 53f1fd06): resolver depth — email thread + memory lookup.
// Checkpoint D (card 6b7e7e5e): outcome contract / goal interpretation (LLM-based).
//
// Pipeline stages (plan §10-14):
//   0. Goal Enrichment    — LLM-interpreted goal + summary (lazy, first-run only)
//   1. Outcome Contract   — derive "what done means" for this case
//   2. Resolver           — resolve-before-ask: DB + email thread + memory
//   3. Rolling Plan       — ordered steps to reach the outcome
//   4. Next Best Action   — the very next thing to do
//   5. Owner answer       — consume an answer to the CURRENT question, once
//   6. Decision           — one of 10 valid progression decisions (§13)
//   7. Progression Run    — record in case_progression_runs (GATE 0 ledger)
//
// WHAT THIS FILE IS ALLOWED TO DO, as of today (the old header said otherwise
// and had been wrong for months — see below).
//
//   WRITES to personal_cases / zst_cases, via transitionCase only, in exactly
//   three situations, each of them the resolution of a question the engine
//   itself asked:
//     - the owner refused or abandoned      → BLOCKED
//     - the owner approved (AWAITING_APPROVAL, explicit YES) → READY
//     - plan exhausted AND the completion gate allows it     → COMPLETED
//   Everything else is a write to case_progression_state + case_progression_runs
//   and nothing more.
//
//   NEVER: email, dispatch, payment, or any outbound call. action_ids_json and
//   external_reference stay null on every row this file writes, because nothing
//   was sent or called. That part of the old invariant is still true and is the
//   one worth keeping.
//
//   REFUSES ENTIRELY while the §22 kill switch is engaged. The switch pauses the
//   whole Personal Chief; an engine that kept consuming answers and transitioning
//   cases through it would make the switch a label rather than a stop.
//
// WHY THE OLD HEADER WAS DELETED. It promised "ZERO side effects", "
// progression_enabled stays false, progression_mode stays 'shadow'". Intake and
// migrate seed 1/'internal', the file transitions cases to BLOCKED/READY/
// COMPLETED, and it has done so since Checkpoint E. The header described
// Checkpoint B and was read as though it described today — on the file with the
// widest blast radius in the system. A header that has to be checked against the
// code is worse than none.

import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { evaluateSafetyAssertions, type SafetyViolation } from './progression-eval.js'
import { recordProgressionEvents } from './progression-events.js'
import { resolveContextDeep, CrossDomainReadError, domainGuard, type DeepResolvedContext } from './progression-resolver.js'
import { interpretGoal, type LlmClient, type GoalInterpretation } from './progression-interpreter.js'
import { initializeDoDVerification, canCompleteCase, type DoDProvenance } from './progression-completion.js'
import { transitionCase, acquireClaim, releaseClaim } from './case-store.js'
import { transitionZstCase } from './zst-case-store.js'
import { scheduleNextProgression } from './progression-scheduler.js'
import { canonicalTriggerType } from './progression-trigger.js'
import { killSwitchRefusal } from './kill-switch.js'
import { discloseAndRecord, trustClassOfProvider, type FieldKind } from './disclosure.js'
import { egressTierFor } from './provider-data-policy.js'
import {
  preflight, enterWaitSystem, clearWaitSystem, type CapabilityPreflight,
} from './capability-preflight.js'
import { answerIntentOf, type AnswerIntent } from './answer-options.js'
import { CASE_STATUSES } from './schema.js'
import { evaluateCaseTemporalConsistency } from './temporal-consistency-gate.js'
// Two-node ESM cycle with case-projection, deliberate: see that module's header.
import { projectCase } from './case-projection.js'
import {
  SIDE_EFFECT_CLASS, capabilityCoverage, declareForPlanStep, enforceCapabilityContract,
  undeclaredContract, type CapabilityContract, type PlanStepKind,
} from './capability-contract.js'
import { resolveExecutionDependency, withResolvedDependency } from './capability-resolution.js'
import {
  armWaitCondition, evaluateWaitCondition, resolveWaitCondition, type ArmResult,
} from './wait-condition.js'

// ── Valid progression decisions (plan §13) ──────────────────────────────

export const VALID_DECISIONS = [
  'CONTINUE_AUTONOMOUSLY',
  'WAIT_EXTERNAL',
  'WAIT_TIME',
  'ASK_INFORMATION',
  'REQUEST_DECISION',
  'REQUEST_APPROVAL',
  'CALL_REQUIRED',
  'MANUAL_ACTION_REQUIRED',
  'RECOVERY_REQUIRED',
  'COMPLETE',
  // §19. ENGINE-ONLY, and the difference from the list in `reader.ts` is the
  // point rather than an oversight. This decision means "the machine cannot
  // proceed", and that is a fact about the deployment which the capability
  // preflight establishes deterministically — never something a model may
  // propose from reading a case. A Reader that could offer WAIT_SYSTEM could
  // excuse itself from a case by asserting a fault, and nothing downstream
  // would check.
  //
  // `reader.ts`'s PROGRESSION_DECISIONS is therefore a strict subset of this
  // list, and `cos-capability-preflight` asserts that it stays one.
  'WAIT_SYSTEM',
] as const

export type ProgressionDecision = (typeof VALID_DECISIONS)[number]

// ── Outcome contract ────────────────────────────────────────────────────

export interface OutcomeContract {
  /** Human-readable goal statement derived from the case. */
  goal: string
  /** Concrete, verifiable "done" criteria. Each criterion has a label and a
   *  boolean-only check description. In the thin slice these are derived from
   *  the case type + status; a full resolver would pull them from templates. */
  definitionOfDone: string[]
  /** What evidence is needed to prove each DoD criterion was met. */
  successEvidenceRequirements: string[]
  /** Where definitionOfDone came from. Carried all the way to
   *  dod_verification_json, because the completion gate has to know whether it
   *  is looking at this case's contract or at the template every case in this
   *  status shares. */
  dodProvenance: DoDProvenance
}

/** Derive an outcome contract from a case row. Thin slice: heuristic per case
 *  type — no template store, no LLM. The full feature set replaces this with
 *  a template-driven resolver that reads from a goal library.
 *
 *  Everything this function returns is GENERIC_STATUS_TEMPLATE, and will stay
 *  that way until something derives a DoD from the case itself. The goal line
 *  is per case TYPE and the DoD is per case STATUS, so every NEW case in the
 *  store gets the same three criteria: triaged, actions identified, owner
 *  assigned. Those describe the engine's own handling, not the outcome Istvan
 *  cares about — the water bill is not paid because the case was triaged.
 *  On 2026-08-09 that distinction was the difference between 26 open matters
 *  and 26 closed ones. */
export function deriveOutcomeContract(
  caseTitle: string,
  caseType: string,
  caseStatus: string,
  sensitivity: string,
): OutcomeContract {
  // Heuristic goal per case type
  const goalMap: Record<string, string> = {
    INVOICE_INCOMING: 'Befogadni, rogziteni a konyvelesben, es rendezni a szamlat',
    BILL: 'Befizetni a szamlat hataridore, visszaigazolast kapni',
    ADMIN: 'Elvegezni az adminisztracios feladatot, archiválni a bizonylatokat',
    TRAVEL: 'Lefoglalni es elokesziteni az utazast, minden szukseges doksit beszerezni',
    HOME_REPAIR: 'Megjavit(tat)ni a hibát, garancialisan vagy szamla elleneben',
    FINANCE: 'Rendezni a penzugyi tetelt, konyvelni, visszaigazolast kerni',
    HEALTH: 'Idopontot foglalni, elmenni, eredmenyt/esemenyt rogziteni',
    CAREER: 'Jelentkezni/lefolytatni a folyamatot, visszajelzest kerni',
    SHOPPING: 'Beszkennelni az arakat, megvenni vagy eldonteni hogy nem kell',
    PERSONAL: 'Elintezni a szemelyes ugyet, archiválni az eredmenyt',
    CALL: 'Telefonalni, elerni a celt, rogziteni az eredmenyt',
    VENDOR: 'Kivalasztani a beszallitot, szerzodni, teljesiteni',
    PARTNER: 'Feldolgozni a partneri egyuttmukodest, doksikat rendszerezni',
    CONTRACT: 'Atnezni, kommentalni, jovahagyni a szerzodest',
    ACCOUNTING: 'Konyvelni a tetelt, egyeztetni a bankkal/partnerrel',
    COMMERCIAL_OPPORTUNITY: 'Kiertekelni a lehetoseget, ajanlatot kerni/adni',
  }

  const goal = goalMap[caseType] ?? `Elintezni: ${caseTitle}`

  // Heuristic DoD per status
  const dodByStatus: Record<string, string[]> = {
    NEW: ['Case triaged', 'Required actions identified', 'Owner assigned'],
    READY: ['All prerequisites met', 'Next action clear', 'No blocking dependencies'],
    WAITING_EXTERNAL: ['External response received', 'Response evaluated', 'Next step decided'],
    EXECUTING: ['Current action completed', 'Result documented', 'Next step ready'],
    BLOCKED: ['Blocker identified and documented', 'Escalation path clear', 'Unblock plan exists'],
    INFORMATION_REQUIRED: ['Missing information identified', 'Information source contacted', 'Response received'],
    REVIEW_REQUIRED: ['Review completed', 'Decision documented', 'Next step communicated'],
    AWAITING_APPROVAL: ['Approval requested', 'Approval received or denied', 'Path chosen based on decision'],
    FOLLOW_UP_DUE: ['Follow-up action completed', 'Response evaluated', 'Next cycle planned'],
    RECOVERY_REQUIRED: ['Root cause identified', 'Recovery plan defined', 'First recovery step taken'],
    COMPLETED: ['All DoD criteria satisfied', 'Evidence archived', 'Stakeholders notified'],
  }

  const dod = dodByStatus[caseStatus] ?? ['Case progressed', 'Status updated', 'Next action clear']
  const evidenceReqs = dod.map(d => `Evidence: ${d.toLowerCase()}`)

  return {
    goal,
    definitionOfDone: dod,
    successEvidenceRequirements: evidenceReqs,
    dodProvenance: 'GENERIC_STATUS_TEMPLATE',
  }
}

// ── Resolver context ────────────────────────────────────────────────────

export interface ResolvedContext {
  /** Number of events in the case history. */
  eventCount: number
  /** Last event type + reason, for context. */
  lastEventType: string | null
  lastEventReason: string | null
  /** Whether the case has a parent (linked). */
  hasParent: boolean
  /** Whether the case has child cases. */
  hasChildren: boolean
  /** Days since case creation. */
  ageDays: number
  /** Days since the case ENTERED its current status.
   *
   *  Separate from ageDays because the two answer different questions and one
   *  of them was answering the wrong one: the external-wait escalation below
   *  used ageDays, so ANY case older than a week escalated to
   *  RECOVERY_REQUIRED on its FIRST cycle in WAITING_EXTERNAL — "external wait
   *  exceeded 7 days" about a wait that started a minute ago. WAIT_EXTERNAL was
   *  effectively unreachable for real cases (they are weeks old by the time
   *  anything waits on a third party) and the recovery queue filled with waits
   *  nobody had waited for. A wait is measured from when it started. */
  statusAgeDays: number
  /** The case's own scheduled wake, when it has one in the future. A wait
   *  bounded by a clock we already hold is WAIT_TIME, not WAIT_EXTERNAL. */
  nextWakeAt: number | null
  /** Case sensitivity tier. */
  sensitivity: string
}

// ── Rolling plan ────────────────────────────────────────────────────────

export interface RollingPlanStep {
  step: number
  label: string
  /** What kind of step this is — drives the decision engine. */
  kind: 'GATHER_INFO' | 'AWAIT_EXTERNAL' | 'AWAIT_DECISION' | 'EXECUTE' | 'VERIFY' | 'COMMUNICATE' | 'RECOVER'
  /** Whether this step needs external input before it can proceed. */
  needsExternal: boolean
  /** §19 hardening (owner, 2026-08-27): what this step DEPENDS ON, declared here
   *  at plan-build time rather than inferred at run time from what happens to be
   *  connected. The dependency is a property of the planned execution, not of the
   *  case and not of the deployment. Optional on the type so a plan written
   *  before this existed still parses; `contractFor` below supplies UNDECLARED,
   *  which is a different statement from "requires nothing" and is treated as
   *  one. */
  capabilities?: CapabilityContract
}

/** The contract a step carries, or the explicit absence of one. Never invents a
 *  requirement from the step's kind at READ time -- that would be the inference
 *  this design exists to refuse. It reads what the planner declared. */
export function contractFor(step: { capabilities?: CapabilityContract }): CapabilityContract {
  return step.capabilities ?? undeclaredContract()
}

/** Build a rolling plan from the outcome contract + resolved context. Thin
 *  slice: deterministic plan template per case status — no replanning triggers,
 *  no LLM planner. Each plan step maps to one of the 10 valid decisions. */
export function buildRollingPlan(
  contract: OutcomeContract,
  context: ResolvedContext,
  currentStatus: string,
): RollingPlanStep[] {
  const plan: RollingPlanStep[] = []

  // Step 1: Always verify what we know
  plan.push({ step: 1, label: 'Verify current state and gathered context', kind: 'VERIFY', needsExternal: false })

  // Status-specific steps
  switch (currentStatus) {
    case 'NEW':
    case 'TRIAGE':
      plan.push({ step: 2, label: 'Classify and prioritize the case', kind: 'GATHER_INFO', needsExternal: false })
      plan.push({ step: 3, label: 'Identify required actions and dependencies', kind: 'EXECUTE', needsExternal: false })
      break
    case 'INFORMATION_REQUIRED':
    case 'INFO_REQUIRED':
      plan.push({ step: 2, label: 'Gather missing information from relevant sources', kind: 'GATHER_INFO', needsExternal: true })
      plan.push({ step: 3, label: 'Evaluate gathered information against requirements', kind: 'VERIFY', needsExternal: false })
      break
    case 'WAITING_EXTERNAL':
      plan.push({ step: 2, label: 'Check for external response or escalate if overdue', kind: 'AWAIT_EXTERNAL', needsExternal: true })
      plan.push({ step: 3, label: 'Process response and decide next step', kind: 'EXECUTE', needsExternal: false })
      break
    case 'AWAITING_APPROVAL':
    case 'AWAITING_SELECTION':
      plan.push({ step: 2, label: 'Follow up on pending approval/selection', kind: 'AWAIT_DECISION', needsExternal: true })
      plan.push({ step: 3, label: 'Act on the received decision', kind: 'EXECUTE', needsExternal: false })
      break
    case 'READY':
      plan.push({ step: 2, label: 'Execute the next action in the work plan', kind: 'EXECUTE', needsExternal: false })
      plan.push({ step: 3, label: 'Document result and plan next cycle', kind: 'COMMUNICATE', needsExternal: false })
      break
    case 'EXECUTING':
      plan.push({ step: 2, label: 'Continue or complete the current execution step', kind: 'EXECUTE', needsExternal: false })
      plan.push({ step: 3, label: 'Verify execution result against expected outcome', kind: 'VERIFY', needsExternal: false })
      break
    case 'BLOCKED':
      plan.push({ step: 2, label: 'Identify and document the blocker precisely', kind: 'GATHER_INFO', needsExternal: false })
      plan.push({ step: 3, label: 'Escalate or resolve the blocking condition', kind: 'RECOVER', needsExternal: true })
      break
    case 'RECOVERY_REQUIRED':
      plan.push({ step: 2, label: 'Analyze what failed and define recovery path', kind: 'RECOVER', needsExternal: false })
      plan.push({ step: 3, label: 'Execute first recovery action', kind: 'EXECUTE', needsExternal: true })
      break
    case 'FOLLOW_UP_DUE':
      plan.push({ step: 2, label: 'Perform the scheduled follow-up check', kind: 'VERIFY', needsExternal: false })
      plan.push({ step: 3, label: 'Determine whether the case can advance or needs more waiting', kind: 'EXECUTE', needsExternal: false })
      break
    case 'CALL_REQUIRED':
      plan.push({ step: 2, label: 'Schedule and prepare for the call', kind: 'EXECUTE', needsExternal: false })
      plan.push({ step: 3, label: 'Place the call and document the outcome', kind: 'EXECUTE', needsExternal: true })
      break
    case 'COMPLETED':
      plan.push({ step: 2, label: 'Verify all DoD criteria are satisfied', kind: 'VERIFY', needsExternal: false })
      plan.push({ step: 3, label: 'Archive evidence and notify stakeholders', kind: 'COMMUNICATE', needsExternal: false })
      break
    case 'SCHEDULED':
      plan.push({ step: 2, label: 'Prepare for the scheduled event', kind: 'EXECUTE', needsExternal: false })
      plan.push({ step: 3, label: 'Execute at the scheduled time', kind: 'AWAIT_EXTERNAL', needsExternal: true })
      break
    default:
      plan.push({ step: 2, label: 'Assess current situation and determine next move', kind: 'GATHER_INFO', needsExternal: false })
      plan.push({ step: 3, label: 'Take the appropriate next step', kind: 'EXECUTE', needsExternal: false })
  }

  // Final step: verify DoD
  if (currentStatus !== 'COMPLETED') {
    plan.push({ step: plan.length + 1, label: 'Review progress against Definition of Done', kind: 'VERIFY', needsExternal: false })
  }

  // THE DECLARATION IS ATTACHED AT THE CHOKE POINT, not at each of the twenty-five
  // `plan.push` sites above. A per-site declaration is a list someone extends
  // without it -- and the step nobody remembered would carry no contract while
  // looking exactly like a step that needs nothing, which is the precise
  // confusion `source: UNDECLARED` exists to prevent. Attaching here covers the
  // steps that do not exist yet.
  return plan.map(step => ({ ...step, capabilities: declareForPlanStep(step.kind) }))
}

/**
 * Every label `buildRollingPlan` can ever emit — the closed set of INTERNAL
 * English plan-step strings.
 *
 * These are not only internal. `determineNextBestAction` copies the chosen
 * step's label verbatim into `description`, the Decision Package reads that as
 * the recommendation, and the owner question prints it as
 * "Javaslatom: Execute first recovery action" — English machine text offered to
 * a Hungarian reader as advice, with "igen — csináljam így" underneath.
 *
 * ENUMERATED BY DRIVING THE PLANNER, not by hand.
 *
 * The first attempt at blocking this was a regex over the English words in the
 * ONE sample I had seen ("check", "escalate", "overdue"). It passed its tests,
 * shipped, and let "Execute first recovery action" through on the live store an
 * hour later — because a blocklist of yesterday's words is not a description of
 * the class. The class is enumerable: it is exactly the labels below, and a
 * label added to the switch is in this set the moment it exists.
 */
export function internalPlanLabels(): Set<string> {
  const labels = new Set<string>()
  const stubContract = {} as OutcomeContract
  const stubContext = {} as ResolvedContext
  // Plus one status the switch has never heard of, so the `default` branch's
  // labels are in the set too.
  for (const status of [...CASE_STATUSES, '__NO_SUCH_STATUS__']) {
    for (const step of buildRollingPlan(stubContract, stubContext, status)) labels.add(step.label)
  }
  return labels
}

// ── Next Best Action ────────────────────────────────────────────────────

export interface NextBestAction {
  /** The plan step index this NBA corresponds to. */
  planStep: number
  /** Human-readable description of what to do. */
  description: string
  /** The kind of action — determines the decision. */
  kind: RollingPlanStep['kind']
  /** Whether this action can proceed autonomously. */
  canProceedAutonomously: boolean
  /** Estimated effort in minutes (for prioritization). */
  estimatedEffortMinutes: number
}

/** Pick the Next Best Action from the rolling plan, skipping steps that
 *  were already completed in a previous run. The NBA is the first
 *  uncompleted step — the very next thing to do, even if it requires
 *  external input. The decision engine then determines whether that step
 *  can proceed autonomously or needs to wait. */
export function determineNextBestAction(
  plan: RollingPlanStep[],
  _context: ResolvedContext,
  completedPlanStep: number = 0,
): NextBestAction {
  // Find the first step whose index is past the last completed one
  const chosen = plan.find(s => s.step > completedPlanStep) ?? plan[0]

  const canProceed = !chosen.needsExternal

  return {
    planStep: chosen.step,
    description: chosen.label,
    kind: chosen.kind,
    canProceedAutonomously: canProceed,
    estimatedEffortMinutes: chosen.kind === 'EXECUTE' ? 15 : 5,
  }
}

// ── Owner answer consumption ─────────────────────────────────────────────
//
// When the pipeline returns REQUEST_DECISION / REQUEST_APPROVAL, Mission
// Control shows a button to the owner (and the Telegram path writes the same
// event). The answer arrives as an event in personal_case_events (or
// zst_case_events) with:
//   event_type      = OWNER_DECISION | OWNER_INFORMATION | OWNER_CONFIRMATION
//   source_system   = mission_control | telegram
//   source_reference = the progression_run_id that was current when they pressed
//   payload         = { choice: "YES" | "NO" | "CANCEL" | … } — see answer-options
//
// An answer has three properties this code has to get right, and it used to get
// all three wrong at once. They are one question — what does this answer MEAN
// and how long does it mean it — so they are answered in one place:
//
//   WHICH QUESTION IT ANSWERS. A question is identified by its CONTENT —
//   (decision, nbaStep) — not by the run that asked it. Heartbeat runs re-ask
//   the same question every 5 minutes with a new run ID, so matching by run ID
//   would permanently strand answers written between heartbeats.
//
//   WHEN IT WAS GIVEN. Content identity alone has no clock in it, and plan
//   wrap-around (completed_plan_step resets to 0 when the plan is exhausted)
//   makes the same (decision, nbaStep) tuple recur BY DESIGN. So a YES given to
//   an approval question in March was still a valid answer to a DIFFERENT
//   approval question asked in November: the case re-entered AWAITING_APPROVAL,
//   the run stabilised on the same tuple, and the year-old YES approved the new
//   request without the owner seeing it. An answer is now only considered if it
//   was written AFTER the case entered the status it is currently asking from.
//
//   HOW OFTEN IT COUNTS. Once. The consuming run records the event id in its own
//   progress_delta_json, and an event already named by an earlier run of this
//   case is never consumed again. The ledger row IS the consumed-marker, which
//   is also why the audit trail can now answer "which answer moved this case".
//
//   WHAT IT MEANS. See answer-options.ts: the option vocabulary carries an
//   intent, and the engine reads the intent. "Lemondjuk" is not "go ahead".

interface OwnerAnswer {
  /** Primary key of the consumed event, recorded on the run that consumes it. */
  eventId: number
  /** The event type that was matched. */
  eventType: string
  /** The owner's choice, when the payload carried one. */
  choice: string | null
  /** What the engine should DO about it. */
  intent: AnswerIntent
  /** The progression_run_id that the answer event references. */
  answeredRunId: string
  /** The NBA step that was being asked about (from the referenced run). */
  answeredNbaStep: number
}

/** When did this case last ENTER the given status?
 *
 *  Reads the append-only event log: the newest STATUS_CHANGED whose new_status
 *  is the one asked about. A case that has never changed status (created in it)
 *  falls back to its creation time. Used for two things that both need "since
 *  when", not "how old": the external-wait escalation clock, and the lower bound
 *  on which owner answers may still be about the question being asked now. */
export function statusEnteredAt(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  status: string,
): number | null {
  const tableName = domain === 'personal' ? 'personal_cases' : 'zst_cases'
  const eventsTable = domain === 'personal' ? 'personal_case_events' : 'zst_case_events'
  const ev = db.prepare(
    `SELECT created_at FROM ${eventsTable}
     WHERE case_id = ? AND new_status = ?
     ORDER BY created_at DESC, event_id DESC LIMIT 1`,
  ).get(caseId, status) as { created_at: number } | undefined
  if (ev) return ev.created_at
  const row = db.prepare(`SELECT created_at FROM ${tableName} WHERE case_id = ?`)
    .get(caseId) as { created_at: number } | undefined
  return row?.created_at ?? null
}

/** What the engine should do about an answer, from the event type and the
 *  choice. The CHOICE decides when there is one — an OWNER_INFORMATION carrying
 *  `{choice:"CANCEL"}` is a cancellation whatever the event is labelled.
 *
 *  An OWNER_DECISION whose payload yielded no choice is UNMAPPED, never a yes.
 *  That case is not hypothetical: the payload parse is a try/catch, so malformed
 *  JSON produced choice:null, and the old branch read "not NO" as approval. A
 *  decision event that does not say what was decided is exactly the input this
 *  engine must refuse to interpret. */
export function answerIntent(eventType: string, choice: string | null): AnswerIntent {
  if (choice != null && choice.trim() !== '') return answerIntentOf(choice)
  if (eventType === 'OWNER_DECISION') return 'UNMAPPED'
  // OWNER_INFORMATION / OWNER_CONFIRMATION with no choice: he answered in
  // words. That settles an information/decision step; it never grants an
  // approval (the approval branch demands an explicit YES).
  return 'INFORM'
}

/** Check whether the owner has answered the CURRENT question, exactly once.
 *
 *  Returns the answer if the latest owner event (a) references a run that asked
 *  the same (decision, nbaStep), (b) was written after the case entered its
 *  current status, and (c) has not already been consumed by an earlier run of
 *  this case. Null otherwise — including "the newest answer is already spent",
 *  which deliberately does NOT fall back to an older one. */
function consumeOwnerAnswer(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  currentDecision: ProgressionDecision,
  currentNbaStep: number,
  /** Answers older than this are about an earlier episode of this case. */
  notBefore: number | null,
): OwnerAnswer | null {
  // 1. Find the latest owner answer event for this case (any type), no older
  //    than the current status episode.
  const eventsTable = domain === 'personal' ? 'personal_case_events' : 'zst_case_events'
  const answerEvent = db.prepare(
    `SELECT event_id, event_type, payload, source_reference
     FROM ${eventsTable}
     WHERE case_id = ?
       AND event_type IN ('OWNER_DECISION', 'OWNER_INFORMATION', 'OWNER_CONFIRMATION')
       AND created_at >= ?
     ORDER BY created_at DESC, event_id DESC LIMIT 1`,
  ).get(caseId, notBefore ?? 0) as {
    event_id: number
    event_type: string
    payload: string | null
    source_reference: string | null
  } | undefined

  if (!answerEvent) return null

  // 2. Already consumed? The run that acted on an answer names it in its own
  //    progress delta, so the ledger is the marker. One answer, one effect.
  const alreadyConsumed = db.prepare(
    `SELECT 1 FROM case_progression_runs
     WHERE domain = ? AND case_id = ?
       AND json_extract(progress_delta_json, '$.consumedAnswerEventId') = ?
     LIMIT 1`,
  ).get(domain, caseId, answerEvent.event_id)
  if (alreadyConsumed) return null

  // 3. Look up the run that the answer references (source_reference = run ID).
  //    If source_reference is missing or the run is gone, we cannot verify
  //    question identity — treat as stale.
  if (!answerEvent.source_reference) return null

  const referencedRun = db.prepare(
    `SELECT decision, progress_delta_json
     FROM case_progression_runs
     WHERE progression_run_id = ? AND domain = ? AND case_id = ?`,
  ).get(answerEvent.source_reference, domain, caseId) as {
    decision: string | null
    progress_delta_json: string | null
  } | undefined

  if (!referencedRun) return null

  // 4. Extract the question that was asked in the referenced run.
  const referencedDecision = referencedRun.decision
  let referencedNbaStep = 0
  if (referencedRun.progress_delta_json) {
    try {
      const delta = JSON.parse(referencedRun.progress_delta_json) as { nbaStep?: number }
      referencedNbaStep = delta.nbaStep ?? 0
    } catch { /* ignore */ }
  }

  // 5. Does the referenced question match the CURRENT question?
  //    Same decision + same nbaStep → same question → answer is valid.
  //    Different → question has genuinely changed → answer is stale.
  if (referencedDecision !== currentDecision || referencedNbaStep !== currentNbaStep) {
    return null
  }

  // 6. Parse the payload for a choice. A payload that will not parse leaves
  //    choice null, which answerIntent() reads as UNMAPPED for a decision
  //    event — the failure is not swallowed, it changes the meaning.
  let choice: string | null = null
  if (answerEvent.payload) {
    try {
      const parsed = JSON.parse(answerEvent.payload) as { choice?: string | null }
      choice = parsed.choice ?? null
    } catch { /* unparsable payload → no choice → UNMAPPED */ }
  }

  return {
    eventId: answerEvent.event_id,
    eventType: answerEvent.event_type,
    choice,
    intent: answerIntent(answerEvent.event_type, choice),
    answeredRunId: answerEvent.source_reference,
    answeredNbaStep: referencedNbaStep,
  }
}

// ── Decision engine ─────────────────────────────────────────────────────

/** Map the NBA kind + context to one of the 10 valid progression decisions. */
export function decide(
  nba: NextBestAction,
  context: ResolvedContext,
  currentStatus: string,
): { decision: ProgressionDecision; reason: string } {
  // Terminal status → COMPLETE
  if (currentStatus === 'COMPLETED') {
    return { decision: 'COMPLETE', reason: 'Case already completed; verifying DoD closure' }
  }

  // Recovery status → RECOVERY_REQUIRED
  if (currentStatus === 'RECOVERY_REQUIRED' || currentStatus === 'BLOCKED') {
    return { decision: 'RECOVERY_REQUIRED', reason: `Case is ${currentStatus.toLowerCase()}; recovery plan needed` }
  }

  // External-wait status → WAIT_EXTERNAL (unless overdue, then escalate).
  // The clock runs from when the WAIT started, not from when the case was
  // created — see ResolvedContext.statusAgeDays for what measuring the wrong
  // one cost.
  if (currentStatus === 'WAITING_EXTERNAL') {
    if (context.statusAgeDays > 7) {
      return { decision: 'RECOVERY_REQUIRED', reason: `External wait exceeded 7 days (${context.statusAgeDays}d); escalation needed` }
    }
    if (context.nextWakeAt !== null) {
      return { decision: 'WAIT_TIME', reason: `Waiting until the scheduled wake (${context.nextWakeAt})` }
    }
    return { decision: 'WAIT_EXTERNAL', reason: 'Case is waiting for external response' }
  }

  // Information-gap status → ASK_INFORMATION
  if (currentStatus === 'INFORMATION_REQUIRED' || currentStatus === 'INFO_REQUIRED') {
    return { decision: 'ASK_INFORMATION', reason: 'Missing information is blocking progress' }
  }

  // Approval status → REQUEST_APPROVAL
  if (currentStatus === 'AWAITING_APPROVAL') {
    return { decision: 'REQUEST_APPROVAL', reason: 'Approval required before proceeding' }
  }

  // Call status → CALL_REQUIRED
  if (currentStatus === 'CALL_REQUIRED') {
    return { decision: 'CALL_REQUIRED', reason: 'Phone call is the next required action' }
  }

  // NBA kind → decision mapping (for statuses not explicitly handled above)
  switch (nba.kind) {
    case 'GATHER_INFO':
      if (nba.canProceedAutonomously) {
        return { decision: 'CONTINUE_AUTONOMOUSLY', reason: 'Information gathering can proceed without external input' }
      }
      return { decision: 'ASK_INFORMATION', reason: 'Missing information requires external input' }

    case 'AWAIT_EXTERNAL':
      // Overdue is measured from the start of the wait, not the birth of the
      // case. WAIT_TIME wins when the wait is bounded by a clock we hold: that
      // is the one decision in §13 that names "nothing to do until then", and
      // it is what gives the wake scheduler a producer.
      if (context.statusAgeDays > 7) {
        return { decision: 'RECOVERY_REQUIRED', reason: `External wait exceeded 7 days (${context.statusAgeDays}d); escalation needed` }
      }
      if (context.nextWakeAt !== null) {
        return { decision: 'WAIT_TIME', reason: `Waiting until the scheduled wake (${context.nextWakeAt})` }
      }
      return { decision: 'WAIT_EXTERNAL', reason: 'Waiting for external response or event' }

    case 'AWAIT_DECISION':
      return { decision: 'REQUEST_DECISION', reason: 'Decision required from stakeholder before proceeding' }

    case 'EXECUTE':
      if (nba.canProceedAutonomously) {
        return { decision: 'CONTINUE_AUTONOMOUSLY', reason: 'Next action can be executed autonomously in shadow mode' }
      }
      return { decision: 'MANUAL_ACTION_REQUIRED', reason: 'Action requires manual execution (call, meeting, physical task)' }

    case 'VERIFY':
      return { decision: 'CONTINUE_AUTONOMOUSLY', reason: 'Verification can proceed autonomously against available evidence' }

    case 'COMMUNICATE':
      // In shadow mode, communication is a no-op but the decision is recorded
      return { decision: 'CONTINUE_AUTONOMOUSLY', reason: 'Communication step documented; shadow mode — no actual send' }

    case 'RECOVER':
      return { decision: 'RECOVERY_REQUIRED', reason: 'Recovery step identified; needs explicit recovery plan execution' }

    default:
      return { decision: 'CONTINUE_AUTONOMOUSLY', reason: 'Default autonomous progression' }
  }
}

// ── Progression run result ──────────────────────────────────────────────

/** The audit chain the owner asked for by name, 2026-08-27. */
export interface CapabilityTrail {
  action: string
  kind: string
  resolution: 'RESOLVED' | 'NOT_REQUIRED' | 'UNRESOLVED'
  target: string | null
  required: string[]
  verdict: string
  reason: string
}

export interface ProgressionRunResult {
  runId: string
  domain: 'personal' | 'zst'
  caseId: string
  /** null when the cycle REFUSED to run (kill switch, claim held by another
   *  runner). No decision was reached, and naming a plausible one would put a
   *  state into the ledger that nothing decided. */
  decision: ProgressionDecision | null
  reason: string
  status: 'COMPLETED' | 'FAILED'
  errorCode: string | null
  errorSummary: string | null
  safetyViolations: SafetyViolation[]
  /** §19 closure B: planned action -> resolved target -> required capability ->
   *  preflight verdict, for the run that made the decision. Present on every
   *  successful run, including the ones that proceeded: a trail that appears
   *  only on failure cannot show the check ran. */
  capabilityTrail?: CapabilityTrail
  /** Set only when the pipeline ran successfully. */
  planVersion?: number
  goalVersion?: number
}

// ── Goal enrichment (Checkpoint D — lazy LLM interpretation) ───────────

/** Enrich a case with LLM-interpreted goal and summary. Idempotent: interpreted
 *  once per case, never repeated.
 *
 *  THE IDEMPOTENCE MARKER IS `summary`, NOT `goal` — fixed 2026-08-10, and the
 *  distinction is the difference between this function working and not.
 *
 *  It used to return early when `goal` was non-empty. But the deterministic
 *  pipeline writes `goal` on every single run from deriveOutcomeContract's
 *  status template, so by the time anything could call this, all 98 live cases
 *  already had one. Wiring the enricher up would have changed nothing: every
 *  case would have taken the early return and reported interpreted:false.
 *
 *  `summary` is written by exactly one thing — this function — and the pipeline
 *  explicitly preserves it. So an empty summary means "the LLM has never seen
 *  this case", which is the question the guard is actually asking.
 *
 *  Domain-scoped: calls domainGuard() before interpretation. */
export async function enrichCaseGoal(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  llmClient: LlmClient,
  emailThreadContent?: string,
  /** W13 / §7.4: WHERE this prompt is going. The disclosure decision needs a
   *  destination, and a caller that does not name one is treated as an unknown
   *  destination — which, for anything at PERSONAL or above, discloses nothing.
   *  Fail-closed by construction rather than by the caller remembering. */
  opts: { provider?: string; runId?: string | null } = {},
): Promise<{ interpreted: boolean; goal: string; summary: string; title: string; disclosureRecordId?: string; blockedByDisclosure?: boolean }> {
  // Lazy: if already enriched, return existing
  const existing = db.prepare(
    'SELECT goal, summary FROM case_progression_state WHERE domain = ? AND case_id = ?',
  ).get(domain, caseId) as { goal: string | null; summary: string | null } | undefined

  if (existing?.summary && existing.summary.trim().length > 0) {
    return {
      interpreted: false,
      goal: existing.goal ?? '',
      summary: existing.summary,
      title: '',
    }
  }

  // Domain-scoped read guard
  domainGuard(db, domain, caseId, 'enrichCaseGoal')

  // Read case metadata
  const tableName = domain === 'personal' ? 'personal_cases' : 'zst_cases'
  const caseRow = db.prepare(
    `SELECT title, case_type, description, sensitivity FROM ${tableName} WHERE case_id = ?`,
  ).get(caseId) as { title: string; case_type: string; description: string | null; sensitivity?: unknown } | undefined

  if (!caseRow) {
    throw new Error(`Case not found: ${domain}/${caseId}`)
  }

  // ── W13 / §7.4: the DISCLOSURE DECISION, before anything leaves ──────────
  //
  // This is the LLM reading path, and until now it handed the provider the case
  // title, the description and the whole email thread, gated only by a tier
  // check deciding WHETHER the case could go at all. Which FIELDS travel was
  // never a decision anyone made.
  //
  // THE TIER IS DERIVED HERE, not accepted from the caller. A caller-supplied
  // sensitivity would be a bypass: the one thing a caller must not be able to
  // do is declare the data less sensitive than it is. `egressTierFor` is the
  // same function the reader and the enrichment router already use, so this is
  // one definition consulted again, not a second one.
  const content = emailThreadContent ?? caseRow.description ?? ''
  const sensitivity = egressTierFor(
    domain,
    (caseRow as { sensitivity?: unknown }).sensitivity,
    [caseRow.title, caseRow.description ?? '', content].join('\n'),
  )
  const provider = opts.provider ?? 'unknown'
  const REQUIRED: FieldKind[] = ['SUBJECT', 'SUMMARY', 'BODY_FULL']
  const { disclosed, recordId, decision } = discloseAndRecord(db, {
    actor: 'cos-goal-enrichment', onBehalfOf: 'istvan', runId: opts.runId ?? null,
    destination: 'llm:' + provider,
    trustClass: trustClassOfProvider(provider),
    taskTier: 'SUMMARIZE_EXTRACT',
    caseSensitivity: sensitivity,
    fields: [
      { kind: 'SUBJECT', value: caseRow.title ?? '' },
      { kind: 'SUMMARY', value: caseRow.description ?? '' },
      { kind: 'BODY_FULL', value: content },
    ],
    // Minimum necessary for THIS task: the goal interpreter reads a subject, a
    // description and the thread. It has never needed the sender, and it is not
    // offered one.
    requiredFields: REQUIRED,
  }, Math.floor(Date.now() / 1000))

  const byKind = new Map(disclosed.map(d => [d.kind, d.value]))
  // Nothing survived the policy: do NOT call the model. An empty prompt would
  // produce a confident-sounding goal derived from nothing, which is worse than
  // no goal at all — and the caller can tell the two apart.
  if (byKind.size === 0) {
    return {
      interpreted: false, goal: '', summary: '', title: '',
      disclosureRecordId: recordId, blockedByDisclosure: true,
    }
  }

  // Interpret via LLM — on the DISCLOSED values, never the raw ones.
  const interpretation = await interpretGoal(
    llmClient,
    byKind.get('SUBJECT') ?? '',
    caseRow.case_type,
    byKind.get('SUMMARY') ?? null,
    byKind.get('BODY_FULL') ?? '',
  )
  void decision

  const now = Math.floor(Date.now() / 1000)

  // Write to case_progression_state (lazy enrichment — writes only here)
  const stateExists = db.prepare(
    'SELECT 1 FROM case_progression_state WHERE domain = ? AND case_id = ?',
  ).get(domain, caseId)

  if (stateExists) {
    db.prepare(
      `UPDATE case_progression_state
       SET goal = ?, summary = ?, goal_version = goal_version + 1, updated_at = ?
       WHERE domain = ? AND case_id = ?`,
    ).run(interpretation.goal, interpretation.summary, now, domain, caseId)
  } else {
    db.prepare(
      `INSERT INTO case_progression_state
       (domain, case_id, goal, summary, progression_enabled, progression_mode,
        case_version, goal_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 'shadow', 0, 1, ?, ?)`,
    ).run(domain, caseId, interpretation.goal, interpretation.summary, now, now)
  }

  return {
    interpreted: true,
    disclosureRecordId: recordId,
    goal: interpretation.goal,
    summary: interpretation.summary,
    title: interpretation.title,
  }
}

// ── Main pipeline ───────────────────────────────────────────────────────

export interface PipelineOptions {
  /** Caller-supplied trigger type for the progression run. */
  /** The old six plus §10.8's vocabulary. SCHEDULED remains legal for callers
   *  that genuinely mean "a periodic sweep"; the heartbeat no longer uses it. */
  triggerType?: 'SCHEDULED' | 'MANUAL' | 'WAKE' | 'INTAKE' | 'ESCALATION_RESOLVED' | 'RECOVERY'
    | 'NEW_RELEVANT_EVENT' | 'WAIT_WAKE_DUE' | 'FOLLOW_UP_DUE' | 'APPROVAL_RESOLVED'
    | 'DECISION_RESOLVED' | 'USER_INPUT' | 'CAPABILITY_RECOVERED' | 'MANUAL_REVIEW_REQUEST'
  /** Optional trigger reference (e.g. message ID, schedule name). */
  triggerReference?: string
  /** The run id of a caller that ALREADY holds this case's progression claim.
   *  The heartbeat does; every other caller (the dashboard route, the migration
   *  sweep, a script) historically did not, and two runners on the same case
   *  produced duplicate run rows plus a racing answer-consumption transition —
   *  the loser threw on seenVersion, the throw was swallowed, and its state
   *  writes stood. So the cycle claims for itself unless told otherwise: being
   *  protected is the default, and remembering to claim is not a thing a caller
   *  can forget any more. */
  claimedBy?: string
  /** §19: the INTERNAL capabilities this run needs before it may reason about
   *  the case. Names as `capability-preflight.ts` understands them.
   *
   *  Absent or empty means "declare nothing", and a run that declares nothing
   *  behaves exactly as it did before the preflight existed — not a database
   *  read, not a branch taken. That is what lets each caller adopt this
   *  deliberately rather than the whole engine discovering it in production on
   *  the same day. */
  requiredCapabilities?: readonly string[]
}

/** Lease length for the claim the cycle takes for itself. Matches the
 *  heartbeat's, so a crashed run blocks the case for the same bounded time
 *  whichever path started it. */
export const PROGRESSION_CLAIM_TTL_SEC = 300

/**
 * §19: record a run that stopped because the MACHINE could not proceed.
 *
 * `status: 'COMPLETED'`, and that is the whole argument of this function. The
 * engine did exactly what it should: it checked, found a fault, parked the case
 * and said which capability it is parked on. Writing FAILED here would put a
 * system outage into the same bucket as an engine defect, and the daily
 * reconcile's `cycleErrors` — which exists to find engine defects — would fill
 * up with weather.
 *
 * `decision: 'WAIT_SYSTEM'` is what keeps it off the owner's board. Every other
 * terminal decision in this vocabulary either advances the case or asks him
 * something; this one does neither, on purpose.
 */
function recordWaitSystemRun(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  blocker: CapabilityPreflight,
  opts: PipelineOptions,
  now: number,
): ProgressionRunResult {
  const runId = randomUUID()
  const reason = `A rendszer vár egy képességre: ${blocker.capability} — ${blocker.detail}`
  try {
    enterWaitSystem(db, domain, caseId, blocker, now)
  } catch { /* no progression state row: the run is still recorded below */ }
  try {
    db.prepare(
      `INSERT INTO case_progression_runs
       (progression_run_id, domain, case_id, trigger_type, trigger_reference,
        case_version_before, case_version_after, goal_version,
        plan_version_before, plan_version_after, decision, reason,
        progress_delta_json, action_ids_json, escalation_id,
        status, error_code, error_summary, safety_assertions_json,
        started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 'WAIT_SYSTEM', ?, ?, NULL, NULL,
        'COMPLETED', NULL, NULL, NULL, ?, ?)`,
    ).run(
      runId, domain, caseId,
      canonicalTriggerType(opts.triggerType ?? 'MANUAL'), opts.triggerReference ?? 'preflight',
      reason,
      JSON.stringify({ waitSystem: blocker.capability, state: blocker.state, retryable: blocker.retryable }),
      now, now,
    )
  } catch { /* a store without the runs table cannot be told; the wait stands */ }
  return {
    runId, domain, caseId,
    decision: 'WAIT_SYSTEM',
    reason,
    status: 'COMPLETED',
    errorCode: null,
    errorSummary: null,
    safetyViolations: [],
  }
}

/** Record a FAILED progression run with CROSS_DOMAIN_LEAKAGE error code
 *  (shared helper — used from case lookup guard and resolver catch block). */
function recordCrossDomainLeakageRun(
  db: Database.Database,
  runId: string,
  domain: 'personal' | 'zst',
  caseId: string,
  message: string,
  triggerType: string,
  triggerReference: string,
  now: number,
): ProgressionRunResult {
  const sv: SafetyViolation[] = [{
    assertion: 'cross_domain_leakage',
    case_id: caseId,
    domain,
    detail: message,
  }]
  const sJson = JSON.stringify(evaluateSafetyAssertions({
    run_id: runId, domain, case_id: caseId,
    decision: 'RECOVERY_REQUIRED', reason: message,
    status: 'FAILED', error_code: 'CROSS_DOMAIN_LEAKAGE', error_summary: message,
    safety_violations: sv,
  }))
  db.prepare(
    `INSERT INTO case_progression_runs
     (progression_run_id, domain, case_id, trigger_type, trigger_reference,
      case_version_before, case_version_after, goal_version,
      plan_version_before, plan_version_after, decision, reason,
      progress_delta_json, action_ids_json, escalation_id,
      status, error_code, error_summary, safety_assertions_json,
      started_at, completed_at)
     VALUES (?, ?, ?, ?, ?,
             ?, ?, ?,
             ?, ?, ?, ?,
             ?, NULL, NULL,
             ?, ?, ?, ?,
             ?, ?)`,
  ).run(
    runId, domain, caseId,
    triggerType, triggerReference,
    0, 0, 0,
    0, 0, 'RECOVERY_REQUIRED', message,
    JSON.stringify({ error: 'CROSS_DOMAIN_LEAKAGE', detail: message }),
    'FAILED', 'CROSS_DOMAIN_LEAKAGE', message, sJson,
    now, now,
  )
  return {
    runId,
    domain,
    caseId,
    decision: 'RECOVERY_REQUIRED',
    reason: message,
    status: 'FAILED',
    errorCode: 'CROSS_DOMAIN_LEAKAGE',
    errorSummary: message,
    safetyViolations: sv,
  }
}

/** Record a run that did NOT happen, and why.
 *
 *  A refusal is a fact about the engine's behaviour and belongs in the same
 *  ledger as the runs that did happen — otherwise "the engine went quiet for an
 *  hour" has no record explaining it. The decision column is NULL on purpose:
 *  no decision was reached, and writing a plausible one (the first version used
 *  RECOVERY_REQUIRED, borrowed from the leakage path) would put a state into
 *  Mission Control that nothing decided. */
function recordRefusedRun(
  db: Database.Database,
  runId: string,
  domain: 'personal' | 'zst',
  caseId: string,
  errorCode: string,
  message: string,
  opts: PipelineOptions,
  now: number,
): ProgressionRunResult {
  const sJson = JSON.stringify(evaluateSafetyAssertions({
    run_id: runId, domain, case_id: caseId,
    decision: '', reason: message,
    status: 'FAILED', error_code: errorCode, error_summary: message,
    safety_violations: [],
  }))
  try {
    db.prepare(
      `INSERT INTO case_progression_runs
       (progression_run_id, domain, case_id, trigger_type, trigger_reference,
        case_version_before, case_version_after, goal_version,
        plan_version_before, plan_version_after, decision, reason,
        progress_delta_json, action_ids_json, escalation_id,
        status, error_code, error_summary, safety_assertions_json,
        started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, NULL, ?, ?, NULL, NULL, 'FAILED', ?, ?, ?, ?, ?)`,
    ).run(
      runId, domain, caseId,
      canonicalTriggerType(opts.triggerType ?? 'MANUAL'), opts.triggerReference ?? 'refused',
      message, JSON.stringify({ refused: errorCode, detail: message }),
      errorCode, message, sJson, now, now,
    )
  } catch { /* a store without the runs table cannot be told; the refusal stands */ }
  return {
    runId, domain, caseId,
    decision: null,
    reason: message,
    status: 'FAILED',
    errorCode,
    errorSummary: message,
    safetyViolations: [],
  }
}

/** The §22 master switch, read defensively.
 *
 *  `cos_autonomy_global` is created by ensureLadderSchema, which a store that
 *  only ran initCosSchema has never called. A missing table is not an engaged
 *  switch — it is a store where the switch has never been installed — and
 *  killSwitchState documents the same fail-safe direction for a missing ROW. */
function progressionKillSwitchRefusal(db: Database.Database): string | null {
  try {
    return killSwitchRefusal(db)
  } catch {
    return null
  }
}

/** Run ONE progression cycle for a case.
 *
 *  The pipeline:
 *    1. Reads the case row from the appropriate table
 *    2. Derives/updates the outcome contract
 *    3. Resolves context (DB-only, no external sources)
 *    4. Builds or refreshes the rolling plan
 *    5. Determines the Next Best Action
 *    6. Consumes an owner answer to the CURRENT question, at most once
 *    7. Makes a progression decision
 *    8. Evaluates hard safety assertions
 *    9. Writes progression state + run record
 *
 *  Three things wrap the cycle, and all three are the cycle's own job rather
 *  than the caller's:
 *
 *    THE KILL SWITCH. §22 says the master switch pauses the whole Personal
 *    Chief. It reached executor-core and permits(); it did not reach here, so an
 *    engaged switch left the engine consuming answers, transitioning cases and
 *    writing state. Checked first, refused with a recorded reason.
 *
 *    THE CLAIM. Taken here unless the caller says it already holds one, so a
 *    second runner on the same case cannot interleave with this one.
 *
 *    THE TRANSACTION. Everything the cycle writes lands or none of it does. It
 *    writes a run row, a state row, a step counter and possibly a status
 *    transition; a crash between them used to leave a case advanced by a run
 *    that is not in the ledger.
 *
 *  Returns the run result. Throws on DB errors only. */
export function runProgressionCycle(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  now: number,
  opts: PipelineOptions = {},
): ProgressionRunResult {
  const refusal = progressionKillSwitchRefusal(db)
  if (refusal) {
    return recordRefusedRun(db, randomUUID(), domain, caseId, 'KILL_SWITCH_ENGAGED',
      `A haladás-motor leállt: ${refusal}`, opts, now)
  }

  // §19 CAPABILITY PREFLIGHT, before the case is read and before anything
  // reasons about it.
  //
  // Here rather than inside the transaction because the answer is about the
  // DEPLOYMENT, not about this case: fifty cases blocked on the same dead
  // connector should each find out as cheaply as possible, and none of them
  // should have opened a transaction to do it.
  const pre = preflight(db, opts.requiredCapabilities, now)
  if (!pre.ok && pre.blocker) {
    return recordWaitSystemRun(db, domain, caseId, pre.blocker, opts, now)
  }
  // The capability is back. Clearing the wait BEFORE the run means the run
  // itself is an ordinary one — the recovery is a fact about the case's history,
  // recorded by the trigger type, not a special mode the cycle runs in.
  clearWaitSystem(db, domain, caseId, now)

  const body = (): ProgressionRunResult => db.transaction(
    () => runProgressionCycleInner(db, domain, caseId, now, opts),
  )()

  if (opts.claimedBy) return body()

  // Self-claim. A failure to MIRROR the claim (no case_claims table on an old
  // store) must never block the run — exclusion is best-effort here, the same
  // posture the heartbeat takes. A claim held by SOMEONE ELSE is different: that
  // is the race this exists for, and it refuses.
  const claimKey = `progression:${domain}:${caseId}`
  const claimRunId = `cycle-${randomUUID()}`
  let claim: { acquired: boolean; fence: number } | null = null
  try {
    claim = acquireClaim(db, { claimKey, ownerRunId: claimRunId, ttlSeconds: PROGRESSION_CLAIM_TTL_SEC }, now)
  } catch {
    claim = null
  }
  if (claim && !claim.acquired) {
    return recordRefusedRun(db, randomUUID(), domain, caseId, 'PROGRESSION_CLAIM_HELD',
      `Another runner holds ${claimKey}`, opts, now)
  }
  try {
    return body()
  } finally {
    if (claim?.acquired) {
      try { releaseClaim(db, { claimKey, ownerRunId: claimRunId, fence: claim.fence }) } catch { /* the lease expires anyway */ }
    }
  }
}

function runProgressionCycleInner(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  now: number,
  opts: PipelineOptions = {},
): ProgressionRunResult {
  const runId = randomUUID()
  const tableName = domain === 'personal' ? 'personal_cases' : 'zst_cases'

  // 1. Read the case
  const caseRow = db.prepare(
    `SELECT title, case_type, status, sensitivity, version, created_at, next_wake_at FROM ${tableName} WHERE case_id = ?`,
  ).get(caseId) as { title: string; case_type: string; status: string; sensitivity: string; version: number; created_at: number; next_wake_at: number | null } | undefined

  if (!caseRow) {
    // Domain-scoped guard: if the case exists in the OTHER domain, this is
    // cross-domain leakage, not just a missing case.
    const otherTable = domain === 'personal' ? 'zst_cases' : 'personal_cases'
    const inOther = db.prepare(`SELECT 1 FROM ${otherTable} WHERE case_id = ?`).get(caseId)
    if (inOther) {
      const err = new CrossDomainReadError(domain, caseId, 'runProgressionCycle')
      return recordCrossDomainLeakageRun(db, runId, domain, caseId, err.message,
        canonicalTriggerType(opts.triggerType ?? 'MANUAL'), opts.triggerReference ?? 'checkpoint-b', now)
    }
    throw new Error(`Case not found: ${domain}/${caseId}`)
  }

  // ACP v1.4.5 TSCG_ENTRY_GUARD. Domain ownership is established above
  // before temporal semantics are evaluated, so CROSS_DOMAIN_LEAKAGE and
  // ordinary not-found behavior cannot be masked by TEMPORAL_MISSING. Every
  // public progression entry still reaches this shared inner gate before
  // outcome-contract, resolver, planning or policy decisions.
  const temporal = evaluateCaseTemporalConsistency(db, domain, caseId, now)
  if (!temporal.allowProgression) {
    return recordRefusedRun(
      db, runId, domain, caseId, 'TEMPORAL_GATE_BLOCKED',
      `${temporal.status}: ${temporal.reasons.join('; ')}`, opts, now,
    )
  }

  // 2. Outcome contract — lazy enrichment: if goal was already set by
  //    enrichCaseGoal(), use it; otherwise fall back to heuristic.
  const existing = db.prepare(
    `SELECT case_version, plan_version, goal_version, goal, summary,
            completed_plan_step, no_progress_run_count,
            next_best_action_json, rolling_plan_json,
            semantic_completion_status,
            progression_enabled, next_progression_at, wait_version
     FROM case_progression_state WHERE domain = ? AND case_id = ?`,
  ).get(domain, caseId) as {
    case_version: number; plan_version: number; goal_version: number
    goal: string | null; summary: string | null
    completed_plan_step: number
    no_progress_run_count: number
    next_best_action_json: string | null
    rolling_plan_json: string | null
    /** Read for §8: an event is written when this MOVES, not on every run
     *  that finds the case where it already was. */
    semantic_completion_status: string | null
    progression_enabled: number
    next_progression_at: number | null
    wait_version: number
  } | undefined

  const contract = deriveOutcomeContract(caseRow.title, caseRow.case_type, caseRow.status, caseRow.sensitivity)

  // If an LLM-enriched goal already exists (lazy enrichment), use it.
  // The enriched goal is more accurate than the heuristic — it was derived
  // from the actual email thread content by enrichCaseGoal().
  const enrichedGoal: string | null = existing?.goal && existing.goal.trim().length > 0 ? existing.goal : null
  const enrichedSummary: string | null = existing?.summary ?? null
  if (enrichedGoal) {
    contract.goal = enrichedGoal
  }

  // 3. Resolve context (deep: DB + email thread + memory — internal-shadow reads only)
  //    Domain-scoped read guard: CrossDomainReadError → FAILED run with CROSS_DOMAIN_LEAKAGE
  let deepCtx: DeepResolvedContext
  try {
    deepCtx = resolveContextDeep(db, domain, caseId, now)
  } catch (err) {
    if (err instanceof CrossDomainReadError) {
      return recordCrossDomainLeakageRun(db, runId, domain, caseId, err.message,
        canonicalTriggerType(opts.triggerType ?? 'MANUAL'), opts.triggerReference ?? 'checkpoint-b', now)
    }
    throw err
  }
  // When did this case enter the status it is in now? Two separate questions
  // depend on it: how long the current wait has ACTUALLY been running, and how
  // far back an owner answer may reach and still be about this episode of the
  // case.
  const statusSince = statusEnteredAt(db, domain, caseId, caseRow.status) ?? caseRow.created_at
  // Build a shallow context for the planner/decider (same shape as Checkpoint B)
  const context: ResolvedContext = {
    eventCount: deepCtx.eventCount,
    lastEventType: deepCtx.lastEventType,
    lastEventReason: deepCtx.lastEventReason,
    hasParent: deepCtx.hasParent,
    hasChildren: deepCtx.hasChildren,
    ageDays: deepCtx.ageDays,
    statusAgeDays: Math.floor(Math.max(0, now - statusSince) / 86400),
    // Only a wake still ahead of us bounds a wait; a wake that has already
    // passed is not a reason to keep waiting.
    nextWakeAt: caseRow.next_wake_at !== null && caseRow.next_wake_at > now ? caseRow.next_wake_at : null,
    sensitivity: deepCtx.sensitivity,
  }

  // 4. Rolling plan
  let plan = buildRollingPlan(contract, context, caseRow.status)
  let planJson = JSON.stringify(plan)
  let storedPlanJson = existing?.rolling_plan_json ?? null
  let planChanged = storedPlanJson !== planJson
  let completedPlanStep = planChanged ? 0 : (existing?.completed_plan_step ?? 0)
  // Effective status/version — may diverge from caseRow after answer consumption
  let currentStatus = caseRow.status
  let currentVersion = caseRow.version

  // 5. Next Best Action — skip steps already completed in a previous run
  let nba = determineNextBestAction(plan, context, completedPlanStep)

  // 6. Decision (tentative — may be overridden by answer consumption below)
  let { decision, reason } = decide(nba, context, currentStatus)

  // ── Owner answer consumption (card 52250c7f Phase C) ───────────────
  //
  // Match by question CONTENT (decision + nbaStep), bounded by the current
  // status episode, once per answer — see consumeOwnerAnswer. What follows is
  // only the question "what does this answer mean", and it is answered by the
  // INTENT, never by "the choice was not the string NO".
  const ownerAnswer = consumeOwnerAnswer(db, domain, caseId, decision, nba.planStep, statusSince)
  const consumedAnswerEventId: number | null = ownerAnswer?.eventId ?? null
  if (ownerAnswer) {
    const transitionFn = domain === 'personal' ? transitionCase : transitionZstCase
    const answerLabel = ownerAnswer.choice ?? ownerAnswer.eventType
    /** Move the case, then replan from the new status. */
    const moveTo = (newStatus: 'BLOCKED' | 'READY', why: string): void => {
      transitionFn(db, {
        caseId, newStatus, actor: 'progression-engine',
        seenVersion: currentVersion, reason: why,
      }, now)
      currentStatus = newStatus
      currentVersion += 1
      plan = buildRollingPlan(contract, context, currentStatus)
      planJson = JSON.stringify(plan)
      storedPlanJson = null
      planChanged = true
      completedPlanStep = 0
      nba = determineNextBestAction(plan, context, 0)
      const redone = decide(nba, context, currentStatus)
      decision = redone.decision
      reason = redone.reason
    }

    if (ownerAnswer.intent === 'REFUSE') {
      // Explicit no → BLOCKED for replanning.
      moveTo('BLOCKED', 'Owner rejected the proposed action')
    } else if (ownerAnswer.intent === 'ABANDON') {
      // "Lemondjuk" / "Hagyjuk ezt az utat" is a stronger no: not "replan this",
      // but "stop pursuing it". The engine may not close a case on its own
      // (that is the completion gate's job and it needs evidence), so it blocks
      // and says why — the close intent is preserved in words, on the case, for
      // the owner to finish. What it must NOT do is what it used to: advance the
      // plan as if the answer had been go-ahead.
      moveTo('BLOCKED', `Owner dropped this path (${answerLabel}); needs owner closure or a new plan`)
    } else if (ownerAnswer.intent === 'HOLD') {
      // "Várjunk még rá" / "Elhalasztjuk" / "Később". The step is NOT settled,
      // so nothing advances; the answer is recorded (this run names its event
      // id) and the same question stands. Advancing here would make waiting and
      // proceeding the same button.
      reason = `${reason} — owner asked to wait (${answerLabel}); step not advanced`
    } else if (currentStatus === 'AWAITING_APPROVAL') {
      // THE APPROVAL GATE. An approval is granted by ONE thing: an
      // OWNER_DECISION whose choice is YES.
      //
      // What used to be here was `else if (currentStatus === 'AWAITING_APPROVAL')`
      // with no test on the event type or the choice at all. So an
      // OWNER_INFORMATION — which is what recordOwnerAnswer writes for ANY text
      // that is not a plain yes/no — moved the case from AWAITING_APPROVAL to
      // READY with the reason "Owner approved the request". Answering "a
      // vízdíjról: holnap utánanézek" approved the request. So did a decision
      // event whose payload failed to parse, because the parse failure was
      // swallowed and left choice:null, which is not the string 'NO'.
      //
      // Everything that is not an explicit yes is recorded and changes nothing.
      // A wrong pairing is worse than none (2026-08-11 postmortem), and on an
      // approval the wrong pairing is the engine claiming permission it was
      // never given.
      if (ownerAnswer.eventType === 'OWNER_DECISION' && ownerAnswer.choice === 'YES') {
        moveTo('READY', 'Owner approved the request')
      } else {
        reason = `${reason} — owner answer recorded (${ownerAnswer.eventType}/${answerLabel}), `
          + 'but approval needs an explicit YES; case stays in AWAITING_APPROVAL'
      }
    } else if (ownerAnswer.intent === 'PROCEED' || ownerAnswer.intent === 'INFORM') {
      // He answered the question that was asked: a go-ahead, a named course of
      // action, or the information the step was waiting for. Advance past the
      // answered step so the NBA picks the FOLLOWING one.
      completedPlanStep = ownerAnswer.answeredNbaStep
      nba = determineNextBestAction(plan, context, completedPlanStep)
      const redone = decide(nba, context, currentStatus)
      decision = redone.decision
      reason = redone.reason
    } else {
      // UNMAPPED: a choice the engine has no consumer for (ASK_OTHERS,
      // GET_QUOTE, SPECIFY — all of them ask for an outbound action nothing
      // performs yet), or an OWNER_DECISION that did not say what was decided.
      // Recorded, never acted on. Fail-closed by construction: a value nobody
      // taught this engine cannot mean "proceed" by default, which is exactly
      // how "Lemondjuk" used to advance the plan.
      reason = `${reason} — owner answer recorded (${answerLabel}) but has no engine meaning yet; nothing advanced`
    }
  }

  // 7. Upsert progression state
  // Only bump plan_version if the plan actually changed (status transition, etc.).
  // planChanged already covers this: same plan → same version.
  const planVersion = planChanged ? (existing?.plan_version ?? 0) + 1 : (existing?.plan_version ?? 0)
  const goalVersion = existing?.goal_version ?? 0

  const auditJson = JSON.stringify(deepCtx.audit)

  if (existing) {
    // UPDATE: preserve enriched summary (set once by enrichCaseGoal, never
    // overwritten by the pipeline). goal IS written — if lazy enrichment
    // already set it, we write the same value back (idempotent).
    db.prepare(
      `UPDATE case_progression_state
       SET goal = ?, definition_of_done_json = ?, success_evidence_requirements_json = ?,
           semantic_completion_status = ?,
           rolling_plan_json = ?, plan_version = ?, next_best_action_json = ?,
           completed_plan_step = ?, resolution_audit_json = ?,
           last_progressed_at = ?, case_version = case_version + 1, updated_at = ?
       WHERE domain = ? AND case_id = ?`,
    ).run(
      contract.goal,
      JSON.stringify(contract.definitionOfDone),
      JSON.stringify(contract.successEvidenceRequirements),
      currentStatus === 'COMPLETED' ? 'PROPOSED' : 'IN_PROGRESS',
      planJson,
      planVersion,
      JSON.stringify(nba),
      completedPlanStep,
      auditJson,
      now, now,
      domain, caseId,
    )
  } else {
    db.prepare(
      `INSERT INTO case_progression_state
       (domain, case_id, goal, summary, definition_of_done_json, success_evidence_requirements_json,
        semantic_completion_status, rolling_plan_json, plan_version, next_best_action_json,
        resolution_audit_json,
        progression_enabled, progression_mode, last_progressed_at,
        blocked_reason, waiting_on, case_version, goal_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?,
               ?,
               0, 'shadow', ?,
               NULL, NULL, 1, 0, ?, ?)`,
    ).run(
      domain, caseId, contract.goal, enrichedSummary,
      JSON.stringify(contract.definitionOfDone),
      JSON.stringify(contract.successEvidenceRequirements),
      currentStatus === 'COMPLETED' ? 'PROPOSED' : 'IN_PROGRESS',
      JSON.stringify(plan), planVersion, JSON.stringify(nba),
      auditJson,
      now, now, now,
    )
  }

  // 8. Evaluate hard safety assertions.
  //    The assertions are evaluated against the run's REAL facts, and the ones
  //    that structurally cannot apply to this engine are recorded as
  //    not_applicable rather than passed — see progression-eval.ts for why a
  //    ledger claiming seven passes was overstating the protection.
  const safetyViolations: SafetyViolation[] = []
  const runResultForAssertions = {
    run_id: runId,
    domain,
    case_id: caseId,
    decision,
    reason,
    status: 'COMPLETED' as const,
    error_code: null,
    error_summary: null,
    safety_violations: safetyViolations,
  }

  // THE ASSERTIONS GET THE REAL STATE, AND SAY WHICH ONES RAN (§16).
  //
  // Two halves, merged 2026-08-13 from the two branches that fixed this file in
  // parallel. `runResultForAssertions.error_code` is hard-coded null three lines
  // up, so every assertion that tested it was being asked a question its input
  // could never answer yes to -- hence the context, which lets the
  // external-action assertions read this case's actual ledger and authorization
  // rows. And `evaluateSafetyAssertions` records not_applicable instead of
  // passed for an assertion that had nothing to look at, so the ledger row is
  // evidence rather than decoration.
  const assertionResults = evaluateSafetyAssertions(runResultForAssertions, { db, domain, caseId })
  for (const r of assertionResults) {
    if (r.status === 'violated') {
      safetyViolations.push({ assertion: r.assertion, case_id: caseId, domain, detail: r.detail ?? '' })
    }
  }

  const runStatus = safetyViolations.length > 0 ? 'FAILED' : 'COMPLETED'

  // The decision is NOT final here. Two places below still change it — plan
  // exhaustion can upgrade it to COMPLETE, and the §25 guard can downgrade it
  // back. So the §8 event history is written at the END of the run (step 11),
  // where `decision` is the value the run actually reports.

  // 9. Record the progression run — NO external_reference, NO action_ids
  const safetyJson = JSON.stringify(assertionResults)

  db.prepare(
    `INSERT INTO case_progression_runs
     (progression_run_id, domain, case_id, trigger_type, trigger_reference,
      case_version_before, case_version_after, goal_version,
      plan_version_before, plan_version_after, decision, reason,
      progress_delta_json, action_ids_json, escalation_id,
      status, error_code, error_summary, safety_assertions_json,
      started_at, completed_at)
     VALUES (?, ?, ?, ?, ?,
             ?, ?, ?,
             ?, ?, ?, ?,
             ?, NULL, NULL,
             ?, NULL, NULL, ?,
             ?, ?)`,
  ).run(
    runId, domain, caseId,
    canonicalTriggerType(opts.triggerType ?? 'MANUAL'), opts.triggerReference ?? 'checkpoint-b',
    // THE CASE VERSIONS ARE THE CASE'S, not the state row's counter.
    // They used to be `caseVersion, caseVersion + 1` read off
    // case_progression_state — a number that increments on every run whether or
    // not the case moved, and that has nothing to do with the optimistic-
    // concurrency version a replay would need to line up against. before is the
    // version this cycle read; after is the version it leaves behind, which is
    // the same number unless the cycle actually transitioned the case.
    caseRow.version, currentVersion, goalVersion,
    existing?.plan_version ?? 0, planVersion, decision, reason,
    // consumedAnswerEventId is the consumed-marker for owner answers: this row
    // IS the record that the answer has been acted on, and consumeOwnerAnswer
    // refuses any event already named by a run of this case.
    JSON.stringify({
      planVersion, goalVersion, nbaStep: nba.planStep,
      auditSummary: deepCtx.audit.summary,
      consumedAnswerEventId,
    }),
    runStatus, safetyJson,
    now, now,
  )

  // Checkpoint E.4 DoD: initialise verification on first run, recording where
  // the criteria came from. This is the only side-effect of DoD — a single
  // dod_verification_json UPDATE on case_progression_state. No writes to
  // personal_cases/zst_cases.
  //
  // What used to be here, and is gone: a call to autoSatisfyNextDoDCriterion()
  // that ticked off one more criterion on every successful run. It checked
  // nothing. After three runs the DoD read as fully satisfied, the completion
  // gate below read that back, and the case closed — 72 times, with the same
  // sentence each time. The engine has no evidence extractor, so it now
  // satisfies nothing, and a criterion can only be met by a caller that names
  // what proves it (satisfyNextDoDCriterionWithEvidence).
  if (runStatus === 'COMPLETED') {
    initializeDoDVerification(db, domain, caseId, contract.definitionOfDone, contract.dodProvenance, now)
  }

  // ── Stagnation detection + step advancement (GATE 2 follow-up) ─────────
  //
  // "Real progress" is defined as:
  //   a) the NBA plan step advanced past the previous run's step, OR
  //   b) a DoD criterion was newly satisfied, OR
  //   c) the plan was rebuilt because the case status changed (fresh start)
  //
  // If none of these are true, the run was a no-op and no_progress_run_count
  // is incremented. Otherwise it is reset to 0.
  //
  // After a successful CONTINUE_AUTONOMOUSLY run, completed_plan_step is
  // advanced so the NEXT run picks the step AFTER the one just completed.
  // If all plan steps are exhausted, reset completed_plan_step to 0 so the
  // next run rebuilds the plan (plan_version bump).

  // Advance completed_plan_step after a successful autonomous run.
  // Gate on nba.canProceedAutonomously, NOT on decision — decide() returns
  // WAIT_EXTERNAL for WAITING_EXTERNAL status even when the current step is
  // autonomously executable (e.g. step 1 VERIFY on a case that awaits external
  // input on step 2). The step completed; the decision is about what's next.
  let newCompletedPlanStep = completedPlanStep
  if (runStatus === 'COMPLETED' && nba.canProceedAutonomously) {
    // Mark this NBA step as completed for the next run
    newCompletedPlanStep = nba.planStep
    // If all plan steps are now completed, check whether the case can
    // actually finish. If all DoD criteria are met → upgrade decision to
    // COMPLETE (the pipeline's own trigger, not just the guard). If DoD
    // is unmet → reset to 0 to start a fresh plan cycle (wrap-around).
    const maxStep = plan.length > 0 ? plan[plan.length - 1].step : 0
    if (newCompletedPlanStep >= maxStep) {
      const gate = canCompleteCase(db, domain, caseId, 'ENGINE')
      if (gate.allowed) {
        // All plan steps done + all DoD criteria met with evidence → COMPLETE.
        // The reason quotes the gate rather than asserting on its own. The old
        // text was a constant, which is why 72 closures shared one sentence and
        // nothing in the record distinguished a real completion from a false
        // one. A reason that cannot vary cannot be read.
        decision = 'COMPLETE'
        reason = `All ${plan.length} plan steps completed; completion gate: ${gate.reason}`
        // Update the run row (already INSERTed with the original decision)
        db.prepare(
          `UPDATE case_progression_runs SET decision = ?, reason = ? WHERE progression_run_id = ?`,
        ).run(decision, reason, runId)
        // Keep newCompletedPlanStep at maxStep — the case IS done
      } else {
        // DoD not yet met — reset to 0 for a fresh plan cycle
        newCompletedPlanStep = 0
      }
    }
  }

  // "Real progress" means the step counter actually advanced (a step was
  // completed autonomously and its index is higher than before this run).
  // Comparing newCompletedPlanStep vs completedPlanStep catches:
  //   - normal advancement (1→2, 2→3, …)
  //   - exhaustion reset (4→0) — nba.canProceedAutonomously gates it, and
  //     we check progress BEFORE the reset (nba.planStep > completedPlanStep)
  // DoD satisfaction used to be the second half of this test. It was removed
  // with the auto-satisfier: "a criterion got ticked" was never progress, it
  // was a side effect of this very run, so it reset the stagnation counter on
  // exactly the runs that achieved nothing. What is left measures the one
  // thing that is real — the plan step moved.
  const nbaStepAdvanced = nba.canProceedAutonomously && nba.planStep > completedPlanStep
  const realProgress = nbaStepAdvanced
  const prevNoProgressCount = existing?.no_progress_run_count ?? 0
  const newNoProgressCount = realProgress ? 0 : prevNoProgressCount + 1

  // Persist stagnation + step counters
  db.prepare(
    `UPDATE case_progression_state
     SET no_progress_run_count = ?, completed_plan_step = ?, updated_at = ?
     WHERE domain = ? AND case_id = ?`,
  ).run(newNoProgressCount, newCompletedPlanStep, now, domain, caseId)

  // Checkpoint E.4 completion guard: after recording this run's DoD
  // contribution, verify that ALL criteria are met before allowing COMPLETE.
  // If decision is COMPLETE but DoD is still unmet, downgrade to
  // CONTINUE_AUTONOMOUSLY and UPDATE the run record to match.
  if (decision === 'COMPLETE' && runStatus === 'COMPLETED') {
    // `existing != null` used to stand in for this. The name asserted something
    // the expression did not check: a state row EXISTS for every case the
    // pipeline has ever touched, enabled or not, so the guard was "has this case
    // been progressed before" wearing the word ENABLED.
    const isProgressionEnabled = (existing?.progression_enabled ?? 0) === 1
    if (isProgressionEnabled) {
      const gate = canCompleteCase(db, domain, caseId, 'ENGINE')
      if (!gate.allowed) {
        decision = 'CONTINUE_AUTONOMOUSLY'
        reason = `DoD not met (${gate.reason}). Proceeding autonomously until criteria are satisfied.`
        // Update the run record to reflect the downgraded decision
        db.prepare(
          `UPDATE case_progression_runs
           SET decision = ?, reason = ?
           WHERE progression_run_id = ?`,
        ).run(decision, reason, runId)
      }
    }
  }

  // ── 10b. §25 — settle the SEMANTIC completion status ──────────────────────
  //
  // WHAT WAS WRONG. The column's own CHECK constraint names four values —
  // NOT_STARTED, IN_PROGRESS, PROPOSED, VERIFIED — and the pipeline only ever
  // wrote two of them: `currentStatus === 'COMPLETED' ? 'PROPOSED' : 'IN_PROGRESS'`,
  // in both the UPDATE and the INSERT branch. VERIFIED had no writer anywhere in
  // the codebase, so the distinction §25 exists to draw — "the case row says
  // closed" versus "the outcome contract was actually proven" — collapsed: every
  // closed case sat at PROPOSED forever, whether its DoD was met with evidence
  // or not. The column recorded the case's STATUS a second time, not its meaning.
  //
  // WHERE THIS HAS TO SIT, AND WHY IT CANNOT SIT AT THE UPSERT. The gate below
  // reads `dod_verification_json`, which `initializeDoDVerification` writes AFTER
  // the upsert; and the completion block a few lines down sets
  // `progression_enabled = 0`, after which `canCompleteCase` returns
  // "Progression is disabled on this case" → allowed. Asking either side of that
  // window gives an answer about the wrong moment — one before the evidence
  // exists, one after the gate has been switched off. This is the only point
  // where the decision is final, the verification row is present, and the case
  // is still progression-controlled.
  //
  // A run that tripped a hard safety assertion settles nothing: a FAILED run may
  // not promote a case to VERIFIED on its way out.
  let semanticStatus: 'IN_PROGRESS' | 'PROPOSED' | 'VERIFIED' | null = null
  if (runStatus === 'COMPLETED') {
    if (decision === 'COMPLETE' || currentStatus === 'COMPLETED') {
      // PROPOSED means "closed on paper, not proven". VERIFIED means the same
      // gate that guards closure says the contract is satisfied with evidence.
      semanticStatus = canCompleteCase(db, domain, caseId, 'ENGINE').allowed ? 'VERIFIED' : 'PROPOSED'
    } else {
      semanticStatus = 'IN_PROGRESS'
    }
    db.prepare(
      `UPDATE case_progression_state
         SET semantic_completion_status = ?, updated_at = ?
       WHERE domain = ? AND case_id = ?`,
    ).run(semanticStatus, now, domain, caseId)
  }

  // When the pipeline decides COMPLETE (either via decide() for an
  // already-COMPLETED case, or via plan-exhaustion trigger above), actually
  // transition the case and remove it from the scheduler. This is the ONE
  // status mutation the progression pipeline is permitted: completion of
  // its own supervised work.
  if (decision === 'COMPLETE' && currentStatus !== 'COMPLETED') {
    const transitionFn = domain === 'personal' ? transitionCase : transitionZstCase
    transitionFn(db, {
      caseId,
      newStatus: 'COMPLETED' as const,
      actor: 'progression-engine',
      seenVersion: currentVersion,
      reason,
    }, now)
    currentStatus = 'COMPLETED'
    currentVersion += 1
    // Remove from heartbeat scheduler — no more polling for this case
    scheduleNextProgression(db, domain, caseId, null, now)
    db.prepare(
      `UPDATE case_progression_state SET progression_enabled = 0, updated_at = ? WHERE domain = ? AND case_id = ?`,
    ).run(now, domain, caseId)
  }

  // ── 11. §8 — write what happened INTO THE CASE'S OWN HISTORY ───────────────
  //
  // Sixteen of §8's seventeen event types had no producer, so a case's event
  // history showed intake and owner actions and nothing the engine ever did.
  // "What did the engine do?" was answerable from case_progression_runs;
  // "what happened to this case?" was not, and §27's PROGRESSION HISTORY panel
  // had nothing to render for the same reason.
  //
  // LAST, DELIBERATELY. `decision` was still provisional at step 8 — plan
  // exhaustion upgrades it to COMPLETE and the §25 guard downgrades it back —
  // so writing the history there would have recorded decisions the run never
  // reported.
  //
  // Safe against the loop `recordOwnerAnswer`'s comment warns about ("the engine
  // writes its own events during a run, so waking on EVERY event would make each
  // run schedule the next one"): the trigger contract hashes `last_event_id`
  // from the CASE ROW, and nothing here touches that column. An appended event
  // is therefore invisible to the scheduler. A standing check enforces it.
  if (runStatus === 'COMPLETED') {
    const previousDecision = (db.prepare(
      `SELECT decision FROM case_progression_runs
        WHERE domain = ? AND case_id = ? AND progression_run_id != ?
        ORDER BY started_at DESC LIMIT 1`,
    ).get(domain, caseId, runId) as { decision: string | null } | undefined)?.decision ?? null

    recordProgressionEvents(db, {
      domain, caseId, caseVersion: currentVersion, runId, now,
      decision, previousDecision,
      planVersion, previousPlanVersion: existing?.plan_version ?? null,
      // The goal is "defined" on the run that first gives the case one.
      goalDefined: !existing?.goal && Boolean(contract.goal),
      semanticStatus,
      previousSemanticStatus: existing?.semantic_completion_status ?? null,
    })
  }

  // ── 12. WAIT_TIME arms the scheduler ───────────────────────────────────────
  // WAIT_TIME is the one decision that names a wake, so it is the one that arms
  // the scheduler — until now nothing produced it, and progression-scheduler's
  // documented purpose ("set next_progression_at after a WAIT_TIME decision")
  // had no caller at all.
  //
  // wait_version is bumped ONLY when the deadline actually changes. It is part
  // of §10.8's dedup hash, so bumping it on every re-arm of the SAME wait would
  // make each sweep look like a new state and put back the run storm the trigger
  // contract was built to stop. A re-armed wait with a NEW deadline genuinely is
  // a new state — that is exactly the distinction the column was added for, and
  // it had no writer at all until this line.
  if (decision === 'WAIT_TIME' && context.nextWakeAt !== null) {
    const rearmed = existing?.next_progression_at !== context.nextWakeAt
    scheduleNextProgression(db, domain, caseId, context.nextWakeAt, now)
    if (rearmed) {
      db.prepare(
        `UPDATE case_progression_state SET wait_version = wait_version + 1, updated_at = ?
         WHERE domain = ? AND case_id = ?`,
      ).run(now, domain, caseId)
    }
  }

  // The run row was written before the transitions above could happen. Keep its
  // case_version_after honest rather than leaving the ledger describing a
  // version the case no longer has.
  if (currentVersion !== caseRow.version) {
    db.prepare(
      `UPDATE case_progression_runs SET case_version_after = ? WHERE progression_run_id = ?`,
    ).run(currentVersion, runId)
  }

  // ── 13a. §19 hardening — the CAPABILITY CONTRACT of the chosen action ──────
  //
  // Owner's decision, 2026-08-27: the dependency belongs to the NEXT ACTION, not
  // to the case, and it is DECLARED at plan time rather than inferred from what
  // is connected. This is where the declaration is enforced.
  //
  // COVERAGE GATES THE SIGNAL, NEVER THE ENFORCEMENT. Owner's closure A,
  // 2026-08-27, and he was right about a defect I had also argued for.
  //
  // The first version skipped `enforceCapabilityContract` entirely when coverage
  // was incomplete, and justified it with "a partly-enforced gate is the worst of
  // the three states". That reasoning is backwards, and the consequence is the
  // exact opposite of the rule it claimed to serve: adding ONE undeclared
  // high-risk kind would have made coverage incomplete and therefore turned the
  // DENY off for EVERY action, including the new undeclared one. A rollout gate
  // that fails OPEN is not a rollout gate.
  //
  // So per-action enforcement runs ALWAYS. Incomplete coverage is a readiness /
  // health / release fact -- it makes that signal FAIL, and it is recorded on the
  // run -- but it can never widen what an action is allowed to do.
  const coverage = capabilityCoverage()
  // The contract is read from the PLAN STEP the next action names, not re-derived
  // from the kind here: re-deriving would silently repair a plan that was built
  // before contracts existed, and a repaired-on-read contract is an inference
  // wearing a declaration's clothes. A step that carries none yields UNDECLARED.
  const capStep = plan.find(st => st.step === nba.planStep)
  const capDeclared = capStep ? contractFor(capStep) : undeclaredContract()
  const capClass = SIDE_EFFECT_CLASS[nba.kind as PlanStepKind]

  // CLOSURE B: the CONCRETE dependency, resolved before execution rather than
  // discovered inside the executor.
  //
  // The step-level declaration is a FLOOR -- RUN_LEDGER for anything that writes
  // -- and the owner's objection was exactly that a floor is not a dependency
  // list: "RUN_LEDGER önmagában nem teljes dependency declaration az EXECUTE /
  // COMMUNICATE műveleteknél". So the channel or tool the action would actually
  // drive is resolved here, deterministically and read-only, and folded on top.
  //
  // This does NOT move executor policy into the planner. The dispatch gate, the
  // quota, the sensitivity profile and the approval all stay where they are and
  // still run. What changes is that the answer to "what will this need" exists
  // BEFORE the executor opens, and lands in the audit trail as a chain:
  // planned action -> resolved target -> required capability -> preflight verdict.
  const capResolved = resolveExecutionDependency(db, domain, caseId, nba.kind as PlanStepKind, capClass)
  const capContract = withResolvedDependency(capDeclared, capResolved)
  const capResult = enforceCapabilityContract(db, capContract, capClass, now)
  // The chain, recorded whatever the verdict -- including PROCEED. A trail that
  // only appears when something goes wrong cannot show that the check ran.
  //
  // ITS OWN FIELD, NOT `safetyViolations`. The first version pushed it there and
  // six existing tests went red asserting "no safety violations" -- correctly. A
  // safety violation means an assertion was BROKEN; an audit trail is a record
  // that a check RAN. Putting the second in the list meant for the first would
  // make every healthy run look like a violated one, which is the same
  // signal-destroying move this packet keeps finding elsewhere.
  const capabilityTrail: CapabilityTrail = {
    action: nba.description, kind: nba.kind,
    resolution: capResolved.status, target: capResolved.target,
    required: [...capContract.requiredCapabilities],
    verdict: capResult.verdict, reason: capResolved.reason,
  }
  if (!coverage.enforcementReady) {
    // Recorded, and it degrades the readiness signal. It does NOT change the
    // verdict below by even one branch.
    safetyViolations.push({
      assertion: 'CAPABILITY_COVERAGE_INCOMPLETE',
      case_id: caseId, domain,
      detail: `a kockázatos lépések ${coverage.risky.declared}/${coverage.risky.total} aránya nem teljes — `
        + 'a readiness-jelzés emiatt FAIL; az egyedi műveletek enforcementje ettől függetlenül fut',
    })
  }
  if (capResult.verdict !== 'PROCEED') {
    if (capResult.verdict === 'WAIT_CAPABILITY' && capResult.blocker) {
      // A REQUIRED capability is missing. The engine does NOT continue in a
      // degraded context -- that is the specific thing the owner forbade. It
      // parks on a TYPED wait carrying the four facts: which capability, which
      // action, what would end the wait (the probe, in the predicate), and when
      // it is looked at again.
      const b = capResult.blocker
      const armedCap = armWaitCondition(db, {
        domain, caseId, kind: 'CAPABILITY',
        subject: `képesség hiányzik: ${b.capability}`,
        // A non-retryable blocker is a deployment fault a person clears, so its
        // review is the ordinary stale review rather than a fifteen-minute retry
        // that would burn a queue slot on a state no probe can change.
        expectedBy: now + (b.retryable ? CAPABILITY_REVIEW_SEC : DEFAULT_CAPABILITY_HUMAN_REVIEW_SEC),
        wakePolicy: 'EITHER', runId,
        capability: { capability: b.capability, action: nba.description, retryable: b.retryable },
      }, now)
      decision = 'WAIT_SYSTEM'
      reason = `${capResult.detail} — a(z) "${nba.description}" lépés kötelező függősége`
      if (!armedCap.ok) {
        safetyViolations.push({
          assertion: 'CAPABILITY_WAIT_WITHOUT_TYPED_CONDITION',
          case_id: caseId, domain,
          detail: `${b.capability}: ${armedCap.refusal} — ${armedCap.detail ?? ''}`,
        })
      }
    } else if (capResult.verdict === 'DENY_UNDECLARED') {
      // Undeclared high-risk or mutating work. Fail closed, and say which action.
      // MANUAL_ACTION_REQUIRED is the vocabulary's "a person must do something",
      // and an undeclared risky dependency is exactly that: the fix is a
      // declaration, which no cycle can write for itself.
      decision = 'MANUAL_ACTION_REQUIRED'
      reason = `${capResult.detail}: ${nba.description}`
      safetyViolations.push({
        assertion: 'UNDECLARED_DEPENDENCY_ON_RISKY_ACTION',
        case_id: caseId, domain, detail: `${capClass} / ${nba.description}`,
      })
    } else {
      // CONTRACT_GAP: read-only work with no declaration. Not an outage, and the
      // case is NOT stopped for it. It is recorded so the gap is a backlog item
      // with a name rather than a silence.
      safetyViolations.push({
        assertion: 'CAPABILITY_CONTRACT_GAP',
        case_id: caseId, domain, detail: `${capClass} / ${nba.description}: ${capResult.detail}`,
      })
    }
  } else if (capResult.degradations.length) {
    // OPTIONAL capabilities missing. The case is NOT parked -- the owner was
    // explicit -- and the degradation is recorded so the confidence/risk policy,
    // which owns the blocking decision, has something to weigh.
    safetyViolations.push({
      assertion: 'CAPABILITY_DEGRADED_PROCEEDED',
      case_id: caseId, domain,
      detail: `${nba.description}: ${capResult.degradations.map(d => `${d.capability}=${d.state}`).join(', ')}`,
    })
  }

  // ── 13b. P2 §10.4 — the typed wait condition ───────────────────────────────
  //
  // TWO ACTS, in this order, and the order is the point.
  //
  // FIRST, consume the wake this run is answering. If the case's live condition
  // was satisfied or expired, this run IS the wake, and saying so is what makes
  // the wake idempotent: `resolveWaitCondition` records the run id and a second
  // runner is told the condition was already consumed rather than being allowed
  // to believe it woke the case too.
  //
  // THEN, if this run decided to wait again, arm a NEW condition. A WAIT
  // decision that arms nothing is a silent park -- the case sits in
  // WAITING_EXTERNAL with a free-text `waiting_on` and nothing that can ever
  // say the wait was met, which is the state §10.4 exists to end. So a failure
  // to arm downgrades the run rather than passing quietly: the owner's words
  // for this packet were that filling a column is not acceptance.
  try {
    const pending = evaluateWaitCondition(db, domain, caseId, now)
    if (pending.verdict === 'SATISFIED' || pending.verdict === 'EXPIRED') {
      resolveWaitCondition(db, domain, caseId, pending.verdict, pending.detail, runId, now)
    }
    if (decision === 'WAIT_EXTERNAL' || decision === 'WAIT_TIME') {
      const waitFacts = db.prepare(
        `SELECT waiting_on, follow_up_at, due_at
           FROM ${domain === 'personal' ? 'personal_cases' : 'zst_cases'} WHERE case_id = ?`,
      ).get(caseId) as { waiting_on: string | null; follow_up_at: number | null; due_at: number | null }
      const armed = armWaitFor(db, domain, caseId, decision, context, waitFacts, runId, now)
      if (!armed.ok) {
        // Recorded on the run, not thrown: the decision itself is sound and
        // already durable. What is not sound is calling it a typed wait.
        reason = `${reason} — FIGYELEM: a tipizált várakozás nem lett felállítva `
          + `(${armed.refusal}: ${armed.detail ?? ''})`
        safetyViolations.push({
          assertion: 'WAIT_WITHOUT_TYPED_CONDITION',
          case_id: caseId, domain,
          detail: `${decision} döntés tipizált várakozás nélkül: ${armed.refusal}`,
        })
      }
    }
  } catch { /* a wait-condition fault must not lose a completed decision */ }

  // ── 14. P1 — project the canonical decision onto the case board ────────────
  //
  // HERE, inside the run's transaction, and at the ONE place every progression
  // run passes through. There are four callers of runProgressionCycle; asking
  // each of them to remember to project is the shape of defect this codebase
  // has logged most often (built at both ends, dead in the middle).
  //
  // Inside the transaction means the canonical write and its projection commit
  // together, so the ordinary path cannot produce the "canonical advanced, board
  // did not" state at all. It can still arise from the canonical writers that do
  // not live in this pipeline (the scheduler, completion, the owner-question
  // path) and from a crash; `reconcileProjections` is what closes that window,
  // idempotently and fenced.
  //
  // A projection failure must not lose the run. The decision is already durable
  // at this point and the sweep will re-project; throwing here would roll back a
  // completed piece of reasoning to fix a view of it.
  try {
    projectCase(db, domain, caseId, now)
  } catch { /* the sweep reconciles it; see reconcileProjections */ }

  return {
    runId,
    domain,
    caseId,
    decision,
    reason,
    status: runStatus,
    errorCode: null,
    errorSummary: null,
    safetyViolations,
    planVersion,
    goalVersion,
    capabilityTrail,
  }
}

/** Turn a WAIT decision into a typed §10.4 condition.
 *
 *  WAIT_TIME is a clock we already hold, so it becomes a SCHEDULED_REVIEW with
 *  a TIMER policy. WAIT_EXTERNAL is the world, so it becomes an
 *  EXTERNAL_RESPONSE with EITHER: whichever arrives first, the reply or the
 *  deadline, ends the wait -- and if neither does, the stale review does.
 *
 *  The subject comes from what the case already says it is waiting on. If it
 *  says nothing, this refuses rather than inventing a party: "waiting for
 *  someone" is the free-text park this packet replaces.
 */
function armWaitFor(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  decision: string,
  context: ResolvedContext,
  caseRow: { waiting_on?: string | null; follow_up_at?: number | null; due_at?: number | null },
  runId: string,
  now: number,
): ArmResult {
  if (decision === 'WAIT_TIME') {
    return armWaitCondition(db, {
      domain, caseId, kind: 'SCHEDULED_REVIEW',
      subject: 'ütemezett felülvizsgálat',
      expectedBy: context.nextWakeAt,
      wakePolicy: 'TIMER', runId,
    }, now)
  }
  const subject = (caseRow.waiting_on ?? '').trim() || 'külső fél válasza'
  const expectedBy = caseRow.follow_up_at ?? caseRow.due_at ?? (now + EXTERNAL_WAIT_HORIZON_SEC)
  return armWaitCondition(db, {
    domain, caseId, kind: 'EXTERNAL_RESPONSE',
    subject, expectedBy, wakePolicy: 'EITHER', runId,
  }, now)
}

/** How long an external wait runs before its own deadline, when the case
 *  carries no follow-up date of its own. Seven days, matching the escalation
 *  clock in `decide()` -- two different numbers here would mean a wait that
 *  expires after the engine has already escalated it. */
export const EXTERNAL_WAIT_HORIZON_SEC = 7 * 86400

/** How long a case sleeps on a RETRYABLE missing capability before the probe is
 *  read again. Matches `CAPABILITY_RETRY_SEC` in capability-preflight: two
 *  different numbers here would mean the typed wait and the older wait_system
 *  disagreed about when "again" is. */
export const CAPABILITY_REVIEW_SEC = 900

/** And how long on a NON-retryable one. A disabled connector or an unknown
 *  capability name is a deployment fault only a person can clear, so re-probing
 *  it every fifteen minutes would spend a bounded queue slot on a state no probe
 *  can change. A day, and the stale review is what makes it visible meanwhile. */
export const DEFAULT_CAPABILITY_HUMAN_REVIEW_SEC = 86400

// ── Mission Control read view (read-only projection) ────────────────────

export interface MissionControlProgressionView {
  caseId: string
  domain: 'personal' | 'zst'
  title: string
  status: string
  goal: string | null
  summary: string | null
  semanticCompletionStatus: string
  lastDecision: string | null
  lastDecisionReason: string | null
  lastProgressedAt: number | null
  planVersion: number
  nbaDescription: string | null
  totalRunCount: number
  lastRunId: string | null  // progression_run_id of the last run (card 9193eedd: sourceReference for owner-action)
  // WHAT THE READER FOUND, from the newest evidence packet for this case.
  //
  // Review #5, Ö-1: the Reader reads a whole case context, arbitrates, writes a
  // plan — and until now not one line of production code read any of it back.
  // `case_evidence_packets` was touched by three places: the reader writes it,
  // the reader reads its own MAX(created_at) to know when it last looked, and
  // retention nulls the columns after 90 days. Up to 432 model calls a day whose
  // entire yield was a write-only table.
  //
  // Wiring the decision INTO the pipeline is a §13.1 arbitration question and an
  // owner call. Showing it is not, and it is the DoD of that decision: until
  // somebody can see what the Reader proposes and whether it agreed with policy,
  // there is no evidence on which to decide whether to trust it.
  readerDecision: string | null
  readerDecidedBy: string | null
  readerConflictReason: string | null
  readerConfidence: number | null
  readerReadAt: number | null
}

/** Read-only Mission Control projection that joins case_progression_state
 *  with the last progression run for display. Does NOT write to
 *  personal_cases/zst_cases — this is a pure SELECT across progression tables
 *  + the case table for title/status. */
export function getMissionControlProgressionView(
  db: Database.Database,
  domain: 'personal' | 'zst',
): MissionControlProgressionView[] {
  const tableName = domain === 'personal' ? 'personal_cases' : 'zst_cases'

  return db.prepare(
    `SELECT
       c.case_id              AS "caseId",
       s.domain               AS "domain",
       c.title                AS "title",
       c.status               AS "status",
       s.goal                 AS "goal",
       s.summary              AS "summary",
       s.semantic_completion_status AS "semanticCompletionStatus",
       r.decision             AS "lastDecision",
       r.reason               AS "lastDecisionReason",
       s.last_progressed_at   AS "lastProgressedAt",
       s.plan_version         AS "planVersion",
       s.next_best_action_json AS "nbaDescription",
       (SELECT count(*) FROM case_progression_runs WHERE case_id = c.case_id AND domain = s.domain) AS "totalRunCount",
       r.progression_run_id   AS "lastRunId",
       p.final_decision       AS "readerDecision",
       p.decided_by           AS "readerDecidedBy",
       p.conflict_reason      AS "readerConflictReason",
       p.confidence           AS "readerConfidence",
       p.created_at           AS "readerReadAt"
     FROM case_progression_state s
     JOIN ${tableName} c ON c.case_id = s.case_id
     LEFT JOIN case_progression_runs r ON r.progression_run_id = (
       SELECT progression_run_id FROM case_progression_runs
       WHERE case_id = s.case_id AND domain = s.domain
       ORDER BY started_at DESC LIMIT 1
     )
     -- The NEWEST packet for this case, joined by packet_id rather than by
     -- created_at: two packets written in the same second would otherwise
     -- multiply the row, and a duplicated case in Mission Control reads as two
     -- cases.
     LEFT JOIN case_evidence_packets p ON p.packet_id = (
       SELECT packet_id FROM case_evidence_packets
       WHERE case_id = s.case_id AND domain = s.domain
       ORDER BY created_at DESC, packet_id DESC LIMIT 1
     )
     WHERE s.domain = ?
     ORDER BY s.last_progressed_at DESC`,
  ).all(domain) as MissionControlProgressionView[]
}
