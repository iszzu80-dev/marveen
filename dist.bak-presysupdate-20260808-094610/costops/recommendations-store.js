// CostOps Phase 4 (GAP-17) -- persistence for Anvil's optimization.ts lifecycle
// core. optimization.ts is pure computation (detectors + reconcileRecommendations);
// this is the thin DB layer that applies a RecommendationReconcileResult and
// serves reads/accept/dismiss. Same split as alerts.ts/alerts-store.ts. The
// actual SIGNAL-GATHERING orchestration (running all 9 detectors against real
// subscription/ledger/utilisation data each round) is a separate piece
// (optimization-capture.ts, Anvil, still in progress) -- deferred so this
// module can land now and slot in later without touching this file's contract.
import { serializeEvidence, deserializeEvidence, reconcileRecommendations, acceptRecommendation, dismissRecommendation, } from './optimization.js';
function rowToRecord(row) {
    return {
        type: row.type, evidence: deserializeEvidence(row.evidence_json), dedup_key: row.dedup_key,
        current_monthly_cost: row.current_monthly_cost, estimated_monthly_saving: row.estimated_monthly_saving,
        estimated_annual_saving: row.estimated_annual_saving, switching_cost: row.switching_cost,
        risk: row.risk, confidence: row.confidence,
        human_decision_required: row.human_decision_required, rollback_note: row.rollback_note,
        status: row.status, status_changed_at: row.status_changed_at, status_changed_by: row.status_changed_by,
        expires_at: row.expires_at, first_seen: row.first_seen, last_seen: row.last_seen,
    };
}
/** All recommendations currently stored (any state), for feeding into reconcileRecommendations as `existing`. */
export function listAllRecommendations(db) {
    return db.prepare(`SELECT * FROM costops_recommendations`).all().map(rowToRecord);
}
/** Recommendations for API/dashboard consumption -- defaults to 'open' only. */
export function listRecommendations(db, opts = {}) {
    const status = opts.status ?? 'open';
    const conditions = [];
    const params = [];
    if (status !== 'all') {
        conditions.push('status = ?');
        params.push(status);
    }
    if (opts.type) {
        conditions.push('type = ?');
        params.push(opts.type);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM costops_recommendations ${where} ORDER BY last_seen DESC`).all(...params);
    return rows.map(rowToRecord);
}
/**
 * Apply a RecommendationReconcileResult to the DB in one transaction. Pure DB
 * write, no detection logic -- the caller already ran reconcileRecommendations()
 * against listAllRecommendations()'s current state.
 */
export function applyRecommendationReconciliation(db, result, now) {
    const insertStmt = db.prepare(`
    INSERT INTO costops_recommendations
      (type, evidence_json, dedup_key, current_monthly_cost, estimated_monthly_saving, estimated_annual_saving,
       switching_cost, risk, confidence, human_decision_required, rollback_note, status,
       status_changed_at, status_changed_by, expires_at, first_seen, last_seen, created_at)
    VALUES (@type, @evidence_json, @dedup_key, @current_monthly_cost, @estimated_monthly_saving, @estimated_annual_saving,
       @switching_cost, @risk, @confidence, @human_decision_required, @rollback_note, @status,
       @status_changed_at, @status_changed_by, @expires_at, @first_seen, @last_seen, @now)
  `);
    const touchStmt = db.prepare(`
    UPDATE costops_recommendations SET last_seen = @last_seen, evidence_json = @evidence_json,
      current_monthly_cost = @current_monthly_cost, estimated_monthly_saving = @estimated_monthly_saving,
      estimated_annual_saving = @estimated_annual_saving, switching_cost = @switching_cost,
      risk = @risk, confidence = @confidence
    WHERE dedup_key = @dedup_key
  `);
    const resolveStmt = db.prepare(`UPDATE costops_recommendations SET status = 'resolved', status_changed_at = @now WHERE dedup_key = @dedup_key`);
    const expireStmt = db.prepare(`UPDATE costops_recommendations SET status = 'expired', status_changed_at = @now WHERE dedup_key = @dedup_key`);
    const tx = db.transaction(() => {
        for (const r of result.toInsert) {
            insertStmt.run({
                type: r.type, evidence_json: serializeEvidence(r.evidence), dedup_key: r.dedup_key,
                current_monthly_cost: r.current_monthly_cost, estimated_monthly_saving: r.estimated_monthly_saving,
                estimated_annual_saving: r.estimated_annual_saving, switching_cost: r.switching_cost,
                risk: r.risk, confidence: r.confidence, human_decision_required: r.human_decision_required,
                rollback_note: r.rollback_note, status: r.status, status_changed_at: r.status_changed_at,
                status_changed_by: r.status_changed_by, expires_at: r.expires_at, first_seen: r.first_seen, last_seen: r.last_seen, now,
            });
        }
        for (const t of result.toTouch) {
            touchStmt.run({
                dedup_key: t.dedup_key, last_seen: t.patch.last_seen, evidence_json: serializeEvidence(t.patch.evidence),
                current_monthly_cost: t.patch.current_monthly_cost, estimated_monthly_saving: t.patch.estimated_monthly_saving,
                estimated_annual_saving: t.patch.estimated_annual_saving, switching_cost: t.patch.switching_cost,
                risk: t.patch.risk, confidence: t.patch.confidence,
            });
        }
        for (const r of result.toResolve)
            resolveStmt.run({ dedup_key: r.dedup_key, now });
        for (const r of result.toExpire)
            expireStmt.run({ dedup_key: r.dedup_key, now });
    });
    tx();
}
/** Convenience: detect candidates elsewhere, then reconcile+persist in one call -- the shape optimization-capture.ts (Anvil, in progress) will call once it lands. */
export function reconcileAndPersistRecommendations(db, candidates, now, expirySeconds) {
    const existing = listAllRecommendations(db);
    const result = reconcileRecommendations(existing, candidates, now, expirySeconds);
    applyRecommendationReconciliation(db, result, now);
    return result;
}
function loadOne(db, dedupKey) {
    const row = db.prepare(`SELECT * FROM costops_recommendations WHERE dedup_key = ?`).get(dedupKey);
    return row ? rowToRecord(row) : null;
}
function writeStatus(db, r) {
    db.prepare(`UPDATE costops_recommendations SET status = ?, status_changed_at = ?, status_changed_by = ? WHERE dedup_key = ?`)
        .run(r.status, r.status_changed_at, r.status_changed_by, r.dedup_key);
}
/** Human accepts a recommendation (intends to act on it outside this codebase) -- frozen from further re-detection thereafter (optimization.ts's reconcile). */
export function acceptRecommendationByKey(db, dedupKey, actor, now) {
    if (!actor || !actor.trim())
        return { ok: false, error: 'actor is required to accept a recommendation', status: 400 };
    const existing = loadOne(db, dedupKey);
    if (!existing)
        return { ok: false, error: `no recommendation with dedup_key '${dedupKey}'`, status: 404 };
    const updated = acceptRecommendation(existing, actor, now);
    writeStatus(db, updated);
    return { ok: true, recommendation: updated };
}
/** Human dismisses a recommendation (decided against it) -- frozen from further re-detection thereafter. */
export function dismissRecommendationByKey(db, dedupKey, actor, now) {
    if (!actor || !actor.trim())
        return { ok: false, error: 'actor is required to dismiss a recommendation', status: 400 };
    const existing = loadOne(db, dedupKey);
    if (!existing)
        return { ok: false, error: `no recommendation with dedup_key '${dedupKey}'`, status: 404 };
    const updated = dismissRecommendation(existing, actor, now);
    writeStatus(db, updated);
    return { ok: true, recommendation: updated };
}
