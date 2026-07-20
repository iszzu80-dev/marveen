-- APG v0.4-lean Pilot Kernel — Minimal Sidecar Store schema
-- 2026-07-16. READ-ONLY design artifact (not executed here).
--
-- Location: store/apg-kernel.db (SQLite, gitignored). SEPARATE from Marveen core
-- (store/claudeclaw.db). The kernel NEVER writes to Marveen core DB; it only READS
-- Marveen sources (kanban, git, Render deploy-history, /health, token_usage) and
-- writes its own append-only records here. Rationale: uninstall = delete this file.
--
-- Design rule: append-only where lineage/evidence integrity matters (no UPDATE/DELETE
-- on receipts/evidence/measurements). Idempotency via deterministic dedup keys so a
-- historical shadow replay can re-run and upsert without duplicating.

PRAGMA journal_mode = WAL;

-- Canonical artifact versions (the 12 APG kinds: product/requirement/decision/change/
-- work_item/implementation/review/evidence/release/metric/approval/resource).
-- Content-addressed: same content -> same digest -> one row.
CREATE TABLE IF NOT EXISTS canonical_artifact_versions (
  id            TEXT PRIMARY KEY,          -- <kind>:<logical_id>:<version>
  kind          TEXT NOT NULL,             -- one of the 12 APG kinds
  logical_id    TEXT NOT NULL,             -- stable identity across versions
  version       INTEGER NOT NULL,
  content_digest TEXT NOT NULL,            -- sha256 of canonical content (immutable ref)
  source_ref    TEXT,                      -- where it was reconstructed from (kanban card id, commit sha, ...) -- hashed if sensitive
  created_at    INTEGER NOT NULL,
  UNIQUE(logical_id, version)
);

-- Lineage heads: current head version per logical artifact (fast "latest" lookup).
CREATE TABLE IF NOT EXISTS lineage_heads (
  logical_id    TEXT PRIMARY KEY,
  head_version  INTEGER NOT NULL,
  head_id       TEXT NOT NULL REFERENCES canonical_artifact_versions(id),
  updated_at    INTEGER NOT NULL
);

-- Edges: typed relationships between artifact versions (the APG graph, kept minimal).
-- edge_type validated against edge-policy.yaml at write time (deterministic check).
CREATE TABLE IF NOT EXISTS edges (
  id            TEXT PRIMARY KEY,          -- dedup: <from_id>|<edge_type>|<to_id>
  from_id       TEXT NOT NULL REFERENCES canonical_artifact_versions(id),
  edge_type     TEXT NOT NULL,
  to_id         TEXT NOT NULL REFERENCES canonical_artifact_versions(id),
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id, edge_type);

-- Execution receipts: append-only chain change->work_item->impl_commit->test->build->deploy->runtime.
-- Each link carries a status so a missing link is EXPLICIT, never invented.
CREATE TABLE IF NOT EXISTS execution_receipts (
  id            TEXT PRIMARY KEY,          -- dedup: replay_run_id|change_logical_id
  replay_run_id TEXT NOT NULL REFERENCES replay_runs(id),
  change_logical_id TEXT NOT NULL,
  tested_commit  TEXT,                     -- sha or NULL
  built_commit   TEXT,                     -- sha or NULL
  deployed_artifact TEXT,                  -- deploy id / digest or NULL
  commit_chain_status TEXT NOT NULL,       -- CONSISTENT | MISMATCH | UNKNOWN | MISSING
  runtime_status TEXT NOT NULL,            -- OBSERVED | UNKNOWN | MISSING
  created_at    INTEGER NOT NULL
);

-- Evidence references: immutable pointers + digests (never the raw payload, never a secret).
CREATE TABLE IF NOT EXISTS evidence_references (
  id            TEXT PRIMARY KEY,          -- dedup: receipt_id|link|ref_digest
  receipt_id    TEXT NOT NULL REFERENCES execution_receipts(id),
  link          TEXT NOT NULL,             -- change|work_item|implementation|test|build|deployment|runtime
  ref_kind      TEXT NOT NULL,             -- commit|deploy|health|test_run|kanban|...
  ref_locator   TEXT,                      -- id/url (hashed if sensitive) or NULL
  ref_digest    TEXT,                      -- sha256 of the referenced evidence content, or NULL
  status        TEXT NOT NULL,             -- PRESENT | UNKNOWN | MISSING
  created_at    INTEGER NOT NULL
);

-- Checkpoint results: deterministic evaluator output per checkpoint per replay.
CREATE TABLE IF NOT EXISTS checkpoint_results (
  id            TEXT PRIMARY KEY,          -- dedup: replay_run_id|checkpoint|change_logical_id
  replay_run_id TEXT NOT NULL REFERENCES replay_runs(id),
  checkpoint    TEXT NOT NULL,             -- spec_ready|verification_ready|release_ready|runtime_acceptance|implementation_ready
  result        TEXT NOT NULL,             -- PASS | FAIL | UNKNOWN | NOT_APPLICABLE
  failed_checks TEXT,                      -- JSON array of deterministic-check ids that failed/unknown
  profile_overlay TEXT,                    -- JSON list of active profiles applied
  created_at    INTEGER NOT NULL
);

-- Token measurements: per replay, the origin-decomposed token fields, each labelled.
CREATE TABLE IF NOT EXISTS token_measurements (
  id            TEXT PRIMARY KEY,          -- dedup: replay_run_id|field
  replay_run_id TEXT NOT NULL REFERENCES replay_runs(id),
  field         TEXT NOT NULL,             -- stable_prefix|apg_packet_fresh|on_demand_retrieval|failed_gate_feedback|output|cache_creation|cache_read|provider_aggregate_input|provider_aggregate_output|unattributed_input
  value_tokens  INTEGER,                   -- NULL when UNKNOWN
  label         TEXT NOT NULL,             -- MEASURED | ESTIMATED | UNKNOWN
  cost_amount   REAL,                      -- optional; cost measured SEPARATELY from occupied context
  occupied_context_estimate INTEGER,       -- optional, ESTIMATED separately
  created_at    INTEGER NOT NULL
);

-- Profile activations: which profiles were active for a replay + their config source.
CREATE TABLE IF NOT EXISTS profile_activations (
  id            TEXT PRIMARY KEY,          -- dedup: replay_run_id|profile
  replay_run_id TEXT NOT NULL REFERENCES replay_runs(id),
  profile       TEXT NOT NULL,             -- base|ui-fullstack|identity-test-data|product-surface-launch|safe-release
  config_ref    TEXT NOT NULL,             -- the profiles/<name>/profile.yaml this loaded from (config-driven, not if/else)
  created_at    INTEGER NOT NULL
);

-- Replay runs: one row per shadow-replay execution (S1 landing, S2 JWT-migration).
CREATE TABLE IF NOT EXISTS replay_runs (
  id            TEXT PRIMARY KEY,          -- <replay_label>:<run_timestamp_from_args>
  replay_label  TEXT NOT NULL,             -- s1-landing | s2-jwt-migration
  complexity_class TEXT NOT NULL,          -- S1 | S2
  max_agent_budget INTEGER NOT NULL,
  mode          TEXT NOT NULL,             -- shadow (read-only) | live (future)
  verdict       TEXT,                      -- PASS | FAIL | UNKNOWN once evaluated
  created_at    INTEGER NOT NULL
);
