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

  // ── outbound_ledger (Slice 1 core — the single external writer; §7/§8) ──
  // Every outbound side effect (email send, calendar create) is recorded here
  // BEFORE it happens, with a crash-safe state machine the spec's P0 rounds
  // hardened:
  //   PLANNED  → SENDING (persisted BEFORE the external call, P0.3 crash window)
  //            → APPLIED (call returned + external_ref) → VERIFIED (readback)
  //   SENDING/APPLIED on error → OUTCOME_UNKNOWN → recovery readback → VERIFIED
  //            or (proven absent) back to PLANNED for a safe resend.
  // Double-send is prevented three ways: (1) SENDING is durable before the call
  // so a crash leaves a trail; (2) recovery reads back the searchable
  // idempotency marker instead of blindly resending; (3) DB UNIQUE on the
  // internal idempotency key AND on (case, action_type, sequence) is the last
  // line even if the app logic is bypassed (P0.3/P0.4).
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbound_ledger (
      ledger_id                TEXT PRIMARY KEY,
      case_id                  TEXT REFERENCES personal_cases(case_id),
      action_type             TEXT NOT NULL,          -- EMAIL_SEND, CALENDAR_CREATE, ...
      sequence_number         INTEGER NOT NULL,        -- P0.4 per-(case,action) ordinal
      internal_idempotency_key TEXT NOT NULL,          -- P0.3 searchable marker (X-Marveen-Idempotency-Key)
      status                  TEXT NOT NULL DEFAULT 'PLANNED',
      payload                 TEXT,                    -- JSON (rendered outbound content)
      external_ref            TEXT,                    -- provider message/event id after send
      claim_fence             INTEGER,                 -- P0.2 fence of the worker that sent
      attempt                 INTEGER NOT NULL DEFAULT 0,
      last_error              TEXT,
      created_at              INTEGER NOT NULL,
      updated_at              INTEGER NOT NULL,
      sending_at              INTEGER,
      applied_at              INTEGER,
      verified_at             INTEGER,
      UNIQUE(internal_idempotency_key),
      UNIQUE(case_id, action_type, sequence_number),
      CHECK (status IN ('PLANNED','SENDING','APPLIED','OUTCOME_UNKNOWN',
        'VERIFIED','FAILED','RECOVERY_REQUIRED'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_outbound_status ON outbound_ledger(status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_outbound_case ON outbound_ledger(case_id)`)

  // ── email ingestion (Slice 1 inbound safety; P0.1 poison / P0.2 checkpoint) ──
  // The inbound counterpart of outbound_ledger. Three tables enforce the rule
  // the spec's P0.2 round set: the account's Gmail history cursor advances ONLY
  // when a whole BATCH is terminal, so no message is ever skipped and none is
  // reprocessed. P0.1: a poison message goes QUARANTINED (terminal) so one bad
  // message cannot pin the cursor forever.

  // account-level cursor: the single source of truth for "how far we've read".
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_source_checkpoints (
      gmail_account_id TEXT PRIMARY KEY,
      history_cursor   TEXT,                 -- Gmail historyId we've committed through
      updated_at       INTEGER NOT NULL
    )
  `)

  // a batch = the messages fetched between cursor_before and cursor_after. The
  // account cursor only moves to cursor_after when the batch is TERMINAL.
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_processing_batches (
      batch_id         TEXT PRIMARY KEY,
      gmail_account_id TEXT NOT NULL,
      cursor_before    TEXT,
      cursor_after     TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'OPEN',
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      CHECK (status IN ('OPEN','PROCESSING','TERMINAL','QUARANTINED'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ebatch_acct ON email_processing_batches(gmail_account_id, status)`)

  // per-message processing state (the 7+ status model). UNIQUE(account,message)
  // makes re-discovery a no-op instead of a second processing row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_processing (
      gmail_account_id TEXT NOT NULL,
      message_id       TEXT NOT NULL,
      thread_id        TEXT,
      batch_id         TEXT NOT NULL REFERENCES email_processing_batches(batch_id),
      status           TEXT NOT NULL DEFAULT 'DISCOVERED',
      case_id          TEXT REFERENCES personal_cases(case_id),
      attempt          INTEGER NOT NULL DEFAULT 0,
      last_error       TEXT,
      quarantine_reason TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      UNIQUE(gmail_account_id, message_id),
      CHECK (status IN ('DISCOVERED','CLAIMED','LOCAL_APPLIED','SOURCE_COMMITTED',
        'RECOVERY_REQUIRED','EXCLUDED','DUPLICATE','QUARANTINED'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_eproc_batch ON email_processing(batch_id, status)`)

  // ── campaigns + approvals (Slice 1 governance; P0.4 template+rendered, P0.5 revoke) ──
  // The authorization layer over the Action Executor. Two P0 rules:
  //   P0.4: approving a TEMPLATE does not authorize an arbitrary sent message —
  //         the actual RENDERED payload (name, place, LLM sentence) must ALSO be
  //         approved. So an approval binds BOTH template_hash AND
  //         rendered_payload_hash; autonomous send is allowed ONLY from a typed,
  //         slotted template (allows_free_text = 0). Free-text → PREPARE (human).
  //   P0.5: an approval is bound to the campaign VERSION it was granted at; a
  //         revoke/pause bumps the version, so a stale approval no longer
  //         authorizes (an in-flight SENDING action is still handled by the
  //         executor's readback — revoke cannot guarantee a stop mid-send).
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      campaign_id            TEXT PRIMARY KEY,
      case_id                TEXT REFERENCES personal_cases(case_id),
      campaign_type          TEXT NOT NULL,
      template_id            TEXT,
      template_hash          TEXT,
      status                 TEXT NOT NULL DEFAULT 'DRAFT',
      version                INTEGER NOT NULL DEFAULT 1,
      allows_free_text       INTEGER NOT NULL DEFAULT 0,   -- 1 → no autonomous send
      autonomous_spend_limit INTEGER NOT NULL DEFAULT 0,   -- always 0 for now
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL,
      CHECK (status IN ('DRAFT','APPROVED','PAUSED','REVOKED','COMPLETED'))
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaign_approvals (
      approval_id           TEXT PRIMARY KEY,
      campaign_id           TEXT NOT NULL REFERENCES campaigns(campaign_id),
      campaign_version      INTEGER NOT NULL,               -- the version this approval binds to
      approved_by           TEXT,
      template_hash         TEXT NOT NULL,                  -- P0.4 approved template
      rendered_payload_hash TEXT NOT NULL,                  -- P0.4 approved SPECIFIC content
      status                TEXT NOT NULL DEFAULT 'PENDING',
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      CHECK (status IN ('PENDING','APPROVED','REJECTED','REVOKED'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_capprovals_campaign ON campaign_approvals(campaign_id, status)`)

  // ── connector_health (Slice 1 reliability; §20 connector matrix) ──────
  // One row per connector (gmail/calendar/shopping/rental/...). The preCheck
  // gates actions on isUsable(); repeated failures degrade OK → DEGRADED → DOWN,
  // a success resets to OK. `mode` records the current capability
  // (READ_ONLY/READ_WRITE/DISABLED) so e.g. Gmail stays READ_ONLY until the
  // write-scope consent lands.
  db.exec(`
    CREATE TABLE IF NOT EXISTS connector_health (
      connector_id         TEXT PRIMARY KEY,
      kind                 TEXT NOT NULL,
      mode                 TEXT NOT NULL DEFAULT 'READ_ONLY',
      status               TEXT NOT NULL DEFAULT 'UNKNOWN',
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_ok_at           INTEGER,
      last_error_at        INTEGER,
      last_error           TEXT,
      updated_at           INTEGER NOT NULL,
      CHECK (mode IN ('READ_ONLY','READ_WRITE','DISABLED')),
      CHECK (status IN ('OK','DEGRADED','DOWN','UNKNOWN'))
    )
  `)
}
