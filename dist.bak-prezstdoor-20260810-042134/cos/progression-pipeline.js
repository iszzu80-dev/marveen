// Autonomous Case Progression Layer v1.1 — Thin shadow vertical slice.
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
//   5. Decision           — one of 10 valid progression decisions (§13)
//   6. Progression Run    — record in case_progression_runs (GATE 0 ledger)
//
// HARD INVARIANTS (Checkpoint B/C/D scope):
//   - ZERO side effects EXCEPT for COMPLETED transition: when all plan steps
//     are done AND all DoD criteria are met, the pipeline transitions the case
//     to COMPLETED and removes it from the scheduler.
//   - Write ONLY to case_progression_state + case_progression_runs
//   - progression_enabled stays false, progression_mode stays 'shadow'
//   - external_reference and action_ids_json are ALWAYS null — nothing was sent or called
import { randomUUID } from 'crypto';
import { HARD_SAFETY_ASSERTIONS } from './progression-eval.js';
import { resolveContextDeep, CrossDomainReadError, domainGuard } from './progression-resolver.js';
import { interpretGoal } from './progression-interpreter.js';
import { initializeDoDVerification, autoSatisfyNextDoDCriterion, canCompleteCase } from './progression-completion.js';
import { transitionCase } from './case-store.js';
import { transitionZstCase } from './zst-case-store.js';
import { scheduleNextProgression } from './progression-scheduler.js';
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
];
/** Derive an outcome contract from a case row. Thin slice: heuristic per case
 *  type — no template store, no LLM. The full feature set replaces this with
 *  a template-driven resolver that reads from a goal library. */
export function deriveOutcomeContract(caseTitle, caseType, caseStatus, sensitivity) {
    // Heuristic goal per case type
    const goalMap = {
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
    };
    const goal = goalMap[caseType] ?? `Elintezni: ${caseTitle}`;
    // Heuristic DoD per status
    const dodByStatus = {
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
    };
    const dod = dodByStatus[caseStatus] ?? ['Case progressed', 'Status updated', 'Next action clear'];
    const evidenceReqs = dod.map(d => `Evidence: ${d.toLowerCase()}`);
    return { goal, definitionOfDone: dod, successEvidenceRequirements: evidenceReqs };
}
/** Gather context for a case without calling any external source (resolve-
 *  before-ask stub). Reads only from the DB; no email/Drive/Calendar access. */
export function resolveContext(db, tableName, eventsTable, caseId, now) {
    const row = db.prepare(`SELECT sensitivity, parent_case_id, created_at FROM ${tableName} WHERE case_id = ?`).get(caseId);
    const eventCount = db.prepare(`SELECT count(*) as c FROM ${eventsTable} WHERE case_id = ?`).get(caseId).c;
    const lastEvent = db.prepare(`SELECT event_type, reason FROM ${eventsTable} WHERE case_id = ? ORDER BY created_at DESC LIMIT 1`).get(caseId);
    const childCount = db.prepare(`SELECT count(*) as c FROM ${tableName} WHERE parent_case_id = ?`).get(caseId).c;
    const ageDays = row ? Math.floor((now - row.created_at) / 86400) : 0;
    return {
        eventCount,
        lastEventType: lastEvent?.event_type ?? null,
        lastEventReason: lastEvent?.reason ?? null,
        hasParent: !!row?.parent_case_id,
        hasChildren: childCount > 0,
        ageDays,
        sensitivity: row?.sensitivity ?? 'PERSONAL',
    };
}
/** Build a rolling plan from the outcome contract + resolved context. Thin
 *  slice: deterministic plan template per case status — no replanning triggers,
 *  no LLM planner. Each plan step maps to one of the 10 valid decisions. */
