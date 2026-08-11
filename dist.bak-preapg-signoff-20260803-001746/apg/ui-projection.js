// APG sidecar is the authority (owner spec section 1.4/16). This module is READ-ONLY: it must never INSERT/UPDATE/DELETE against the sidecar DB. If a required table is missing, degrade that computation, never throw past this module's public functions.
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const DISPLAY_STATES = new Set([
    'clarification',
    'evidence_needed',
    'executing',
    'verifying',
    'decision_needed',
    'blocked',
    'accepted',
    'off',
]);
const EMPTY_COUNTS = {
    active: 0,
    evidence_needed: 0,
    verifying: 0,
    decision_needed: 0,
    blocked: 0,
    accepted_today: 0,
    done_not_accepted: 0,
};
export function deriveDisplayState(input) {
    if (input.latestTransitionState !== null
        && DISPLAY_STATES.has(input.latestTransitionState)) {
        return input.latestTransitionState;
    }
    if (input.latestCheckpointResult === 'FAIL')
        return 'blocked';
    if (input.hasAssistedRecommendation
        && input.recommendationEvidenceCompleteness !== 'COMPLETE') {
        return 'evidence_needed';
    }
    if (input.latestCheckpointResult === 'PASS'
        && (input.latestCheckpoint === 'release_ready'
            || input.latestCheckpoint === 'runtime_acceptance')) {
        return 'accepted';
    }
    if (input.latestCheckpointResult === 'UNKNOWN'
        || input.latestCheckpointResult === 'NOT_APPLICABLE') {
        return 'clarification';
    }
    return 'executing';
}
export function resolveApgKernelDbPath() {
    const configured = process.env.APG_KERNEL_DB_PATH;
    if (configured)
        return configured;
    return join(homedir(), 'marveen-local', 'apg-kernel', 'store', 'apg-kernel.db');
}
export function openApgKernelReadonly() {
    const dbPath = resolveApgKernelDbPath();
    if (!existsSync(dbPath))
        return null;
    try {
        return new Database(dbPath, { readonly: true, fileMustExist: true });
    }
    catch {
        return null;
    }
}
// mode is preserved verbatim on both error paths -- an unavailable/broken
// store must never be reported as APG_MODE=off. The caller (API layer, then
// the UI) needs the REAL configured mode to apply the correct degraded
// behaviour per spec section 3's fail-open/fail-closed table: off/observe
// fail-open, assisted must not show a false green, enforced fails closed.
// Collapsing mode to 'off' here would silently defeat enforced's fail-closed
// requirement downstream.
function unavailableSummary(nowIso, mode) {
    return {
        mode,
        enabled: false,
        as_of: nowIso,
        projection_version: 1,
        counts: { ...EMPTY_COUNTS },
        attention_items: [],
        projection_error: 'sidecar_unavailable',
    };
}
function errorSummary(nowIso, mode, error) {
    return {
        mode,
        enabled: false,
        as_of: nowIso,
        projection_version: 1,
        counts: { ...EMPTY_COUNTS },
        attention_items: [],
        projection_error: error instanceof Error ? error.message : String(error),
    };
}
function rowsOrEmpty(db, sql) {
    try {
        return db.prepare(sql).all();
    }
    catch {
        return [];
    }
}
function loadCanonicalRows(db) {
    const withHeads = rowsOrEmpty(db, `
    SELECT
      artifact.id,
      artifact.kind,
      artifact.logical_id,
      artifact.version,
      artifact.content_digest,
      artifact.source_ref,
      artifact.created_at
    FROM canonical_artifact_versions AS artifact
    LEFT JOIN lineage_heads AS head
      ON head.logical_id = artifact.logical_id
    WHERE artifact.kind IN ('work_item', 'change')
      AND (
        head.head_id = artifact.id
        OR (
          head.logical_id IS NULL
          AND artifact.version = (
            SELECT MAX(candidate.version)
            FROM canonical_artifact_versions AS candidate
            WHERE candidate.logical_id = artifact.logical_id
          )
        )
      )
    ORDER BY artifact.logical_id ASC
  `);
    if (withHeads.length > 0)
        return withHeads;
    // A pre-lineage migration copy can still expose its latest canonical rows.
    return rowsOrEmpty(db, `
    SELECT
      artifact.id,
      artifact.kind,
      artifact.logical_id,
      artifact.version,
      artifact.content_digest,
      artifact.source_ref,
      artifact.created_at
    FROM canonical_artifact_versions AS artifact
    WHERE artifact.kind IN ('work_item', 'change')
      AND artifact.version = (
        SELECT MAX(candidate.version)
        FROM canonical_artifact_versions AS candidate
        WHERE candidate.logical_id = artifact.logical_id
      )
    ORDER BY artifact.logical_id ASC
  `);
}
function loadProjectionData(db, includeEvidence) {
    return {
        canonical: loadCanonicalRows(db),
        recommendations: rowsOrEmpty(db, `
      SELECT
        id,
        candidate_id,
        replay_run_id,
        evidence_completeness,
        missing_evidence_json,
        proposed_status_text,
        basis_json,
        draft_marker,
        created_at
      FROM assisted_recommendations
      ORDER BY created_at DESC, id DESC
    `),
        transitions: rowsOrEmpty(db, `
      SELECT
        id,
        change_logical_id,
        from_state,
        to_state,
        checkpoint,
        checkpoint_result,
        replay_run_id,
        created_at
      FROM change_delivery_transitions
      ORDER BY created_at ASC, id ASC
    `),
        checkpoints: rowsOrEmpty(db, `
      SELECT
        id,
        replay_run_id,
        checkpoint,
        result,
        failed_checks,
        profile_overlay,
        created_at
      FROM checkpoint_results
      ORDER BY created_at ASC, id ASC
    `),
        receipts: rowsOrEmpty(db, `
      SELECT
        id,
        replay_run_id,
        change_logical_id,
        tested_commit,
        built_commit,
        deployed_artifact,
        commit_chain_status,
        runtime_status,
        created_at
      FROM execution_receipts
      ORDER BY created_at ASC, id ASC
    `),
        evidence: includeEvidence
            ? rowsOrEmpty(db, `
          SELECT
            id,
            receipt_id,
            link,
            ref_kind,
            ref_locator,
            ref_digest,
            status,
            created_at
          FROM evidence_references
          ORDER BY created_at ASC, id ASC
        `)
            : [],
    };
}
function newest(rows) {
    let result = null;
    for (const row of rows) {
        if (result === null || row.created_at >= result.created_at)
            result = row;
    }
    return result;
}
function epochToMilliseconds(value) {
    return Math.abs(value) >= 1_000_000_000_000 ? value : value * 1000;
}
// Card 1732a148: a unix-seconds `created_at` this small (2001-09-09 and
// earlier) cannot be a real APG kernel activity timestamp -- this store
// (and the whole APG pilot) did not exist before 2026. A handful of real
// sidecar rows carry a literal `created_at=1` (an early-pilot placeholder/
// sentinel, not a crafted value) instead of a real timestamp; treating "1"
// as a genuine 1970-01-01T00:00:01Z epoch turned an age computation into an
// absolute-epoch-sized number. 1_000_000_000 is a generic, well-known
// unix-seconds sanity floor (not project-specific), matching the existing
// `<= 0` guard's spirit rather than hardcoding this pilot's actual start date.
const MIN_PLAUSIBLE_EPOCH_SECONDS = 1_000_000_000;
function isPlausibleEpochSeconds(value) {
    return Number.isFinite(value) && value >= MIN_PLAUSIBLE_EPOCH_SECONDS;
}
function toIso(value) {
    if (!Number.isFinite(value))
        return new Date(0).toISOString();
    return new Date(epochToMilliseconds(value)).toISOString();
}
function extractKanbanCardId(...values) {
    for (const value of values) {
        if (!value)
            continue;
        const match = value.match(/(?:^|[^0-9a-f])([0-9a-f]{8})(?![0-9a-f])/);
        if (match?.[1])
            return match[1];
    }
    return null;
}
function candidateIds(data, includeWorkItems) {
    const ids = new Set();
    for (const row of data.canonical) {
        if (row.kind === 'change' || (includeWorkItems && row.kind === 'work_item')) {
            ids.add(row.logical_id);
        }
    }
    for (const row of data.recommendations)
        ids.add(row.candidate_id);
    return [...ids].sort();
}
function buildCandidateProjection(data, candidateId) {
    const canonical = newest(data.canonical.filter((row) => row.logical_id === candidateId));
    const candidateRecommendations = data.recommendations.filter((row) => row.candidate_id === candidateId);
    const recommendation = newest(candidateRecommendations);
    const transitions = data.transitions.filter((row) => row.change_logical_id === candidateId);
    const transition = newest(transitions);
    const receipts = data.receipts.filter((row) => row.change_logical_id === candidateId);
    const replayRunIds = new Set();
    for (const receipt of receipts)
        replayRunIds.add(receipt.replay_run_id);
    for (const row of candidateRecommendations) {
        if (row.replay_run_id)
            replayRunIds.add(row.replay_run_id);
    }
    for (const row of transitions) {
        if (row.replay_run_id)
            replayRunIds.add(row.replay_run_id);
    }
    const checkpoints = data.checkpoints.filter((row) => replayRunIds.has(row.replay_run_id));
    const latestCheckpoint = newest(checkpoints);
    const receiptIds = new Set(receipts.map((row) => row.id));
    const evidence = data.evidence.filter((row) => receiptIds.has(row.receipt_id));
    // Card 1732a148: filter out implausible `created_at` values (e.g. the
    // real sidecar's `created_at=1` sentinel rows) BEFORE they can ever reach
    // Math.min/Math.max below -- one poisoned row must not corrupt
    // updatedAt/earliestActivityAt for an otherwise-healthy candidate. This is
    // the data-layer half of the fix; ageSeconds() below carries a matching
    // defensive floor so a value from any future/other call site still can't
    // render as an absolute epoch.
    const activityTimes = [
        canonical?.created_at,
        ...candidateRecommendations.map((row) => row.created_at),
        ...transitions.map((row) => row.created_at),
        ...checkpoints.map((row) => row.created_at),
        ...receipts.map((row) => row.created_at),
    ].filter((value) => value !== undefined && isPlausibleEpochSeconds(value));
    const stateActivityTimes = [
        ...transitions.map((row) => row.created_at),
        ...checkpoints.map((row) => row.created_at),
    ].filter(isPlausibleEpochSeconds);
    const displayState = deriveDisplayState({
        latestTransitionState: transition?.to_state ?? null,
        latestCheckpointResult: latestCheckpoint?.result ?? null,
        latestCheckpoint: latestCheckpoint?.checkpoint ?? null,
        hasAssistedRecommendation: recommendation !== null,
        recommendationEvidenceCompleteness: candidateRecommendations.some((row) => row.evidence_completeness !== 'COMPLETE')
            ? 'INCOMPLETE'
            : recommendation?.evidence_completeness ?? null,
    });
    return {
        id: candidateId,
        canonical,
        recommendation,
        transition,
        checkpoints,
        latestCheckpoint,
        receipts,
        evidence,
        displayState,
        updatedAt: activityTimes.length > 0 ? Math.max(...activityTimes) : 0,
        earliestActivityAt: stateActivityTimes.length > 0
            ? Math.min(...stateActivityTimes)
            : activityTimes.length > 0
                ? Math.min(...activityTimes)
                : 0,
        hasConflictingEvidence: receipts.some((row) => row.commit_chain_status === 'MISMATCH'),
    };
}
function attentionReason(candidate) {
    switch (candidate.displayState) {
        case 'blocked':
            return candidate.latestCheckpoint?.checkpoint
                ? `Sikertelen APG kapu: ${candidate.latestCheckpoint.checkpoint}.`
                : 'Az APG folyamat blokkolt.';
        case 'decision_needed':
            return 'A továbblépés tulajdonosi döntésre vár.';
        case 'evidence_needed':
            return 'A javaslathoz szükséges bizonyíték nem teljes.';
        case 'clarification':
            return 'A következő lépéshez tisztázás szükséges.';
        case 'verifying':
            return 'Az eredmény ellenőrzése még folyamatban van.';
        default:
            return null;
    }
}
function nextActionFor(state) {
    switch (state) {
        case 'blocked':
            return 'Oldd fel a sikertelen kaput, majd futtasd újra az ellenőrzést.';
        case 'decision_needed':
            return 'Rögzítsd a szükséges tulajdonosi döntést.';
        case 'evidence_needed':
            return 'Pótold a hiányzó bizonyítékokat.';
        case 'clarification':
            return 'Pontosítsd a célt vagy a szükséges bizonyítékot.';
        case 'verifying':
            return 'Fejezd be az ellenőrzést.';
        case 'accepted':
            return 'Nincs további APG teendő.';
        case 'off':
            return 'Kapcsold be az APG-t, ha kontrollált végrehajtás szükséges.';
        case 'executing':
            return 'Folytasd a végrehajtást és rögzítsd a bizonyítékokat.';
    }
}
function acceptanceStatusFor(state) {
    switch (state) {
        case 'accepted':
            return 'accepted';
        case 'blocked':
            return 'blocked';
        case 'verifying':
            return 'verifying';
        case 'evidence_needed':
        case 'decision_needed':
        case 'clarification':
            return 'returned';
        case 'executing':
            return 'produced';
        case 'off':
            return 'not_started';
    }
}
function claimStatus(row, candidate) {
    if (row.status === 'MISSING')
        return 'BLOCKED_FROM_USE';
    if (row.status !== 'PRESENT')
        return 'UNKNOWN';
    const receipt = candidate.receipts.find((candidateReceipt) => candidateReceipt.id === row.receipt_id);
    if (receipt
        && candidate.checkpoints.some((checkpoint) => checkpoint.replay_run_id === receipt.replay_run_id
            && checkpoint.result === 'PASS')) {
        return 'VERIFIED_CURRENT';
    }
    return 'SUPPORTED_BUT_NOT_RUNTIME_VERIFIED';
}
function allowedWordingFor(status) {
    switch (status) {
        case 'VERIFIED_CURRENT':
            return 'Aktuális, igazolt tényként idézhető.';
        case 'VERIFIED_HISTORICAL':
            return 'Csak történeti tényként idézhető.';
        case 'SUPPORTED_BUT_NOT_RUNTIME_VERIFIED':
            return 'Bizonyítékkal támogatott, de futásidőben nem igazolt.';
        case 'CONFLICTING_EVIDENCE':
            return 'Ellentmondásos tényként, fenntartással idézhető.';
        case 'STALE_OR_SUPERSEDED':
            return 'Elavult vagy felülírt tényként jelölendő.';
        case 'UNKNOWN':
            return 'Csak ismeretlen állapotú állításként közölhető.';
        case 'BLOCKED_FROM_USE':
            return 'Nem idézhető tényként.';
    }
}
function claimsFor(candidate) {
    return candidate.evidence.map((row) => {
        const status = claimStatus(row, candidate);
        return {
            id: row.id,
            text: row.ref_locator
                ? `${row.ref_kind}: ${row.ref_locator}`
                : row.ref_kind,
            status,
            allowed_wording: allowedWordingFor(status),
            source: row.ref_locator || null,
            observed_at: toIso(row.created_at),
            verified_at: status === 'VERIFIED_CURRENT' ? toIso(row.created_at) : null,
            verifier: null,
            receipt_id: row.receipt_id || null,
            superseded_by: null,
        };
    });
}
function summaryFor(candidate, mode, claims = claimsFor(candidate)) {
    const displayState = mode === 'off' ? 'off' : candidate.displayState;
    const checkpointByName = new Map();
    for (const checkpoint of candidate.checkpoints) {
        const prior = checkpointByName.get(checkpoint.checkpoint);
        if (!prior || checkpoint.created_at >= prior.created_at) {
            checkpointByName.set(checkpoint.checkpoint, checkpoint);
        }
    }
    const latestGates = [...checkpointByName.values()];
    const blockingGate = latestGates
        .filter((checkpoint) => checkpoint.result === 'FAIL')
        .sort((a, b) => b.created_at - a.created_at)[0]?.checkpoint ?? null;
    return {
        id: candidate.id,
        kanban_card_id: extractKanbanCardId(candidate.canonical?.source_ref, candidate.recommendation?.candidate_id),
        // The sidecar schema has no reliable project field in this stage.
        project: null,
        title: candidate.id,
        effective_mode: mode,
        mode_source: 'global',
        display_state: displayState,
        internal_state: displayState,
        risk: 'unknown',
        attention_reason: attentionReason({ ...candidate, displayState }),
        next_action: nextActionFor(displayState),
        producer_agent: null,
        accepter_agent: null,
        gate_progress: {
            passed: latestGates.filter((checkpoint) => checkpoint.result === 'PASS').length,
            total: latestGates.length,
            blocking_gate: blockingGate,
        },
        claim_counts: {
            total: claims.length,
            verified_current: claims.filter((claim) => claim.status === 'VERIFIED_CURRENT').length,
            conflicting: claims.filter((claim) => claim.status === 'CONFLICTING_EVIDENCE').length,
            unknown: claims.filter((claim) => claim.status === 'UNKNOWN').length,
            blocked: claims.filter((claim) => claim.status === 'BLOCKED_FROM_USE').length,
        },
        acceptance_status: acceptanceStatusFor(displayState),
        updated_at: toIso(candidate.updatedAt),
    };
}
function attentionPriority(candidate) {
    if (candidate.displayState === 'blocked')
        return 5;
    if (candidate.displayState === 'decision_needed')
        return 4;
    if (candidate.displayState === 'evidence_needed' && candidate.hasConflictingEvidence) {
        return 3;
    }
    if (candidate.displayState === 'evidence_needed')
        return 2;
    return 1;
}
// Card 1732a148: `createdAt <= 0` alone does not reject an implausibly
// small POSITIVE epoch (e.g. a sentinel `created_at=1`) -- treated as unix
// seconds, epochToMilliseconds(1) resolves to 1970-01-01T00:00:01Z, and the
// "age" then computed is essentially the current unix timestamp itself.
// This is defense-in-depth: buildCandidateProjection now filters implausible
// timestamps out before they can become earliestActivityAt in the first
// place (see isPlausibleEpochSeconds above), but ageSeconds keeps its own
// floor so a value from any other/future call site still can't render as an
// absolute epoch. Same "unknown timestamp" convention as the existing
// `createdAt <= 0` branch: returns 0, not a fabricated age.
export function ageSeconds(nowIso, createdAt) {
    const now = Date.parse(nowIso);
    if (!Number.isFinite(now) || !isPlausibleEpochSeconds(createdAt))
        return 0;
    return Math.max(0, Math.floor((now - epochToMilliseconds(createdAt)) / 1000));
}
export function buildApgUiSummary(nowIso, mode) {
    if (mode === 'off') {
        return {
            mode,
            enabled: false,
            as_of: nowIso,
            projection_version: 1,
            counts: { ...EMPTY_COUNTS },
            attention_items: [],
        };
    }
    const db = openApgKernelReadonly();
    if (!db)
        return unavailableSummary(nowIso, mode);
    try {
        const data = loadProjectionData(db, false);
        const candidates = candidateIds(data, true).map((id) => buildCandidateProjection(data, id));
        const counts = {
            active: candidates.filter((candidate) => candidate.displayState !== 'accepted' && candidate.displayState !== 'off').length,
            evidence_needed: candidates.filter((candidate) => candidate.displayState === 'evidence_needed').length,
            verifying: candidates.filter((candidate) => candidate.displayState === 'verifying').length,
            decision_needed: candidates.filter((candidate) => candidate.displayState === 'decision_needed').length,
            blocked: candidates.filter((candidate) => candidate.displayState === 'blocked').length,
            accepted_today: candidates.filter((candidate) => candidate.displayState === 'accepted'
                && toIso(candidate.updatedAt).slice(0, 10) === nowIso.slice(0, 10)).length,
            done_not_accepted: candidates.filter((candidate) => candidate.transition?.to_state === 'done'
                && candidate.displayState !== 'accepted').length,
        };
        const attentionItems = candidates
            .filter((candidate) => candidate.displayState !== 'accepted' && candidate.displayState !== 'off')
            .sort((a, b) => attentionPriority(b) - attentionPriority(a)
            || ageSeconds(nowIso, b.earliestActivityAt)
                - ageSeconds(nowIso, a.earliestActivityAt)
            || a.id.localeCompare(b.id))
            .slice(0, 5)
            .map((candidate) => ({
            work_item_id: candidate.id,
            kanban_card_id: extractKanbanCardId(candidate.canonical?.source_ref, candidate.recommendation?.candidate_id),
            // The sidecar schema has no reliable project field in this stage.
            project: null,
            title: candidate.id,
            display_state: candidate.displayState,
            reason: attentionReason(candidate) ?? 'Az APG munkaelem aktív.',
            next_action: nextActionFor(candidate.displayState),
            age_seconds: ageSeconds(nowIso, candidate.earliestActivityAt),
            deep_link: `/apg/work-items/${encodeURIComponent(candidate.id)}`,
        }));
        return {
            mode,
            enabled: true,
            as_of: nowIso,
            projection_version: 1,
            counts,
            attention_items: attentionItems,
        };
    }
    catch (error) {
        return errorSummary(nowIso, mode, error);
    }
    finally {
        try {
            db.close();
        }
        catch {
            // A failed/closed reader must not escape the read-model boundary.
        }
    }
}
export function buildApgWorkItemSummaries(mode, filters) {
    const db = openApgKernelReadonly();
    if (!db)
        return { error: 'sidecar_unavailable' };
    try {
        const data = loadProjectionData(db, true);
        // includeWorkItems:true here so this list stays consistent with
        // buildApgUiSummary's counts (which include kind='work_item' rows) and
        // with attention_items' deep_links -- excluding work_item candidates
        // here would let a summary attention item link to a detail id that this
        // list (and buildApgWorkItemDetail's lookup below) reports as not found.
        let items = candidateIds(data, true)
            .map((id) => buildCandidateProjection(data, id))
            .map((candidate) => summaryFor(candidate, mode));
        // Project is deliberately always null until the sidecar owns a project field.
        if (filters.project !== undefined)
            items = [];
        if (filters.state !== undefined) {
            items = items.filter((item) => item.display_state === filters.state);
        }
        if (filters.attention) {
            items = items.filter((item) => item.attention_reason !== null);
        }
        if (filters.kanbanCardId !== undefined) {
            items = items.filter((item) => item.kanban_card_id === filters.kanbanCardId);
        }
        items.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
        const total = items.length;
        const offset = Math.max(0, Math.trunc(filters.offset));
        const limit = Math.max(0, Math.trunc(filters.limit));
        return { items: items.slice(offset, offset + limit), total };
    }
    catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
    finally {
        try {
            db.close();
        }
        catch {
            // A failed/closed reader must not escape the read-model boundary.
        }
    }
}
export function buildApgWorkItemDetail(mode, workItemId) {
    const db = openApgKernelReadonly();
    if (!db)
        return { error: 'sidecar_unavailable' };
    try {
        const data = loadProjectionData(db, true);
        if (!candidateIds(data, true).includes(workItemId)) {
            return { error: 'work_item_not_found', notFound: true };
        }
        const candidate = buildCandidateProjection(data, workItemId);
        const claims = claimsFor(candidate);
        const summary = summaryFor(candidate, mode, claims);
        const transitions = data.transitions.filter((row) => row.change_logical_id === workItemId);
        const events = transitions.map((row) => ({
            id: row.id,
            type: 'change_delivery_transition',
            at: toIso(row.created_at),
            agent: null,
            work_item_id: row.change_logical_id,
            receipt_id: null,
            summary: `${row.from_state} → ${row.to_state}`
                + (row.checkpoint ? ` (${row.checkpoint}: ${row.checkpoint_result ?? 'UNKNOWN'})` : ''),
            error: row.checkpoint_result === 'FAIL' || row.to_state === 'blocked',
        }));
        const sourceIds = new Set();
        if (candidate.canonical)
            sourceIds.add(candidate.canonical.id);
        if (candidate.recommendation)
            sourceIds.add(candidate.recommendation.id);
        for (const row of candidate.receipts)
            sourceIds.add(row.id);
        for (const row of candidate.checkpoints)
            sourceIds.add(row.id);
        for (const row of candidate.evidence)
            sourceIds.add(row.id);
        for (const row of transitions)
            sourceIds.add(row.id);
        return {
            ...summary,
            goal: '',
            scope: '',
            claims,
            evidence_summary: {
                present: candidate.evidence.filter((row) => row.status === 'PRESENT').length,
                unknown: candidate.evidence.filter((row) => row.status === 'UNKNOWN').length,
                missing: candidate.evidence.filter((row) => row.status === 'MISSING').length,
            },
            receipts: candidate.evidence.map((row) => ({
                id: row.id,
                link: row.link,
                ref_kind: row.ref_kind,
                status: row.status,
                created_at: toIso(row.created_at),
            })),
            events,
            rollback_info: null,
            side_effect_status: newest(candidate.receipts)?.runtime_status ?? null,
            source_ids: [...sourceIds],
        };
    }
    catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
    finally {
        try {
            db.close();
        }
        catch {
            // A failed/closed reader must not escape the read-model boundary.
        }
    }
}
/**
 * Build a consolidated, paginated event feed across all APG work items.
 * Used by GET /api/apg/events for the Activity page event-log (item 5/5).
 */
