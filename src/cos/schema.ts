// Personal Chief of Staff (COS) schema -- ALL COS CREATE TABLE / CREATE INDEX
// / CREATE TRIGGER statements live here, not in src/db.ts. This is the "schema"
// seam (docs/fork-upstream-policy.md §2a): db.ts owns exactly one call,
// `initCosSchema(db)`, marked `// LOCAL-FORK: cos seam`. Idempotent by
// construction (CREATE ... IF NOT EXISTS) -- calling this on an already-migrated
// DB is a safe no-op.
//
// Slice 0 (WP0) of the Personal Chief of Staff (spec v4.2.1). This is the
// greenfield Personal Case Engine core: personal_cases (P0.5 optimistic
// concurrency version), personal_case_events (append-only audit log), and
// case_claims (P0.2 fencing token + P0.3 UNIQUE atomic claim). No external
// connectors, no send/write -- this is the case store only. The campaign /
// outbound_ledger / email_processing / attachments tables (Slice 1) and the
// shopping_radar tables (Slice 4) are documented in docs/cos-slice0-schema.sql
// and land in their own slices; the DB UNIQUE constraints they need are noted
// there so they are not forgotten.
//
// Design source of truth: docs/cos-slice0-schema.sql. Any change here MUST be
// mirrored there (and vice versa) so the design artifact stays honest.

import type Database from 'better-sqlite3'

// The 17 lifecycle states of a personal case (§6.1). Terminal success is
// COMPLETED (there is no "DONE" -- P0.1 removed it as a literal contradiction:
// it was not in the state set but §8 referenced it). Exported so the domain
// layer and tests share ONE definition of the state set rather than
// re-declaring the CHECK-constraint string.
export const CASE_STATUSES = [
  'NEW', 'TRIAGE', 'INFO_REQUIRED', 'READY', 'PLANNING', 'AWAITING_APPROVAL',
  'EXECUTING', 'WAITING_EXTERNAL', 'FOLLOW_UP_DUE', 'CALL_REQUIRED',
  'AWAITING_SELECTION', 'SCHEDULED', 'BLOCKED', 'RECOVERY_REQUIRED',
  'COMPLETED', 'CANCELLED', 'ARCHIVED',
] as const
export type CaseStatus = (typeof CASE_STATUSES)[number]

// P0.6 static data-sensitivity classes (fail-closed: unknown -> HIGHLY_SENSITIVE
// is enforced by the sensitivity gate, not by this column default). Exported for
// the same single-source-of-truth reason.
export const CASE_SENSITIVITIES = [
  'PUBLIC', 'PERSONAL', 'SENSITIVE_PERSONAL', 'HIGHLY_SENSITIVE',
] as const
export type CaseSensitivity = (typeof CASE_SENSITIVITIES)[number]

export function initCosSchema(db: Database.Database): void {
  // ── personal_cases (P0.5 version; §6.1) ──────────────────────────────
  // version: optimistic concurrency. Every domain command reads the version it
  // saw, and the UPDATE carries `WHERE version = :seen` + `version = version+1`;
  // a lost update fails the row-count check instead of silently clobbering.
  db.exec(`
    CREATE TABLE IF NOT EXISTS personal_cases (
      case_id            TEXT PRIMARY KEY,
      version            INTEGER NOT NULL DEFAULT 1,
      title              TEXT NOT NULL,
      description        TEXT,
      case_type          TEXT NOT NULL,
      category           TEXT,
      scope              TEXT NOT NULL DEFAULT 'PERSONAL_CONFIRMED',
      status             TEXT NOT NULL DEFAULT 'NEW',
      priority           TEXT NOT NULL DEFAULT 'P2',
      owner              TEXT NOT NULL DEFAULT 'marveen',
      next_action        TEXT,
      next_action_owner  TEXT,
      due_at             INTEGER,
      follow_up_at       INTEGER,
      next_wake_at       INTEGER,
      waiting_on         TEXT,
      blocked_reason     TEXT,
      sensitivity        TEXT NOT NULL DEFAULT 'PERSONAL',
      source_system      TEXT,
      source_references  TEXT,
      parent_case_id     TEXT REFERENCES personal_cases(case_id),
      related_case_ids   TEXT,
      related_contact_ids   TEXT,
      related_document_ids  TEXT,
      calendar_event_ids TEXT,
      gmail_thread_ids   TEXT,
      last_event_id      INTEGER,
      closure_reason     TEXT,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      completed_at       INTEGER,
      archived_at        INTEGER,
      CHECK (status IN ('NEW','TRIAGE','INFO_REQUIRED','READY','PLANNING','AWAITING_APPROVAL',
        'EXECUTING','WAITING_EXTERNAL','FOLLOW_UP_DUE','CALL_REQUIRED','AWAITING_SELECTION',
        'SCHEDULED','BLOCKED','RECOVERY_REQUIRED','COMPLETED','CANCELLED','ARCHIVED')),
      CHECK (sensitivity IN ('PUBLIC','PERSONAL','SENSITIVE_PERSONAL','HIGHLY_SENSITIVE'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pcases_status ON personal_cases(status, archived_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pcases_wake   ON personal_cases(next_wake_at) WHERE next_wake_at IS NOT NULL`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pcases_parent ON personal_cases(parent_case_id)`)

  // ── personal_case_events (append-only audit log; §6.1) ───────────────
  // case_version records the case version AT the moment of the event, so the
  // event stream is a faithful optimistic-concurrency trail. UPDATE/DELETE are
  // blocked by triggers below -- the log is append-only by construction, not by
  // convention.
  db.exec(`
    CREATE TABLE IF NOT EXISTS personal_case_events (
      event_id        INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id         TEXT NOT NULL REFERENCES personal_cases(case_id),
      case_version    INTEGER NOT NULL,
      actor           TEXT NOT NULL,
      source_system   TEXT,
      source_reference TEXT,
      event_type      TEXT NOT NULL,
      previous_status TEXT,
      new_status      TEXT,
      reason          TEXT,
      payload         TEXT,
      correlation_id  TEXT,
      created_at      INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pcevents_case ON personal_case_events(case_id, created_at)`)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS pcevents_no_update BEFORE UPDATE ON personal_case_events
      BEGIN SELECT RAISE(ABORT,'personal_case_events is append-only'); END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS pcevents_no_delete BEFORE DELETE ON personal_case_events
      BEGIN SELECT RAISE(ABORT,'personal_case_events is append-only'); END
  `)

  // ── case_claims (P0.2 fencing token, P0.3 UNIQUE, P0.5 atomic; §6.6/§9) ──
  // A single worker may claim a case (or a thread) exclusively. claim_fence is a
  // monotonic token bumped on every takeover; a late write from an expired
  // worker is rejected because its fence is stale. UNIQUE(claim_key) is the last
  // line of defence -- two workers cannot hold the same key even if the
  // conditional upsert is bypassed. The atomic acquire/takeover is ONE
  // conditional upsert (see docs/cos-slice0-schema.sql for the exact statement),
  // never a SELECT-then-UPDATE race.
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_claims (
      claim_key        TEXT NOT NULL,
      owner_run_id     TEXT NOT NULL,
      claim_fence      INTEGER NOT NULL DEFAULT 1,
      claimed_at       INTEGER NOT NULL,
      claim_expires_at INTEGER NOT NULL,
      UNIQUE(claim_key)
    )
  `)
}