export function buildRollingPlan(contract, context, currentStatus) {
    const plan = [];
    // Step 1: Always verify what we know
    plan.push({ step: 1, label: 'Verify current state and gathered context', kind: 'VERIFY', needsExternal: false });
    // Status-specific steps
    switch (currentStatus) {
        case 'NEW':
        case 'TRIAGE':
            plan.push({ step: 2, label: 'Classify and prioritize the case', kind: 'GATHER_INFO', needsExternal: false });
            plan.push({ step: 3, label: 'Identify required actions and dependencies', kind: 'EXECUTE', needsExternal: false });
            break;
        case 'INFORMATION_REQUIRED':
        case 'INFO_REQUIRED':
            plan.push({ step: 2, label: 'Gather missing information from relevant sources', kind: 'GATHER_INFO', needsExternal: true });
            plan.push({ step: 3, label: 'Evaluate gathered information against requirements', kind: 'VERIFY', needsExternal: false });
            break;
        case 'WAITING_EXTERNAL':
            plan.push({ step: 2, label: 'Check for external response or escalate if overdue', kind: 'AWAIT_EXTERNAL', needsExternal: true });
            plan.push({ step: 3, label: 'Process response and decide next step', kind: 'EXECUTE', needsExternal: false });
            break;
        case 'AWAITING_APPROVAL':
        case 'AWAITING_SELECTION':
            plan.push({ step: 2, label: 'Follow up on pending approval/selection', kind: 'AWAIT_DECISION', needsExternal: true });
            plan.push({ step: 3, label: 'Act on the received decision', kind: 'EXECUTE', needsExternal: false });
            break;
        case 'READY':
            plan.push({ step: 2, label: 'Execute the next action in the work plan', kind: 'EXECUTE', needsExternal: false });
            plan.push({ step: 3, label: 'Document result and plan next cycle', kind: 'COMMUNICATE', needsExternal: false });
            break;
        case 'EXECUTING':
            plan.push({ step: 2, label: 'Continue or complete the current execution step', kind: 'EXECUTE', needsExternal: false });
            plan.push({ step: 3, label: 'Verify execution result against expected outcome', kind: 'VERIFY', needsExternal: false });
            break;
        case 'BLOCKED':
            plan.push({ step: 2, label: 'Identify and document the blocker precisely', kind: 'GATHER_INFO', needsExternal: false });
            plan.push({ step: 3, label: 'Escalate or resolve the blocking condition', kind: 'RECOVER', needsExternal: true });
            break;
        case 'RECOVERY_REQUIRED':
            plan.push({ step: 2, label: 'Analyze what failed and define recovery path', kind: 'RECOVER', needsExternal: false });
            plan.push({ step: 3, label: 'Execute first recovery action', kind: 'EXECUTE', needsExternal: true });
            break;
        case 'FOLLOW_UP_DUE':
            plan.push({ step: 2, label: 'Perform the scheduled follow-up check', kind: 'VERIFY', needsExternal: false });
            plan.push({ step: 3, label: 'Determine whether the case can advance or needs more waiting', kind: 'EXECUTE', needsExternal: false });
            break;
        case 'CALL_REQUIRED':
            plan.push({ step: 2, label: 'Schedule and prepare for the call', kind: 'EXECUTE', needsExternal: false });
            plan.push({ step: 3, label: 'Place the call and document the outcome', kind: 'EXECUTE', needsExternal: true });
            break;
        case 'COMPLETED':
            plan.push({ step: 2, label: 'Verify all DoD criteria are satisfied', kind: 'VERIFY', needsExternal: false });
            plan.push({ step: 3, label: 'Archive evidence and notify stakeholders', kind: 'COMMUNICATE', needsExternal: false });
            break;
        case 'SCHEDULED':
            plan.push({ step: 2, label: 'Prepare for the scheduled event', kind: 'EXECUTE', needsExternal: false });
            plan.push({ step: 3, label: 'Execute at the scheduled time', kind: 'AWAIT_EXTERNAL', needsExternal: true });
            break;
        default:
            plan.push({ step: 2, label: 'Assess current situation and determine next move', kind: 'GATHER_INFO', needsExternal: false });
            plan.push({ step: 3, label: 'Take the appropriate next step', kind: 'EXECUTE', needsExternal: false });
    }
    // Final step: verify DoD
    if (currentStatus !== 'COMPLETED') {
        plan.push({ step: plan.length + 1, label: 'Review progress against Definition of Done', kind: 'VERIFY', needsExternal: false });
    }
    return plan;
}
/** Pick the Next Best Action from the rolling plan, skipping steps that
 *  were already completed in a previous run. The NBA is the first
 *  uncompleted step — the very next thing to do, even if it requires
 *  external input. The decision engine then determines whether that step
 *  can proceed autonomously or needs to wait. */
export function determineNextBestAction(plan, _context, completedPlanStep = 0) {
    // Find the first step whose index is past the last completed one
    const chosen = plan.find(s => s.step > completedPlanStep) ?? plan[0];
    const canProceed = !chosen.needsExternal;
    return {
        planStep: chosen.step,
        description: chosen.label,
        kind: chosen.kind,
        canProceedAutonomously: canProceed,
        estimatedEffortMinutes: chosen.kind === 'EXECUTE' ? 15 : 5,
    };
}
/** Check whether the owner has answered the CURRENT question. A question is
 *  defined by (decision, nbaStep) — two questions are the same iff both
 *  fields match, regardless of which heartbeat run emitted them.
 *
 *  Returns the answer if the latest owner event matches the current question;
 *  null if there is no answer, or the question has changed since the answer
 *  was recorded (stale). */
