-- COS Slice 0 schema — Personal Case Engine core (no external deps)
-- Design artifact. Integrálandó a src/db.ts initDatabase()-be CREATE TABLE IF NOT EXISTS
-- blokként (a repo mintája szerint), branch-en + teszttel, NEM hot-edit a live dashboardon.
-- Minden idempotens; csak ÚJ táblák, meglévőt nem érint (a gap-mátrix igazolta: greenfield).
-- v4.2.1 hivatkozások jelölve.

-- ── personal_cases (P0.5 version; §6.1) ──────────────────────────────
CREATE TABLE IF NOT EXISTS personal_cases (
  case_id            TEXT PRIMARY KEY,
  version            INTEGER NOT NULL DEFAULT 1,          -- P0.5 optimista concurrency
  title              TEXT NOT NULL,
  description        TEXT,
  case_type          TEXT NOT NULL,                        -- HOME_REPAIR, PURCHASE, ...
  category           TEXT,
  scope              TEXT NOT NULL DEFAULT 'PERSONAL_CONFIRMED',
  status             TEXT NOT NULL DEFAULT 'NEW',
  priority           TEXT NOT NULL DEFAULT 'P2',           -- P0..P3
  owner              TEXT NOT NULL DEFAULT 'marveen',
  next_action        TEXT,
  next_action_owner  TEXT,
  due_at             INTEGER,
  follow_up_at       INTEGER,
  next_wake_at       INTEGER,                              -- personal-case-wake scheduler
  waiting_on         TEXT,
  blocked_reason     TEXT,
  sensitivity        TEXT NOT NULL DEFAULT 'PERSONAL',     -- P0.6 statikus osztaly
  source_system      TEXT,
  source_references  TEXT,                                 -- JSON
  parent_case_id     TEXT REFERENCES personal_cases(case_id),
  related_case_ids   TEXT,                                 -- JSON
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
);
CREATE INDEX IF NOT EXISTS idx_pcases_status ON personal_cases(status, archived_at);
CREATE INDEX IF NOT EXISTS idx_pcases_wake   ON personal_cases(next_wake_at) WHERE next_wake_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pcases_parent ON personal_cases(parent_case_id);

-- ── personal_case_events (append-only; §6.1) ─────────────────────────
CREATE TABLE IF NOT EXISTS personal_case_events (
  event_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id         TEXT NOT NULL REFERENCES personal_cases(case_id),
  case_version    INTEGER NOT NULL,                        -- a case verziója az eseménykor
  actor           TEXT NOT NULL,
  source_system   TEXT,
  source_reference TEXT,
  event_type      TEXT NOT NULL,
  previous_status TEXT,
  new_status      TEXT,
  reason          TEXT,
  payload         TEXT,                                    -- JSON
  correlation_id  TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pcevents_case ON personal_case_events(case_id, created_at);
-- Append-only kényszer: az UPDATE/DELETE-et trigger tiltja (auditlog integritas, §Section4 DoD)
CREATE TRIGGER IF NOT EXISTS pcevents_no_update BEFORE UPDATE ON personal_case_events
  BEGIN SELECT RAISE(ABORT,'personal_case_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS pcevents_no_delete BEFORE DELETE ON personal_case_events
  BEGIN SELECT RAISE(ABORT,'personal_case_events is append-only'); END;

-- ── case_claims (P0.2 fencing token, P0.3 UNIQUE, P0.5 atomikus; §6.6/§9) ──
CREATE TABLE IF NOT EXISTS case_claims (
  claim_key        TEXT NOT NULL,                          -- case_id vagy thread_id
  owner_run_id     TEXT NOT NULL,
  claim_fence      INTEGER NOT NULL DEFAULT 1,             -- P0.2 monoton, minden atvetellel no
  claimed_at       INTEGER NOT NULL,
  claim_expires_at INTEGER NOT NULL,
  UNIQUE(claim_key)                                        -- P0.3 vegso vedelmi vonal
);
-- Atomikus megszerzes/atvetel (P0.2/P0.5) EGY feltételes upserttel (nem SELECT majd UPDATE):
--   INSERT INTO case_claims(claim_key,owner_run_id,claim_fence,claimed_at,claim_expires_at)
--   VALUES(?, ?, 1, ?, ?)
--   ON CONFLICT(claim_key) DO UPDATE SET
--     owner_run_id=excluded.owner_run_id,
--     claim_fence=case_claims.claim_fence+1,               -- fence++
--     claimed_at=excluded.claimed_at,
--     claim_expires_at=excluded.claim_expires_at
--   WHERE case_claims.claim_expires_at < :now;             -- csak lejart claim vehető át
-- A hívó ellenőrzi hogy a sajat owner_run_id nyert-e; a fence-t az action proposalba menti.

-- ── DB UNIQUE constraintek (P0.3) — a Slice 1 tablakhoz ELŐRE dokumentalva ──
-- outbound_ledger:            UNIQUE(internal_idempotency_key)
-- email_processing:           UNIQUE(gmail_account_id, thread_id, message_id)
-- shopping_radar_offers:      UNIQUE(radar_id, offer_idempotency_key)
-- (ezek a Slice 1/4 migraciojaba kerulnek, itt csak a case_claims UNIQUE aktiv.)

-- ── Megjegyzes a P0.6 statikus sensitivity-hez ──────────────────────
-- NEM uj tabla: a meglevo src/data-sensitivity-gate.ts + sensitivity_audit_log a bazis.
-- Slice 0 feladat: a 3-tier (public/internal/restricted) kiterjesztese 4-re
-- (PUBLIC/PERSONAL/SENSITIVE_PERSONAL/HIGHLY_SENSITIVE) + model-profile allowlist wiring;
-- a fail-safe (unknown->legszenzitivebb) MAR letezik a gate-ben.
