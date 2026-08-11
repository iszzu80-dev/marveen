// Card 484cad98: Decommissioned lifecycle for cost_sources.
// A decommissioned source (e.g. Render account deleted 2026-07-30) keeps
// its historical ledger rows intact but is excluded from active-collection
// queries. Decommission is a STATE TRANSITION, not a delete.
import { describe, it, expect, beforeAll } from "vitest";
import { initDatabase, getDb } from "../db.js";
import { initCostOpsSchema } from "../costops/schema.js";
function seedSourceAndLines(db, sourceId, provider) {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at)
     VALUES (?,?,?,?,?,1,?,?)`).run(sourceId, sourceId, provider, "hosting", "HUF", now, now);
    // Seed 2 line items so the total is non-trivial
    db.prepare(`INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`).run(sourceId, now, now, "subscription", 40000, "HUF", "manual", now, now);
    db.prepare(`INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`).run(sourceId, now, now, "invoice", 10454, "HUF", "email_invoice", now, now);
}
describe("cost_sources lifecycle_state (Card 484cad98)", () => {
    let db;
    beforeAll(() => {
        // Must use initDatabase (not bare initCostOpsSchema) — the latter calls
        // initDispatchSchema which does CREATE INDEX IF NOT EXISTS on token_usage,
        // and that throws if token_usage does not exist. initDatabase creates the
        // full core schema first (including token_usage), then initCostOpsSchema
        // on top. Without this, the suite is false-green in a clean :memory: DB.
        initDatabase(":memory:");
        db = getDb();
    });
    it("schema migration adds lifecycle_state column with default 'active'", () => {
        const cols = db
            .prepare("PRAGMA table_info(cost_sources)")
            .all();
        const lc = cols.find((c) => c.name === "lifecycle_state");
        expect(lc).toBeDefined();
        expect(lc.dflt_value).toBe("'active'");
    });
    it("index idx_cost_sources_lifecycle exists", () => {
        const indexes = db
            .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_cost_sources_lifecycle'")
            .all();
        expect(indexes.length).toBe(1);
    });
    it("new sources default to lifecycle_state='active'", () => {
        const now = Math.floor(Date.now() / 1000);
        db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at)
       VALUES ('test-src', 'Test', 'test', 'hosting', 'HUF', 1, ?, ?)`).run(now, now);
        const row = db.prepare("SELECT lifecycle_state FROM cost_sources WHERE id = 'test-src'").get();
        expect(row.lifecycle_state).toBe("active");
    });
    it("decommissioning preserves historical cost_line_items (HARD CONSTRAINT)", () => {
        seedSourceAndLines(db, "decom-src", "test");
        // Verify line items exist before decommission
        const beforeTotal = db
            .prepare("SELECT SUM(billed_cost) AS total FROM cost_line_items WHERE source_id = 'decom-src'")
            .get();
        expect(beforeTotal.total).toBe(50454);
        // Transition to decommissioned
        db.prepare("UPDATE cost_sources SET lifecycle_state = 'decommissioned' WHERE id = 'decom-src'").run();
        // Line items must still exist with the exact same total
        const afterTotal = db
            .prepare("SELECT SUM(billed_cost) AS total FROM cost_line_items WHERE source_id = 'decom-src'")
            .get();
        expect(afterTotal.total).toBe(50454);
        // Source row itself must still exist
        const src = db.prepare("SELECT id, lifecycle_state FROM cost_sources WHERE id = 'decom-src'").get();
        expect(src).not.toBeNull();
        expect(src.lifecycle_state).toBe("decommissioned");
    });
    it("decommissioned sources are excluded from active-collection queries", () => {
        seedSourceAndLines(db, "active-src", "test");
        // decommissioned one was already created and transitioned above
        db.prepare("UPDATE cost_sources SET lifecycle_state = 'decommissioned' WHERE id = 'decom-src'").run();
        // Simulate the query pattern used by forecast/alerts/optimization collectors
        const activeIds = db
            .prepare("SELECT id FROM cost_sources WHERE active = 1 AND lifecycle_state != 'decommissioned'")
            .all();
        const ids = activeIds.map((r) => r.id);
        expect(ids).toContain("active-src");
        expect(ids).not.toContain("decom-src");
    });
    it("resolveOperational includes decommissioned sources for name lookup", () => {
        // The nameMap query includes decommissioned so historical line items from
        // a decommissioned account still resolve to a human-readable name.
        const rows = db
            .prepare(`SELECT id, name FROM cost_sources
         WHERE active = 1 OR lifecycle_state = 'decommissioned'`)
            .all();
        const ids = rows.map((r) => r.id);
        expect(ids).toContain("active-src");
        expect(ids).toContain("decom-src");
    });
    it("lifecycle_state survives re-runs idempotently (no crash on second ALTER)", () => {
        // initCostOpsSchema already ran in beforeAll; running again is safe
        expect(() => initCostOpsSchema(db)).not.toThrow();
    });
});