function consumeOwnerAnswer(db, domain, caseId, currentDecision, currentNbaStep) {
    // 1. Find the latest owner answer event for this case (any type).
    const eventsTable = domain === 'personal' ? 'personal_case_events' : 'zst_case_events';
    const answerEvent = db.prepare(`SELECT event_id, event_type, payload, source_reference
     FROM ${eventsTable}
     WHERE case_id = ?
       AND event_type IN ('OWNER_DECISION', 'OWNER_INFORMATION', 'OWNER_CONFIRMATION')
     ORDER BY created_at DESC LIMIT 1`).get(caseId);
    if (!answerEvent)
        return null;
    // 2. Look up the run that the answer references (source_reference = run ID).
    //    If source_reference is missing or the run is gone, we cannot verify
    //    question identity — treat as stale.
    if (!answerEvent.source_reference)
        return null;
    const referencedRun = db.prepare(`SELECT decision, progress_delta_json
     FROM case_progression_runs
     WHERE progression_run_id = ? AND domain = ? AND case_id = ?`).get(answerEvent.source_reference, domain, caseId);
    if (!referencedRun)
        return null;
    // 3. Extract the question that was asked in the referenced run.
    const referencedDecision = referencedRun.decision;
    let referencedNbaStep = 0;
    if (referencedRun.progress_delta_json) {
        try {
            const delta = JSON.parse(referencedRun.progress_delta_json);
            referencedNbaStep = delta.nbaStep ?? 0;
        }
        catch { /* ignore */ }
    }
    // 4. Does the referenced question match the CURRENT question?
    //    Same decision + same nbaStep → same question → answer is valid.
    //    Different → question has genuinely changed → answer is stale.
    if (referencedDecision !== currentDecision || referencedNbaStep !== currentNbaStep) {
        return null;
    }
    // 5. Parse the payload for a choice.
    let choice = null;
    if (answerEvent.payload) {
        try {
            const parsed = JSON.parse(answerEvent.payload);
            choice = parsed.choice ?? null;
        }
        catch { /* ignore */ }
    }
    return {
        eventType: answerEvent.event_type,
        choice,
        answeredRunId: answerEvent.source_reference,
        answeredNbaStep: referencedNbaStep,
    };
}
// ── Decision engine ─────────────────────────────────────────────────────
/** Map the NBA kind + context to one of the 10 valid progression decisions. */
export function decide(nba, context, currentStatus) {
    // Terminal status → COMPLETE
    if (currentStatus === 'COMPLETED') {
        return { decision: 'COMPLETE', reason: 'Case already completed; verifying DoD closure' };
    }
    // Recovery status → RECOVERY_REQUIRED
    if (currentStatus === 'RECOVERY_REQUIRED' || currentStatus === 'BLOCKED') {
        return { decision: 'RECOVERY_REQUIRED', reason: `Case is ${currentStatus.toLowerCase()}; recovery plan needed` };
    }
    // External-wait status → WAIT_EXTERNAL (unless overdue, then escalate)
    if (currentStatus === 'WAITING_EXTERNAL') {
        if (context.ageDays > 7) {
            return { decision: 'RECOVERY_REQUIRED', reason: `External wait exceeded 7 days (${context.ageDays}d); escalation needed` };
        }
        return { decision: 'WAIT_EXTERNAL', reason: 'Case is waiting for external response' };
    }
    // Information-gap status → ASK_INFORMATION
    if (currentStatus === 'INFORMATION_REQUIRED' || currentStatus === 'INFO_REQUIRED') {
        return { decision: 'ASK_INFORMATION', reason: 'Missing information is blocking progress' };
    }
    // Approval status → REQUEST_APPROVAL
    if (currentStatus === 'AWAITING_APPROVAL') {
        return { decision: 'REQUEST_APPROVAL', reason: 'Approval required before proceeding' };
    }
    // Call status → CALL_REQUIRED
    if (currentStatus === 'CALL_REQUIRED') {
        return { decision: 'CALL_REQUIRED', reason: 'Phone call is the next required action' };
    }
    // NBA kind → decision mapping (for statuses not explicitly handled above)
    switch (nba.kind) {
        case 'GATHER_INFO':
            if (nba.canProceedAutonomously) {
                return { decision: 'CONTINUE_AUTONOMOUSLY', reason: 'Information gathering can proceed without external input' };
            }
            return { decision: 'ASK_INFORMATION', reason: 'Missing information requires external input' };
        case 'AWAIT_EXTERNAL':
            // Check if case is overdue
            if (context.ageDays > 7) {
                return { decision: 'RECOVERY_REQUIRED', reason: `External wait exceeded 7 days (${context.ageDays}d); escalation needed` };
            }
            return { decision: 'WAIT_EXTERNAL', reason: 'Waiting for external response or event' };
        case 'AWAIT_DECISION':
            return { decision: 'REQUEST_DECISION', reason: 'Decision required from stakeholder before proceeding' };
        case 'EXECUTE':
            if (nba.canProceedAutonomously) {
                return { decision: 'CONTINUE_AUTONOMOUSLY', reason: 'Next action can be executed autonomously in shadow mode' };
            }
            return { decision: 'MANUAL_ACTION_REQUIRED', reason: 'Action requires manual execution (call, meeting, physical task)' };
        case 'VERIFY':
            return { decision: 'CONTINUE_AUTONOMOUSLY', reason: 'Verification can proceed autonomously against available evidence' };
        case 'COMMUNICATE':
            // In shadow mode, communication is a no-op but the decision is recorded
            return { decision: 'CONTINUE_AUTONOMOUSLY', reason: 'Communication step documented; shadow mode — no actual send' };
        case 'RECOVER':
            return { decision: 'RECOVERY_REQUIRED', reason: 'Recovery step identified; needs explicit recovery plan execution' };
        default:
            return { decision: 'CONTINUE_AUTONOMOUSLY', reason: 'Default autonomous progression' };
    }
}
// ── Goal enrichment (Checkpoint D — lazy LLM interpretation) ───────────
/** Enrich a case with LLM-interpreted goal and summary. Idempotent: if the
 *  case_progression_state already has a non-empty goal, this is a no-op
 *  (lazy enrichment — interpreted once at first progression run).
 *
 *  Domain-scoped: calls domainGuard() before interpretation. */