export function buildApgEvents(limit, offset) {
    const dbPath = resolveApgKernelDbPath();
    let db;
    try {
        /* eslint-disable-next-line @typescript-eslint/no-var-requires */
        const BetterSqlite3 = globalThis.BetterSqlite3;
        if (!BetterSqlite3) {
            return { error: 'BetterSqlite3 binding not available' };
        }
        db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
    }
    catch {
        return { error: 'APG sidecar not available' };
    }
    try {
        const rows = rowsOrEmpty(db, `
      SELECT id, change_logical_id, from_state, to_state,
             checkpoint, checkpoint_result, replay_run_id, created_at
      FROM change_delivery_transitions
      ORDER BY created_at DESC
    `);
        const allEvents = rows.map((row) => ({
            id: row.id,
            type: 'change_delivery_transition',
            at: toIso(row.created_at),
            agent: null,
            work_item_id: row.change_logical_id,
            receipt_id: null,
            summary: `${row.from_state} → ${row.to_state}`
                + (row.checkpoint ? ` (${row.checkpoint}: ${row.checkpoint_result ?? 'UNKNOWN'})` : ''),
            error: row.checkpoint_result === 'FAIL' || row.to_state === 'blocked',
        }));
        const total = allEvents.length;
        const page = allEvents.slice(offset, offset + limit);
        return { events: page, total, limit, offset };
    }
    catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
    finally {
        try {
            db.close();
        }
        catch {
            // A failed/closed reader must not escape the read-model boundary.
        }
    }
}