export async function enrichCaseGoal(db, domain, caseId, llmClient, emailThreadContent) {
    // Lazy: if already enriched, return existing
    const existing = db.prepare('SELECT goal, summary FROM case_progression_state WHERE domain = ? AND case_id = ?').get(domain, caseId);
    if (existing?.goal && existing.goal.trim().length > 0) {
        return {
            interpreted: false,
            goal: existing.goal,
            summary: existing.summary ?? '',
            title: '',
        };
    }
    // Domain-scoped read guard
    domainGuard(db, domain, caseId, 'enrichCaseGoal');
    // Read case metadata
    const tableName = domain === 'personal' ? 'personal_cases' : 'zst_cases';
    const caseRow = db.prepare(`SELECT title, case_type, description FROM ${tableName} WHERE case_id = ?`).get(caseId);
    if (!caseRow) {
        throw new Error(`Case not found: ${domain}/${caseId}`);
    }
    // Interpret via LLM
    const content = emailThreadContent ?? caseRow.description ?? '';
    const interpretation = await interpretGoal(llmClient, caseRow.title, caseRow.case_type, caseRow.description, content);
    const now = Math.floor(Date.now() / 1000);
    // Write to case_progression_state (lazy enrichment — writes only here)
    const stateExists = db.prepare('SELECT 1 FROM case_progression_state WHERE domain = ? AND case_id = ?').get(domain, caseId);
    if (stateExists) {
        db.prepare(`UPDATE case_progression_state
       SET goal = ?, summary = ?, goal_version = goal_version + 1, updated_at = ?
       WHERE domain = ? AND case_id = ?`).run(interpretation.goal, interpretation.summary, now, domain, caseId);
    }
    else {
        db.prepare(`INSERT INTO case_progression_state
       (domain, case_id, goal, summary, progression_enabled, progression_mode,
        case_version, goal_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 'shadow', 0, 1, ?, ?)`).run(domain, caseId, interpretation.goal, interpretation.summary, now, now);
    }
    return {
        interpreted: true,
        goal: interpretation.goal,
        summary: interpretation.summary,
        title: interpretation.title,
    };
}
/** Record a FAILED progression run with CROSS_DOMAIN_LEAKAGE error code
 *  (shared helper — used from case lookup guard and resolver catch block). */
function recordCrossDomainLeakageRun(db, runId, domain, caseId, message, triggerType, triggerReference, now) {
    const sv = [{
            assertion: 'cross_domain_leakage',
            case_id: caseId,
            domain,
            detail: message,
        }];
    const sJson = JSON.stringify(HARD_SAFETY_ASSERTIONS.map(a => ({
        assertion: a.name,
        passed: a.name !== 'cross_domain_leakage',
    })));
    db.prepare(`INSERT INTO case_progression_runs
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
             ?, ?)`).run(runId, domain, caseId, triggerType, triggerReference, 0, 0, 0, 0, 0, 'RECOVERY_REQUIRED', message, JSON.stringify({ error: 'CROSS_DOMAIN_LEAKAGE', detail: message }), 'FAILED', 'CROSS_DOMAIN_LEAKAGE', message, sJson, now, now);
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
    };
}
/** Run ONE progression cycle for a case. Read-only on personal_cases/zst_cases.
 *  Writes ONLY to case_progression_state + case_progression_runs.
 *
 *  The pipeline:
 *    1. Reads the case row from the appropriate table
 *    2. Derives/updates the outcome contract
 *    3. Resolves context (DB-only, no external sources)
 *    4. Builds or refreshes the rolling plan
 *    5. Determines the Next Best Action
 *    6. Makes a progression decision
 *    7. Evaluates hard safety assertions
 *    8. Writes progression state + run record
 *
 *  Returns the run result. Throws on DB errors only. */
export function runProgressionCycle(db, domain, caseId, now, opts = {}) {
    const runId = randomUUID();
    const tableName = domain === 'personal' ? 'personal_cases' : 'zst_cases';
    const eventsTable = domain === 'personal' ? 'personal_case_events' : 'zst_case_events';
    // 1. Read the case
    const caseRow = db.prepare(`SELECT title, case_type, status, sensitivity, version, created_at FROM ${tableName} WHERE case_id = ?`).get(caseId);
    if (!caseRow) {
        // Domain-scoped guard: if the case exists in the OTHER domain, this is
        // cross-domain leakage, not just a missing case.
        const otherTable = domain === 'personal' ? 'zst_cases' : 'personal_cases';
        const inOther = db.prepare(`SELECT 1 FROM ${otherTable} WHERE case_id = ?`).get(caseId);
        if (inOther) {
            const err = new CrossDomainReadError(domain, caseId, 'runProgressionCycle');
            return recordCrossDomainLeakageRun(db, runId, domain, caseId, err.message, opts.triggerType ?? 'MANUAL', opts.triggerReference ?? 'checkpoint-b', now);
        }
        throw new Error(`Case not found: ${domain}/${caseId}`);
    }
    // 2. Outcome contract — lazy enrichment: if goal was already set by
    //    enrichCaseGoal(), use it; otherwise fall back to heuristic.
    const existing = db.prepare(`SELECT case_version, plan_version, goal_version, goal, summary,
            completed_plan_step, no_progress_run_count,
            next_best_action_json, rolling_plan_json
     FROM case_progression_state WHERE domain = ? AND case_id = ?`).get(domain, caseId);
    const contract = deriveOutcomeContract(caseRow.title, caseRow.case_type, caseRow.status, caseRow.sensitivity);
    // If an LLM-enriched goal already exists (lazy enrichment), use it.
    // The enriched goal is more accurate than the heuristic — it was derived
    // from the actual email thread content by enrichCaseGoal().
    const enrichedGoal = existing?.goal && existing.goal.trim().length > 0 ? existing.goal : null;
    const enrichedSummary = existing?.summary ?? null;
    if (enrichedGoal) {
        contract.goal = enrichedGoal;
    }
    // 3. Resolve context (deep: DB + email thread + memory — internal-shadow reads only)
    //    Domain-scoped read guard: CrossDomainReadError → FAILED run with CROSS_DOMAIN_LEAKAGE
    let deepCtx;
    try {
        deepCtx = resolveContextDeep(db, domain, caseId, now);
    }
    catch (err) {
        if (err instanceof CrossDomainReadError) {
            return recordCrossDomainLeakageRun(db, runId, domain, caseId, err.message, opts.triggerType ?? 'MANUAL', opts.triggerReference ?? 'checkpoint-b', now);
        }
        throw err;
    }
    // Build a shallow context for the planner/decider (same shape as Checkpoint B)
    const context = {
        eventCount: deepCtx.eventCount,
        lastEventType: deepCtx.lastEventType,
        lastEventReason: deepCtx.lastEventReason,
        hasParent: deepCtx.hasParent,
        hasChildren: deepCtx.hasChildren,
        ageDays: deepCtx.ageDays,
        sensitivity: deepCtx.sensitivity,
    };
    // 4. Rolling plan
    let plan = buildRollingPlan(contract, context, caseRow.status);
    let planJson = JSON.stringify(plan);
    let storedPlanJson = existing?.rolling_plan_json ?? null;
    let planChanged = storedPlanJson !== planJson;
    let completedPlanStep = planChanged ? 0 : (existing?.completed_plan_step ?? 0);
    // Effective status/version — may diverge from caseRow after answer consumption
    let currentStatus = caseRow.status;
    let currentVersion = caseRow.version;
    const previousNbaStep = planChanged
        ? 0
        : (() => {
            try {
                if (existing?.next_best_action_json) {
                    const prev = JSON.parse(existing.next_best_action_json);
                    return prev.planStep ?? 0;
                }
            }
            catch { /* ignore malformed JSON */ }
            return 0;
        })();
    // 5. Next Best Action — skip steps already completed in a previous run
    let nba = determineNextBestAction(plan, context, completedPlanStep);
    // 6. Decision (tentative — may be overridden by answer consumption below)
    let { decision, reason } = decide(nba, context, currentStatus);
    // ── Owner answer consumption (card 52250c7f Phase C) ───────────────
    //
    // Match by question CONTENT (decision + nbaStep), not by run ID.
    // Heartbeat runs re-ask the same question every 5 minutes with new run IDs;
    // an answer remains valid while the question is unchanged, and becomes
    // stale only when the case genuinely asks something different.
    const ownerAnswer = consumeOwnerAnswer(db, domain, caseId, decision, nba.planStep);
    if (ownerAnswer) {
        if (ownerAnswer.eventType === 'OWNER_DECISION' && ownerAnswer.choice === 'NO') {
            // Owner explicitly rejected → escalate to BLOCKED for replanning.
            const transitionFn = domain === 'personal' ? transitionCase : transitionZstCase;
            transitionFn(db, {
                caseId,
                newStatus: 'BLOCKED',
                actor: 'progression-engine',
                seenVersion: currentVersion,
                reason: 'Owner rejected the proposed action',
            }, now);
            currentStatus = 'BLOCKED';
            currentVersion += 1;
            // Rebuild for the new status and re-determine
            plan = buildRollingPlan(contract, context, currentStatus);
            planJson = JSON.stringify(plan);
            storedPlanJson = null;
            planChanged = true;
            completedPlanStep = 0;
            nba = determineNextBestAction(plan, context, 0);
            const redone = decide(nba, context, currentStatus);
            decision = redone.decision;
            reason = redone.reason;
        }
        else if (currentStatus === 'AWAITING_APPROVAL') {
            // Status-driven: decide() returns REQUEST_APPROVAL for AWAITING_APPROVAL
            // regardless of step. Owner YES → approve → transition to READY.
            const transitionFn = domain === 'personal' ? transitionCase : transitionZstCase;
            transitionFn(db, {
                caseId,
                newStatus: 'READY',
                actor: 'progression-engine',
                seenVersion: currentVersion,
                reason: 'Owner approved the request',
            }, now);
            currentStatus = 'READY';
            currentVersion += 1;
            // Rebuild for the new status and re-determine
            plan = buildRollingPlan(contract, context, currentStatus);
            planJson = JSON.stringify(plan);
            storedPlanJson = null;
            planChanged = true;
            completedPlanStep = 0;
            nba = determineNextBestAction(plan, context, 0);
            const redone = decide(nba, context, currentStatus);
            decision = redone.decision;
            reason = redone.reason;
        }
        else {
            // YES / OWNER_INFORMATION / OWNER_CONFIRMATION → advance past the
            // answered step so the NBA picks the FOLLOWING step.
            completedPlanStep = ownerAnswer.answeredNbaStep;
            nba = determineNextBestAction(plan, context, completedPlanStep);
            const redone = decide(nba, context, currentStatus);
            decision = redone.decision;
            reason = redone.reason;
        }
    }
    // 7. Upsert progression state
    // Only bump plan_version if the plan actually changed (status transition, etc.).
    // planChanged already covers this: same plan → same version.
    const planVersion = planChanged ? (existing?.plan_version ?? 0) + 1 : (existing?.plan_version ?? 0);
    const goalVersion = existing?.goal_version ?? 0;
    const caseVersion = existing?.case_version ?? 1;
    const auditJson = JSON.stringify(deepCtx.audit);
    if (existing) {
        // UPDATE: preserve enriched summary (set once by enrichCaseGoal, never
        // overwritten by the pipeline). goal IS written — if lazy enrichment
        // already set it, we write the same value back (idempotent).
        db.prepare(`UPDATE case_progression_state
       SET goal = ?, definition_of_done_json = ?, success_evidence_requirements_json = ?,
           semantic_completion_status = ?,
           rolling_plan_json = ?, plan_version = ?, next_best_action_json = ?,
           completed_plan_step = ?, resolution_audit_json = ?,
           last_progressed_at = ?, case_version = case_version + 1, updated_at = ?
       WHERE domain = ? AND case_id = ?`).run(contract.goal, JSON.stringify(contract.definitionOfDone), JSON.stringify(contract.successEvidenceRequirements), currentStatus === 'COMPLETED' ? 'PROPOSED' : 'IN_PROGRESS', planJson, planVersion, JSON.stringify(nba), completedPlanStep, auditJson, now, now, domain, caseId);
    }
    else {
        db.prepare(`INSERT INTO case_progression_state
       (domain, case_id, goal, summary, definition_of_done_json, success_evidence_requirements_json,
        semantic_completion_status, rolling_plan_json, plan_version, next_best_action_json,
        resolution_audit_json,
        progression_enabled, progression_mode, last_progressed_at,
        blocked_reason, waiting_on, case_version, goal_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?,
               ?,
               0, 'shadow', ?,
               NULL, NULL, 1, 0, ?, ?)`).run(domain, caseId, contract.goal, enrichedSummary, JSON.stringify(contract.definitionOfDone), JSON.stringify(contract.successEvidenceRequirements), currentStatus === 'COMPLETED' ? 'PROPOSED' : 'IN_PROGRESS', JSON.stringify(plan), planVersion, JSON.stringify(nba), auditJson, now, now, now);
    }
    // 8. Evaluate hard safety assertions
    const safetyViolations = [];
    const runResultForAssertions = {
        run_id: runId,
        domain,
        case_id: caseId,
        decision,
        reason,
        status: 'COMPLETED',
        error_code: null,
        error_summary: null,
        safety_violations: safetyViolations,
    };
    for (const a of HARD_SAFETY_ASSERTIONS) {
        const detail = a.check(runResultForAssertions);
        if (detail) {
            safetyViolations.push({ assertion: a.name, case_id: caseId, domain, detail });
        }
    }
    const runStatus = safetyViolations.length > 0 ? 'FAILED' : 'COMPLETED';
    // 9. Record the progression run — NO external_reference, NO action_ids
    const safetyJson = JSON.stringify(HARD_SAFETY_ASSERTIONS.map(a => ({
        assertion: a.name,
        passed: !safetyViolations.some(v => v.assertion === a.name),
    })));
    db.prepare(`INSERT INTO case_progression_runs
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
             ?, ?)`).run(runId, domain, caseId, opts.triggerType ?? 'MANUAL', opts.triggerReference ?? 'checkpoint-b', caseVersion, caseVersion + 1, goalVersion, existing?.plan_version ?? 0, planVersion, decision, reason, JSON.stringify({ planVersion, goalVersion, nbaStep: nba.planStep, auditSummary: deepCtx.audit.summary }), runStatus, safetyJson, now, now);
    // Checkpoint E.4 DoD: initialise verification on first run, and auto-satisfy
    // the next unmet DoD criterion on each successful run. This is the only
    // side-effect of DoD — a single dod_verification_json UPDATE on
    // case_progression_state. No writes to personal_cases/zst_cases.
    let dodSatisfiedIdx = -1;
    if (runStatus === 'COMPLETED') {
        // Initialise DoD verification if not yet done (first progression run)
        initializeDoDVerification(db, domain, caseId, contract.definitionOfDone, now);
        // Auto-satisfy the next unmet DoD criterion (gradual completion).
        // This run's contribution is recorded BEFORE the completion guard check,
        // so a case can complete in the same run where the last criterion is met.
        dodSatisfiedIdx = autoSatisfyNextDoDCriterion(db, domain, caseId, runId, now);
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
    let newCompletedPlanStep = completedPlanStep;
    if (runStatus === 'COMPLETED' && nba.canProceedAutonomously) {
        // Mark this NBA step as completed for the next run
        newCompletedPlanStep = nba.planStep;
        // If all plan steps are now completed, check whether the case can
        // actually finish. If all DoD criteria are met → upgrade decision to
        // COMPLETE (the pipeline's own trigger, not just the guard). If DoD
        // is unmet → reset to 0 to start a fresh plan cycle (wrap-around).
        const maxStep = plan.length > 0 ? plan[plan.length - 1].step : 0;
        if (newCompletedPlanStep >= maxStep) {
            const gate = canCompleteCase(db, domain, caseId);
            if (gate.allowed) {
                // All plan steps done + all DoD criteria met → COMPLETE.
                decision = 'COMPLETE';
                reason = `All ${plan.length} plan steps completed and DoD criteria satisfied`;
                // Update the run row (already INSERTed with the original decision)
                db.prepare(`UPDATE case_progression_runs SET decision = ?, reason = ? WHERE progression_run_id = ?`).run(decision, reason, runId);
                // Keep newCompletedPlanStep at maxStep — the case IS done
            }
            else {
                // DoD not yet met — reset to 0 for a fresh plan cycle
                newCompletedPlanStep = 0;
            }
        }
    }
    // "Real progress" means the step counter actually advanced (a step was
    // completed autonomously and its index is higher than before this run).
    // Comparing newCompletedPlanStep vs completedPlanStep catches:
    //   - normal advancement (1→2, 2→3, …)
    //   - exhaustion reset (4→0) — nba.canProceedAutonomously gates it, and
    //     we check progress BEFORE the reset (nba.planStep > completedPlanStep)
    const nbaStepAdvanced = nba.canProceedAutonomously && nba.planStep > completedPlanStep;
    const dodMadeProgress = dodSatisfiedIdx >= 0;
    const realProgress = nbaStepAdvanced || dodMadeProgress;
    const prevNoProgressCount = existing?.no_progress_run_count ?? 0;
    const newNoProgressCount = realProgress ? 0 : prevNoProgressCount + 1;
    // Persist stagnation + step counters
    db.prepare(`UPDATE case_progression_state
     SET no_progress_run_count = ?, completed_plan_step = ?, updated_at = ?
     WHERE domain = ? AND case_id = ?`).run(newNoProgressCount, newCompletedPlanStep, now, domain, caseId);
    // Checkpoint E.4 completion guard: after recording this run's DoD
    // contribution, verify that ALL criteria are met before allowing COMPLETE.
    // If decision is COMPLETE but DoD is still unmet, downgrade to
    // CONTINUE_AUTONOMOUSLY and UPDATE the run record to match.
    if (decision === 'COMPLETE' && runStatus === 'COMPLETED') {
        const isProgressionEnabled = existing != null;
        if (isProgressionEnabled) {
            const gate = canCompleteCase(db, domain, caseId);
            if (!gate.allowed) {
                decision = 'CONTINUE_AUTONOMOUSLY';
                reason = `DoD not met (${gate.reason}). Proceeding autonomously until criteria are satisfied.`;
                // Update the run record to reflect the downgraded decision
                db.prepare(`UPDATE case_progression_runs
           SET decision = ?, reason = ?
           WHERE progression_run_id = ?`).run(decision, reason, runId);
            }
        }
    }
    // When the pipeline decides COMPLETE (either via decide() for an
    // already-COMPLETED case, or via plan-exhaustion trigger above), actually
    // transition the case and remove it from the scheduler. This is the ONE
    // status mutation the progression pipeline is permitted: completion of
    // its own supervised work.
    if (decision === 'COMPLETE' && currentStatus !== 'COMPLETED') {
        const transitionFn = domain === 'personal' ? transitionCase : transitionZstCase;
        transitionFn(db, {
            caseId,
            newStatus: 'COMPLETED',
            actor: 'progression-engine',
            seenVersion: currentVersion,
            reason,
        }, now);
        // Remove from heartbeat scheduler — no more polling for this case
        scheduleNextProgression(db, domain, caseId, null, now);
        db.prepare(`UPDATE case_progression_state SET progression_enabled = 0, updated_at = ? WHERE domain = ? AND case_id = ?`).run(now, domain, caseId);
    }
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
    };
}
/** Read-only Mission Control projection that joins case_progression_state
 *  with the last progression run for display. Does NOT write to
 *  personal_cases/zst_cases — this is a pure SELECT across progression tables
 *  + the case table for title/status. */
export function getMissionControlProgressionView(db, domain) {
    const tableName = domain === 'personal' ? 'personal_cases' : 'zst_cases';
    return db.prepare(`SELECT
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
       r.progression_run_id   AS "lastRunId"
     FROM case_progression_state s
     JOIN ${tableName} c ON c.case_id = s.case_id
     LEFT JOIN case_progression_runs r ON r.progression_run_id = (
       SELECT progression_run_id FROM case_progression_runs
       WHERE case_id = s.case_id AND domain = s.domain
       ORDER BY started_at DESC LIMIT 1
     )
     WHERE s.domain = ?
     ORDER BY s.last_progressed_at DESC`).all(domain);
}
