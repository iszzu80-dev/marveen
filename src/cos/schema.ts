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

/** Add any missing columns to an existing table (nullable ADD COLUMN is safe and
 *  cheap). Used to evolve tables that predate a field without a table rebuild.
 *  `defs` maps column name → its SQL type/definition. */
// F-2: this set has to hold for BOTH ledgers, because ONE executor
// (makeExecutor) writes both, and the two schemas are initialised by two
// different exported functions. Module scope, not a local inside one of them —
// a local is exactly how the ZST half came to be skipped.
const LEDGER_SHARED_COLUMNS: Record<string, string> = {
  campaign_id:   'TEXT',
  outbound_kind: 'TEXT',   // INITIAL | FOLLOW_UP | REPLY
  recipient:     'TEXT',
  rendered_payload_hash: 'TEXT',
  case_version:  'INTEGER',
  run_id:        'TEXT',
  provider_message_id: 'TEXT',
  rfc_message_id: 'TEXT',
  rendered_variables_hash: 'TEXT',
}

/**
 * Widen a table's CHECK(status IN (...)) on a database that already has the
 * narrow one. SQLite cannot ALTER a CHECK, so the table is rebuilt.
 *
 * `probeValue` is a status that the NEW constraint allows and the old one does
 * not: it is written to a scratch row and rolled back, so this is a no-op on a
 * database that is already wide. Detecting by trying is the point — parsing the
 * stored DDL would be guessing at text.
 *
 * The copy is a plain INSERT … SELECT, never INSERT OR IGNORE, and the row
 * counts are compared before the old table is dropped. OR IGNORE silently drops
 * whatever collides, which is the failure mode where a migration reports success
 * and takes rows with it.
 */
// F-9: hoisted to module scope. It was a `const` inside one init
// function while the ZST approvals table is created by another — which is how
// the ZST half of the envelope came to have no columns at all.
const APPROVAL_ENVELOPE: Record<string, string> = {
  allowed_recipients:       'TEXT',      // JSON array — no list means no authority
  allowed_channels:         'TEXT',
  template_id:              'TEXT',
  template_version:         'INTEGER',
  allowed_variable_schema:  'TEXT',
  allowed_variable_sources: 'TEXT',
  forbidden_variables:      'TEXT',
  shareable_data:           'TEXT',
  quote_target_budget:      'REAL',
  quote_hard_limit:         'REAL',
  autonomous_spend_limit:   'REAL NOT NULL DEFAULT 0',   // §3.2 invariant, never non-zero
  currency:                 'TEXT',
  max_initial_outbound:     'INTEGER',
  max_follow_up_outbound:   'INTEGER',
  max_autonomous_replies:   'INTEGER',
  max_total_outbound:       'INTEGER',
  follow_up_policy:         'TEXT',
  allowed_reply_classes:    'TEXT',
  allowed_attachment_types: 'TEXT',
  stop_conditions:          'TEXT',
  escalation_conditions:    'TEXT',
  final_gate:               "TEXT NOT NULL DEFAULT 'NONE'",
  valid_until:              'INTEGER',
  stopped_reason:           'TEXT',      // §3.4 — set when a stop condition trips
}

function widenCheckConstraint(db: Database.Database, table: string, probeValue: string, createSql: string): void {
  const already = db.transaction((): boolean => {
    try {
      db.prepare(`UPDATE ${table} SET status = ? WHERE 0 = 1`).run(probeValue)
      // A no-row UPDATE does not evaluate the CHECK, so probe for real, then throw
      // to roll back whatever it did.
      const one = db.prepare(`SELECT rowid FROM ${table} LIMIT 1`).get() as { rowid: number } | undefined
      if (!one) return true // empty table: the CREATE above already has the wide CHECK
      db.prepare(`UPDATE ${table} SET status = ? WHERE rowid = ?`).run(probeValue, one.rowid)
      throw new Error('__rollback__')
    } catch (e) {
      if (String((e as Error).message) === '__rollback__') return true
      return false
    }
  })()
  if (already) return

  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name).join(', ')
  const before = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  // createSql is passed in, NOT read back from sqlite_master: the caller's
  // CREATE TABLE IF NOT EXISTS was a no-op on this database, so sqlite_master
  // still holds the NARROW definition. Re-executing that would rebuild the very
  // constraint being widened and report success.
  db.transaction(() => {
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_pre_widen`)
    db.exec(createSql)
    db.exec(`INSERT INTO ${table} (${cols}) SELECT ${cols} FROM ${table}_pre_widen`)
    const after = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    if (after !== before) throw new Error(`widenCheckConstraint(${table}): copied ${after} of ${before} rows — refusing to drop the original`)
    db.exec(`DROP TABLE ${table}_pre_widen`)
  })()
}

function ensureColumns(db: Database.Database, table: string, defs: Record<string, string>): void {
  const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name))
  for (const [name, def] of Object.entries(defs)) {
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`)
  }
}

import { ensureLadderSchema } from './autonomy-ladder.js'
import { ensureQuoteSchema } from './quote-campaign.js'

export function initCosSchema(db: Database.Database): void {
  // §22 fokozatos autonomia tablai
  ensureLadderSchema(db)
  // §13.1 ajanlatkero-kampany
  ensureQuoteSchema(db)

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
  // A personal_case_events append-only triggerei lentebb, a ZST-parjukkal
  // egyutt epulnek ujra (DROP + CREATE) -- lasd az ottani indoklast.


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
  // BEFORE it happens, with a crash-safe state machine the spec's P0/P1 rounds
  // hardened (state model = executor.ts, spec P1.1):
  //   PLANNED  → SENDING (persisted BEFORE the external call, P0.3 crash window)
  //            → APPLIED_UNVERIFIED (provider accepted; readback not yet proven)
  //            → VERIFIED (readback found the marker).
  //   send exception, outcome UNKNOWN → OUTCOME_UNKNOWN → recovery readback →
  //            VERIFIED, or (proven absent) back to PLANNED for a safe resend.
  //   send provably never reached provider → FAILED_RETRYABLE / FAILED_TERMINAL.
  //   deliberate abort of a not-yet-sent row → CANCELLED.
  //   provider claimed success but marker provably absent → RECOVERY_REQUIRED.
  // Double-send is prevented four ways: (1) SENDING is durable before the call
  // so a crash leaves a trail; (2) APPLIED_UNVERIFIED is durable the moment the
  // provider accepts, and a resend is forbidden from it; (3) recovery reads back
  // the searchable idempotency marker instead of blindly resending; (4) DB
  // UNIQUE on the internal idempotency key AND on (case, action_type, sequence)
  // is the last line even if the app logic is bypassed (P0.3/P0.4).

  // P1.1 migration: pre-P1.1 dbs carry the old CHECK (APPLIED/FAILED) and no
  // external_idempotency_marker column. SQLite cannot ALTER a CHECK, so rename
  // the old table aside BEFORE the (new) CREATE, then copy rows over mapping the
  // legacy states. FK (outbound→cases) holds throughout; nothing references
  // outbound_ledger, so the rename is safe with foreign_keys ON.
  const _obExists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbound_ledger'`).get()
  if (_obExists) {
    const _cols = db.prepare(`PRAGMA table_info(outbound_ledger)`).all() as Array<{ name: string }>
    if (!_cols.some(c => c.name === 'external_idempotency_marker')) {
      db.exec(`ALTER TABLE outbound_ledger RENAME TO outbound_ledger_pre_p11`)
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbound_ledger (
      ledger_id                TEXT PRIMARY KEY,
      case_id                  TEXT REFERENCES personal_cases(case_id),
      action_type             TEXT NOT NULL,          -- EMAIL_SEND, CALENDAR_CREATE, ...
      sequence_number         INTEGER NOT NULL,        -- P0.4 per-(case,action) ordinal
      internal_idempotency_key TEXT NOT NULL,          -- P0.3 internal dedup key
      external_idempotency_marker TEXT,                -- D.1: marker embedded in the message + searched on readback
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
      CHECK (status IN ('PLANNED','SENDING','APPLIED_UNVERIFIED','OUTCOME_UNKNOWN',
        'VERIFIED','FAILED_RETRYABLE','FAILED_TERMINAL','CANCELLED','RECOVERY_REQUIRED'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_outbound_status ON outbound_ledger(status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_outbound_case ON outbound_ledger(case_id)`)
  const _obOld = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbound_ledger_pre_p11'`).get()
  if (_obOld) {
    db.transaction(() => {
      db.exec(`
        INSERT INTO outbound_ledger
          (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key,
           external_idempotency_marker, status, payload, external_ref, claim_fence,
           attempt, last_error, created_at, updated_at, sending_at, applied_at, verified_at)
        SELECT ledger_id, case_id, action_type, sequence_number, internal_idempotency_key,
           internal_idempotency_key,
           CASE status
             WHEN 'APPLIED' THEN 'APPLIED_UNVERIFIED'
             WHEN 'FAILED'  THEN 'FAILED_TERMINAL'
             ELSE status END,
           payload, external_ref, claim_fence, attempt, last_error, created_at, updated_at,
           sending_at, applied_at, verified_at
        FROM outbound_ledger_pre_p11`)
      db.exec(`DROP TABLE outbound_ledger_pre_p11`)
    })()
  }

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
  const BATCHES_DDL = `
    CREATE TABLE IF NOT EXISTS email_processing_batches (
      batch_id         TEXT PRIMARY KEY,
      gmail_account_id TEXT NOT NULL,
      cursor_before    TEXT,
      cursor_after     TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'OPEN',
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      -- F-14 / A.1: BLOCKED, READY_TO_COMMIT, COMMITTED and RECOVERY_REQUIRED
      -- were in the spec and not in this CHECK, so a batch that could never
      -- close sat in PROCESSING — the same state as one being worked on right
      -- now. "Stuck forever" and "busy" have to be distinguishable or no alert
      -- can tell them apart.
      CHECK (status IN ('OPEN','PROCESSING','READY_TO_COMMIT','COMMITTED',
        'TERMINAL','QUARANTINED','BLOCKED','RECOVERY_REQUIRED'))
    )
  `
  db.exec(BATCHES_DDL)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ebatch_acct ON email_processing_batches(gmail_account_id, status)`)
  widenCheckConstraint(db, 'email_processing_batches', 'BLOCKED', BATCHES_DDL)

  // per-message processing state (the 7+ status model). UNIQUE(account,message)
  // makes re-discovery a no-op instead of a second processing row.
  const EPROC_DDL = `
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
      content_hash     TEXT,                  -- P1.2 content fingerprint (resend/self-event dedup)
      self_event_count INTEGER NOT NULL DEFAULT 0,  -- P1.2 count of our own label-echo history events seen
      last_self_event_at INTEGER,             -- P1.2 origin log: when we last recognised a self-generated echo
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      UNIQUE(gmail_account_id, message_id),
      -- F-8: SOURCE_COMMIT_SKIPPED. The policy exception used to write
      -- SOURCE_COMMITTED for messages it had NOT marked at the source, which is
      -- §6.3's terminal SUCCESS state, and put the truth in last_error. A state
      -- name that says the opposite of what happened poisons every later query.
      CHECK (status IN ('DISCOVERED','CLAIMED','LOCAL_APPLIED','SOURCE_COMMITTED',
        'SOURCE_COMMIT_SKIPPED','RECOVERY_REQUIRED','EXCLUDED','DUPLICATE','QUARANTINED'))
    )
  `
  db.exec(EPROC_DDL)
  // NOTE: this is NOT the definition that survives. The A.3 block below renames
  // this table away and recreates it (search: EPROC_A3_DDL), because this DDL's
  // UNIQUE key lacks thread_id. Both are kept in step deliberately — a fresh
  // database briefly has this one, and every column and constraint difference
  // between the two is a bug waiting to happen. The F-8 status widening is
  // applied after the A.3 rebuild, where the surviving table is made.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_eproc_batch ON email_processing(batch_id, status)`)
  // Existing dbs (email_processing predates P1.2): add the new columns in place
  // BEFORE the index that references content_hash — on a live db the table
  // pre-exists without these columns, so the index must come after ensureColumns.
  ensureColumns(db, 'email_processing', {
    content_hash: 'TEXT', self_event_count: 'INTEGER NOT NULL DEFAULT 0', last_self_event_at: 'INTEGER',
  })
  db.exec(`CREATE INDEX IF NOT EXISTS idx_eproc_chash ON email_processing(gmail_account_id, content_hash)`)

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

  // ── §6.3 / A.3: a thread_id BEKERUL az egyedi kulcsba ────────────────
  // A spec kulcsa (fiok, thread_id, message_id); ami epult, az (fiok, message_id).
  // SQLite nem tud meglevo UNIQUE-ot boviteni, ezert tabla-ujraepites — ugyanaz a
  // minta, amit az outbound_ledger P1.1 migracioja hasznal fentebb.
  //
  // A thread_id NULLABLE marad: SQLite-ban egy NULL nem utkozik semmivel, tehat
  // egy szal nelkuli sor tovabbra is bekerulhet. Ezert a message_id-ra KULON
  // egyedi index is kell — enelkul a bovitett kulcs GYENGIThetne a vedelmet
  // (ugyanaz az uzenet ketszer, egyszer szal nelkul, egyszer szallal).
  const _epExists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_processing'`).get()
  if (_epExists) {
    const _epSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name='email_processing'`)
      .get() as { sql: string }).sql
    const _hasThreadInKey = /UNIQUE\s*\([^)]*thread_id[^)]*\)/.test(_epSql)
    if (!_hasThreadInKey) {
      db.exec(`ALTER TABLE email_processing RENAME TO email_processing_pre_a3`)
    }
  }
  const EPROC_A3_DDL = `
    CREATE TABLE IF NOT EXISTS email_processing (
      gmail_account_id TEXT NOT NULL,
      message_id       TEXT NOT NULL,
      thread_id        TEXT,
      batch_id         TEXT NOT NULL REFERENCES email_processing_batches(batch_id),
      status           TEXT NOT NULL DEFAULT 'DISCOVERED',
      case_id          TEXT,
      attempt          INTEGER NOT NULL DEFAULT 0,
      last_error       TEXT,
      quarantine_reason TEXT,
      content_hash     TEXT,
      self_event_count INTEGER NOT NULL DEFAULT 0,
      last_self_event_at INTEGER,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      UNIQUE(gmail_account_id, thread_id, message_id),
      -- F-8: SOURCE_COMMIT_SKIPPED. This is the SURVIVING definition of
      -- email_processing; the one ~120 lines up is renamed away by the block
      -- above. A change made only there is a change that never takes effect,
      -- which is exactly how this widening was first written and first failed.
      CHECK (status IN ('DISCOVERED','CLAIMED','LOCAL_APPLIED','SOURCE_COMMITTED',
        'SOURCE_COMMIT_SKIPPED','RECOVERY_REQUIRED','EXCLUDED','DUPLICATE','QUARANTINED'))
    )
  `
  db.exec(EPROC_A3_DDL)
  // A message-szintu egyediseg NEM veszhet el a bovitett kulcs miatt (lasd fent).
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_email_processing_msg
           ON email_processing(gmail_account_id, message_id)`)
  const _epOld = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_processing_pre_a3'`).get()
  if (_epOld) {
    db.exec(`
      INSERT OR IGNORE INTO email_processing
        (gmail_account_id, message_id, thread_id, batch_id, status, case_id, attempt,
         last_error, quarantine_reason, content_hash, self_event_count, last_self_event_at,
         created_at, updated_at)
      SELECT gmail_account_id, message_id, thread_id, batch_id, status, case_id, attempt,
             last_error, quarantine_reason, content_hash, self_event_count, last_self_event_at,
             created_at, updated_at
      FROM email_processing_pre_a3
    `)
    db.exec(`DROP TABLE email_processing_pre_a3`)
  }
  // F-8: an existing database that did NOT go through the A.3 rebuild still has
  // the narrow CHECK. Widen it here, where the surviving definition is known.
  widenCheckConstraint(db, 'email_processing', 'SOURCE_COMMIT_SKIPPED', EPROC_A3_DDL)
  // A RENAME magaval vitte a tabla indexeit, a DROP pedig el is vitte oket.
  // Ezt a meglevo P1.2 migracios teszt kapta el (idx_eproc_chash eltunt) -- a
  // sajat tesztem csak azt nezte, hogy a regi tabla nincs meg. Az indexeket
  // KOTELEZO ujraepiteni a rebuild UTAN, kulonben a migracio nemaan lassit.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_eproc_batch ON email_processing(batch_id, status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_eproc_chash ON email_processing(gmail_account_id, content_hash)`)

  // ── §6.2 / A.5: a ledger hordozza a cimzettet, a szolgaltatoi azonositokat
  //    es a verzio-kotest. Enelkul az AC-21 (minden kimeno visszavezetheto
  //    approvalhoz + case+version-hoz) technikailag nem ellenorizheto.
  //    F-2 (2026-08-10): rendered_payload_hash, case_version and run_id were the
  //    three the §6.2 list asked for and the table did not have at all. The
  //    other columns here existed and were never written on the personal branch,
  //    which is worse than absent: they read as if the trail were saved.
  ensureColumns(db, 'outbound_ledger', {
    channel:              'TEXT',
    provider_message_id:  'TEXT',
    rfc_message_id:       'TEXT',
    campaign_version:     'INTEGER',
    approval_version:     'INTEGER',
    rendered_variables_hash: 'TEXT',
    rendered_payload_hash: 'TEXT',
    case_version:         'INTEGER',
    run_id:               'TEXT',
    first_attempt_at:     'INTEGER',
    error_code:           'TEXT',
  })

  // ── §15: kampany-eletciklus mezok ────────────────────────────────────
  ensureColumns(db, 'campaigns', {
    revoked_at:       'INTEGER',
    revoked_by:       'TEXT',
    pause_reason:     'TEXT',
    outbound_count:   'INTEGER NOT NULL DEFAULT 0',
    follow_up_count:  'INTEGER NOT NULL DEFAULT 0',
    last_activity_at: 'INTEGER',
  })

  // ── §17: a migralt ugyek bizonytalansagi jelolese ────────────────────
  // "bizonytalan = MIGRATED_UNVERIFIED". A Drive-bol hozott ugyek eddig
  // ugyanolyan magabiztosnak latszottak, mint a sajat forrasbol szarmazok.
  db.exec(`
    UPDATE personal_cases SET scope = 'MIGRATED_UNVERIFIED'
    WHERE source_system = 'chatgpt-cos-drive' AND scope = 'PERSONAL_CONFIRMED'
  `)

  // ── §3.2 approval envelope (2026-08-09) ──────────────────────────────
  // Approving a template is not approving a message. The envelope carries the
  // whole frame: who may receive, on which channel, how many times, until when,
  // with what money ceiling, and what makes the campaign stop. Added to BOTH
  // namespaces from one definition — the personal and ZST approval tables had
  // already drifted (ZST had allowed_recipients, personal did not), which meant
  // AC-4 was enforced for the company mailbox and absent for the personal one.
  // See approval-core.ts.
  ensureColumns(db, 'campaign_approvals', APPROVAL_ENVELOPE)
  // The ZST approvals table is created LATER, in initZstSendSchema — the same
  // trap the ZST ledger was in (see ZST_LEDGER_COLUMNS_AFTER_CREATE). Guarded on
  // "if the table exists", this was a no-op on every fresh database, so the ZST
  // approval envelope (valid_until, stop conditions, quotas) simply had no
  // columns to live in. Moved to ZST_APPROVAL_ENVELOPE_AFTER_CREATE below.

  // The ledger needs to say WHICH campaign and WHICH kind of send it was, or the
  // per-kind and total quotas above have nothing to count.
  ensureColumns(db, 'outbound_ledger', LEDGER_SHARED_COLUMNS)
  // The ZST ledger is created LATER in this same function, so the guarded call
  // that used to stand here was a no-op on every fresh database and only ever
  // fired on one that already had the table. It has moved to just after the
  // CREATE (search: ZST_LEDGER_COLUMNS_AFTER_CREATE). Found by F-2: the new
  // columns landed on the personal ledger and every ZST send threw
  // "no such column: recipient" — on a fresh db the ZST ledger had never been
  // through ensureColumns at all.

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

  // ── shopping / price radar (Slice 4; §15) ─────────────────────────────
  // A watched item (a rental search, a grocery product, a product to buy). The
  // scheduler runs due checks through the matching adapter, records each
  // observation, and flips the item to HIT when the best price meets the
  // target. Purchase is NEVER autonomous (the adapters have no checkout) — a HIT
  // just surfaces the deal for the owner.
  db.exec(`
    CREATE TABLE IF NOT EXISTS radar_items (
      radar_id          TEXT PRIMARY KEY,
      case_id           TEXT REFERENCES personal_cases(case_id),
      kind              TEXT NOT NULL,                 -- RENTAL, GROCERY, PRODUCT
      label             TEXT NOT NULL,
      query             TEXT,                          -- JSON: adapter search params
      target_price      INTEGER,                       -- minor units; HIT when best <= this
      max_price         INTEGER,
      currency          TEXT,
      status            TEXT NOT NULL DEFAULT 'ACTIVE',
      check_interval_sec INTEGER NOT NULL DEFAULT 86400,
      next_check_at     INTEGER,
      best_seen_price   INTEGER,                       -- lowest observed so far
      -- P1.6 notification dedup: the last thing we alerted about, so an unchanged
      -- offer never re-notifies. A new alert fires only on a new/different offer,
      -- a significant further drop, or (via a changed offer id) an expiry.
      last_notified_offer_id TEXT,
      last_notified_price    INTEGER,
      last_notified_at       INTEGER,
      notification_reason    TEXT,                     -- NEW_HIT | NEW_OFFER | PRICE_DROP
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      CHECK (status IN ('ACTIVE','PAUSED','HIT','CLOSED'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_radar_due ON radar_items(status, next_check_at)`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS radar_observations (
      obs_id       INTEGER PRIMARY KEY AUTOINCREMENT,
      radar_id     TEXT NOT NULL REFERENCES radar_items(radar_id),
      observed_at  INTEGER NOT NULL,
      best_price   INTEGER,                            -- comparison-currency price used for HIT (= converted_final_price)
      currency     TEXT,                               -- comparison currency
      offer_count  INTEGER,
      offer_ref    TEXT,                               -- JSON snapshot of the best offer
      offer_id     TEXT,                               -- stable id of the best offer (for dedup)
      -- P1.5 FX: EU merchants may quote a different currency than the target. We
      -- record the merchant-currency price AND the converted comparison-currency
      -- price with the rate + its provenance, so the estimate is auditable. When
      -- the merchant already quotes the comparison currency, fx is identity.
      original_currency     TEXT,
      original_final_price  INTEGER,
      comparison_currency   TEXT,
      fx_rate               REAL,
      fx_rate_source        TEXT,
      fx_rate_timestamp     INTEGER,
      converted_final_price INTEGER
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_radarobs_item ON radar_observations(radar_id, observed_at)`)
  // Existing dbs (radar tables predate P1.5/P1.6): add the new columns in place.
  ensureColumns(db, 'radar_items', {
    last_notified_offer_id: 'TEXT', last_notified_price: 'INTEGER',
    last_notified_at: 'INTEGER', notification_reason: 'TEXT',
  })
  ensureColumns(db, 'radar_observations', {
    offer_id: 'TEXT', original_currency: 'TEXT', original_final_price: 'INTEGER',
    comparison_currency: 'TEXT', fx_rate: 'REAL', fx_rate_source: 'TEXT',
    fx_rate_timestamp: 'INTEGER', converted_final_price: 'INTEGER',
  })

  // ── send_quotas (P0.4 atomic quota reservation; §9) ───────────────────
  // A rolling-window counter per quota key (e.g. 'EMAIL_SEND:daily'). The
  // executor/dispatch reserves a slot ATOMICALLY (check-and-increment in one
  // transaction) before an outbound action, so two workers can never both send
  // when only one slot remains. window_start + window_sec define the current
  // window; it resets lazily on the first reservation after it expires.
  db.exec(`
    CREATE TABLE IF NOT EXISTS send_quotas (
      quota_key    TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      window_sec   INTEGER NOT NULL,
      max_count    INTEGER NOT NULL,
      used_count   INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL
    )
  `)

  // ── case_attachments (§12 checksum/readback + §C retention) ───────────
  // An email attachment linked to a case. `checksum` (sha256 of the bytes) is the
  // integrity anchor: a readback recomputes it to prove the stored content was
  // not silently corrupted (P1 item 19). `sensitivity` tags the content so it is
  // never logged raw. §C retention: after the retention window the CONTENT is
  // purged (content NULLed, content_purged_at set) while the row + checksum stay
  // as an audit tombstone — sensitive bytes do not live forever, the record does.
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_attachments (
      attachment_id     TEXT PRIMARY KEY,
      case_id           TEXT REFERENCES personal_cases(case_id),
      message_id        TEXT,
      filename          TEXT,
      mime_type         TEXT,
      byte_size         INTEGER,
      checksum          TEXT NOT NULL,               -- sha256 hex of the content
      sensitivity       TEXT NOT NULL DEFAULT 'SENSITIVE_PERSONAL',
      content           BLOB,                        -- NULLed on retention purge
      content_purged_at INTEGER,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      CHECK (sensitivity IN ('PUBLIC','PERSONAL','SENSITIVE_PERSONAL','HIGHLY_SENSITIVE'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attach_case ON case_attachments(case_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attach_age ON case_attachments(created_at) WHERE content IS NOT NULL`)

  // ── personal_contacts (migration import target) ──────────────────────
  // People/vendors/partners referenced by cases. PII (email/phone) -> defaults
  // to SENSITIVE_PERSONAL. Optional case_id links a contact to the case it was
  // discovered on; a contact may serve several cases so this is a soft link.
  db.exec(`
    CREATE TABLE IF NOT EXISTS personal_contacts (
      contact_id    TEXT PRIMARY KEY,
      case_id       TEXT REFERENCES personal_cases(case_id),
      name          TEXT NOT NULL,
      company       TEXT,
      role          TEXT,
      email         TEXT,
      phone         TEXT,
      domain        TEXT,
      reliability   TEXT,
      last_contact  TEXT,
      last_work     TEXT,
      last_price    TEXT,
      notes         TEXT,
      sensitivity   TEXT NOT NULL DEFAULT 'SENSITIVE_PERSONAL',
      source_system TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      CHECK (sensitivity IN ('PUBLIC','PERSONAL','SENSITIVE_PERSONAL','HIGHLY_SENSITIVE'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_contact_case ON personal_contacts(case_id)`)

  // ── case_documents (migration import target: Drive POINTERS, no bytes) ─
  // A reference to a document/attachment that physically lives in Google Drive
  // or a Gmail message. Deliberately holds NO content bytes and NO checksum
  // (unlike case_attachments, which stores downloaded email bytes): importing
  // pointers must not copy the files. `doc_kind` = 'DOCUMENT' | 'ATTACHMENT'.
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_documents (
      document_id           TEXT PRIMARY KEY,
      case_id               TEXT REFERENCES personal_cases(case_id),
      doc_kind              TEXT NOT NULL DEFAULT 'DOCUMENT',
      document_type         TEXT,
      title                 TEXT,
      filename              TEXT,
      mime_type             TEXT,
      drive_url             TEXT,
      drive_file_id         TEXT,
      email_message_id      TEXT,
      issuer                TEXT,
      amount                TEXT,
      due_date              TEXT,
      received_at           TEXT,
      is_current            INTEGER,
      external_share_allowed INTEGER,
      sensitivity           TEXT NOT NULL DEFAULT 'SENSITIVE_PERSONAL',
      source_system         TEXT,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      CHECK (sensitivity IN ('PUBLIC','PERSONAL','SENSITIVE_PERSONAL','HIGHLY_SENSITIVE'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_doc_case ON case_documents(case_id)`)

  // ── personal_invoices (migration import target) ──────────────────────
  // Household/personal invoices (e.g. utility bills). Distinct from the
  // CostOps business-invoice tracking (costops_invoices) — different domain.
  // Amounts are stored as-shown minor-unit integers where parseable, else the
  // raw text is preserved in *_shown for honesty.
  db.exec(`
    CREATE TABLE IF NOT EXISTS personal_invoices (
      invoice_id       TEXT PRIMARY KEY,
      case_id          TEXT REFERENCES personal_cases(case_id),
      supplier         TEXT,
      invoice_no       TEXT,
      issue_date       TEXT,
      due_date         TEXT,
      current_charge   INTEGER,
      late_fee         INTEGER,
      total_shown      INTEGER,
      overdue_shown    TEXT,
      currency         TEXT,
      status           TEXT,
      service_address  TEXT,
      payment_reference TEXT,
      sensitivity      TEXT NOT NULL DEFAULT 'SENSITIVE_PERSONAL',
      source_system    TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      CHECK (sensitivity IN ('PUBLIC','PERSONAL','SENSITIVE_PERSONAL','HIGHLY_SENSITIVE'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_invoice_case ON personal_invoices(case_id)`)

  initCosDocumentsSchema(db)
  initZstSchema(db)
  initProgressionSchema(db)
}

// ── Unified COS document/attachment store (personal + ZST) ───────────────────
// Namespace-agnostic on purpose: case_attachments/case_documents are FK-bound to
// personal_cases (personal-only) and case_documents holds no content (drive-ref).
// This ONE table serves both CoS with LOCAL content-addressed storage (no Drive
// dependency): the file bytes live under store/cos-documents/<sha[:2]>/<sha> and
// this row is the index. `namespace` is the scope boundary (personal vs zst never
// mix, same as the case engine); `case_id` is a plain ref (nullable — a document
// can arrive before its case, e.g. a Telegram photo). Content can be purged after
// retention (content_purged_at) while the metadata row stays.
export function initCosDocumentsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cos_documents (
      document_id            TEXT PRIMARY KEY,
      namespace              TEXT NOT NULL,
      case_id                TEXT,
      source                 TEXT NOT NULL,
      source_ref             TEXT,
      filename               TEXT,
      mime_type              TEXT,
      byte_size              INTEGER,
      sha256                 TEXT NOT NULL,
      stored_path            TEXT,
      doc_kind               TEXT,
      issuer                 TEXT,
      amount                 INTEGER,
      due_date               TEXT,
      extracted_text         TEXT,
      sensitivity            TEXT NOT NULL DEFAULT 'UNKNOWN',
      external_share_allowed INTEGER NOT NULL DEFAULT 0,
      received_at            INTEGER,
      content_purged_at      INTEGER,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL,
      CHECK (namespace IN ('personal','zst')),
      CHECK (source IN ('email','telegram','drive','manual','web'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cosdoc_case ON cos_documents(namespace, case_id)`)
  // Same bytes + same case + same namespace = one logical document (dedup anchor).
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cosdoc_dedup ON cos_documents(namespace, sha256, IFNULL(case_id,''))`)
}

// ── ZST Radio Kft. Chief of Staff — Slice 0 (arch option A) ──────────────────
// Separate table namespace (zst_*), SAME engine (case-engine-core.ts). ZST runs
// on a separate Google account (google-zst connector) whose mailbox is purely
// ZST, so connector identity — not a runtime classifier — is the scope boundary
// (AT-ZS01): personal data never reaches these tables because the personal
// ingest never writes them. `workspace` is the thin Operations/Product-Lab
// routing tag that replaced the heavyweight Scope Gate (it routes, it does not
// isolate). Slice 0 is the case engine only: no external writers, no send.
export function initZstSchema(db: Database.Database): void {
  // ── zst_cases (spec §8.1; version = optimistic concurrency) ──────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_cases (
      case_id            TEXT PRIMARY KEY,
      version            INTEGER NOT NULL DEFAULT 1,
      title              TEXT NOT NULL,
      description        TEXT,
      case_type          TEXT NOT NULL,
      category           TEXT,
      workspace          TEXT NOT NULL DEFAULT 'OPERATIONS',
      product_id         TEXT,
      scope              TEXT NOT NULL DEFAULT 'ZST_OPERATIONS_CONFIRMED',
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
      approval_required  INTEGER NOT NULL DEFAULT 0,
      financial_exposure INTEGER,
      currency           TEXT,
      legal_exposure     TEXT,
      sensitivity        TEXT NOT NULL DEFAULT 'ZST_INTERNAL',
      source_system      TEXT,
      source_references  TEXT,
      parent_case_id     TEXT REFERENCES zst_cases(case_id),
      related_case_ids   TEXT,
      related_contact_ids   TEXT,
      related_vendor_ids    TEXT,
      related_partner_ids   TEXT,
      related_document_ids  TEXT,
      related_invoice_ids   TEXT,
      related_contract_ids  TEXT,
      calendar_event_ids TEXT,
      gmail_thread_ids   TEXT,
      github_references  TEXT,
      kanban_card_ids    TEXT,
      workflow_name      TEXT,
      workflow_version   INTEGER,
      last_event_id      INTEGER,
      closure_reason     TEXT,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      completed_at       INTEGER,
      archived_at        INTEGER,
      CHECK (workspace IN ('OPERATIONS','PRODUCT_LAB')),
      CHECK (status IN ('NEW','TRIAGE_REQUIRED','INFORMATION_REQUIRED','READY','PLANNING',
        'AWAITING_INTERNAL_INPUT','AWAITING_APPROVAL','EXECUTING','WAITING_EXTERNAL','FOLLOW_UP_DUE',
        'CALL_REQUIRED','REVIEW_REQUIRED','AWAITING_SELECTION','SCHEDULED','BLOCKED','RECOVERY_REQUIRED',
        'FAILED_RECOVERABLE','FAILED_TERMINAL','COMPLETED','CANCELLED','ARCHIVED')),
      CHECK (sensitivity IN ('PUBLIC','ZST_INTERNAL','ZST_CONFIDENTIAL','ZST_FINANCIAL','ZST_LEGAL',
        'ZST_PERSONAL_DATA','ZST_HIGHLY_SENSITIVE','UNKNOWN'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zcases_status ON zst_cases(status, archived_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zcases_wake   ON zst_cases(next_wake_at) WHERE next_wake_at IS NOT NULL`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zcases_workspace ON zst_cases(workspace, status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zcases_product ON zst_cases(product_id)`)

  // ── zst_case_events (append-only audit log; same shape as personal) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_case_events (
      event_id        INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id         TEXT NOT NULL REFERENCES zst_cases(case_id),
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zevents_case ON zst_case_events(case_id, created_at)`)
  // DROP + CREATE, deliberately NOT "IF NOT EXISTS" (2026-08-09, elesben):
  // egy korabbi build ezeket a triggereket DUPLA idezojeles RAISE-zel hozta
  // letre. SQLite-ban a dupla idezojel azonositot jelent, es csak a legacy
  // fallback tette hasznalhatova -- amig egy sema-atnevezes ujra nem parseolta
  // az EGESZ semat, ekkor "no such column: ..."-ra bukott, es a dashboard
  // boot-loopba esett. A javitott definicio a forrasban MAR helyes volt,
  // csak az `IF NOT EXISTS` miatt sosem ert el a meglevo installhoz.
  //
  // Tanulsag: egy `IF NOT EXISTS` trigger/index definicio egy MAR LETEZO,
  // hibas valtozatot orokre eletben tart. Ahol a definicio maga a szabaly,
  // ott ujra kell irni, nem "csak ha nincs".
  for (const [name, ev] of [['zevents_no_update', 'UPDATE'], ['zevents_no_delete', 'DELETE']] as const) {
    db.exec(`DROP TRIGGER IF EXISTS ${name}`)
    db.exec(`CREATE TRIGGER ${name} BEFORE ${ev} ON zst_case_events
             BEGIN SELECT RAISE(ABORT,'zst_case_events is append-only'); END`)
  }
  for (const [name, ev] of [['pcevents_no_update', 'UPDATE'], ['pcevents_no_delete', 'DELETE']] as const) {
    db.exec(`DROP TRIGGER IF EXISTS ${name}`)
    db.exec(`CREATE TRIGGER ${name} BEFORE ${ev} ON personal_case_events
             BEGIN SELECT RAISE(ABORT,'personal_case_events is append-only'); END`)
  }

  // ── zst_case_claims (fencing token; UNIQUE atomic claim) ─────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_case_claims (
      claim_key        TEXT NOT NULL,
      owner_run_id     TEXT NOT NULL,
      claim_fence      INTEGER NOT NULL DEFAULT 1,
      claimed_at       INTEGER NOT NULL,
      claim_expires_at INTEGER NOT NULL,
      UNIQUE(claim_key)
    )
  `)

  // ── zst_email_processing (Slice 1 read-only ingest ledger) ───────────
  // The per-(account,message) dedup ledger for turning ZST-mailbox emails into
  // zst_cases. Deliberately MINIMAL and read-only: the terminal states here are
  // LOCAL_APPLIED / EXCLUDED / DUPLICATE — there is NO SOURCE_COMMITTED, because
  // that is the Gmail-label WRITE step which needs a write scope (deferred). The
  // authoritative history-sync batch/checkpoint model (spec §12) lands with the
  // write-capable Action Executor; here the heartbeat's own --mark file is the
  // poll-level dedup and UNIQUE(account,message) is the case-level dedup. case_id
  // FKs to zst_cases (NOT personal_cases — the reason this is a separate table).
  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_email_processing (
      gmail_account_id TEXT NOT NULL,
      message_id       TEXT NOT NULL,
      thread_id        TEXT,
      case_id          TEXT REFERENCES zst_cases(case_id),
      status           TEXT NOT NULL,
      content_hash     TEXT,
      created_at       INTEGER NOT NULL,
      UNIQUE(gmail_account_id, message_id),
      CHECK (status IN ('LOCAL_APPLIED','EXCLUDED','DUPLICATE','EXCLUDED_SELF_SEND'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zeproc_case ON zst_email_processing(case_id)`)

  initZstSendSchema(db)         // Slice 1 write-half
  initZstFinanceSchema(db)      // Slice 2
  initZstContractsSchema(db)    // Slice 3
  initZstCommercialSchema(db)   // Slice 4
  initZstProductLabSchema(db)   // Slice 5
}

// ── ZST Slice 1 write-half — outbound ledger + campaign/approval (spec §10-11) ──
// The single-external-writer state store for ZST. Mirrors the personal
// outbound_ledger/campaigns/campaign_approvals but case_id → zst_cases. Nothing
// here sends autonomously: campaigns are typed (allows_free_text=0), every send
// needs a per-payload approval bound to the exact rendered_payload_hash AND the
// recipient allowlist. The state machine (executor-core) prevents double-send.
export function initZstSendSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_outbound_ledger (
      ledger_id                TEXT PRIMARY KEY,
      case_id                  TEXT REFERENCES zst_cases(case_id),
      action_type             TEXT NOT NULL,
      sequence_number         INTEGER NOT NULL,
      internal_idempotency_key TEXT NOT NULL,
      external_idempotency_marker TEXT,
      status                  TEXT NOT NULL DEFAULT 'PLANNED',
      payload                 TEXT,
      external_ref            TEXT,
      campaign_id             TEXT,
      campaign_version        INTEGER,
      approval_version        INTEGER,
      claim_fence             INTEGER,
      attempt                 INTEGER NOT NULL DEFAULT 0,
      last_error              TEXT,
      created_at              INTEGER NOT NULL,
      updated_at              INTEGER NOT NULL,
      sending_at              INTEGER,
      applied_at              INTEGER,
      verified_at             INTEGER,
      UNIQUE(internal_idempotency_key),
      UNIQUE(case_id, action_type, sequence_number),
      CHECK (status IN ('PLANNED','SENDING','APPLIED_UNVERIFIED','OUTCOME_UNKNOWN',
        'VERIFIED','FAILED_RETRYABLE','FAILED_TERMINAL','CANCELLED','RECOVERY_REQUIRED'))
    )
  `)
  // ZST_LEDGER_COLUMNS_AFTER_CREATE — the table exists by now, on a fresh
  // database as well as an existing one. One executor writes both ledgers, so
  // the column set must be identical on both.
  ensureColumns(db, 'zst_outbound_ledger', LEDGER_SHARED_COLUMNS)

  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_campaigns (
      campaign_id            TEXT PRIMARY KEY,
      case_id                TEXT REFERENCES zst_cases(case_id),
      campaign_type          TEXT NOT NULL,
      template_id            TEXT,
      template_hash          TEXT,
      status                 TEXT NOT NULL DEFAULT 'DRAFT',
      version                INTEGER NOT NULL DEFAULT 1,
      allows_free_text       INTEGER NOT NULL DEFAULT 0,
      autonomous_spend_limit INTEGER NOT NULL DEFAULT 0,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL,
      CHECK (status IN ('DRAFT','APPROVED','PAUSED','REVOKED','COMPLETED'))
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_campaign_approvals (
      approval_id           TEXT PRIMARY KEY,
      campaign_id           TEXT NOT NULL REFERENCES zst_campaigns(campaign_id),
      campaign_version      INTEGER NOT NULL,
      approved_by           TEXT,
      template_hash         TEXT NOT NULL,
      rendered_payload_hash TEXT NOT NULL,
      allowed_recipients    TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'APPROVED',
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      CHECK (status IN ('PENDING','APPROVED','REJECTED','REVOKED'))
    )
  `)
}

// ── ZST Slice 2 — Finance (invoices, accounting packages, bank reconciliation) ──
// All read-only / local: the data model + duplicate detection + read-only bank
// match suggestions. NO payment initiation, NO bank write (spec §16.4/§18.1);
// the accounting-package SEND is the write-executor half (write-scope gated).
export function initZstFinanceSchema(db: Database.Database): void {
  // ZST_APPROVAL_ENVELOPE_AFTER_CREATE — the table exists by now. One approval
  // engine serves both namespaces (F-9), so the envelope must exist on both.
  ensureColumns(db, 'zst_campaign_approvals', APPROVAL_ENVELOPE)

  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_invoices (
      invoice_id           TEXT PRIMARY KEY,
      case_id              TEXT REFERENCES zst_cases(case_id),
      invoice_type         TEXT NOT NULL DEFAULT 'INCOMING',
      supplier_id          TEXT,
      customer_id          TEXT,
      invoice_number       TEXT,
      issue_date           TEXT,
      performance_date     TEXT,
      due_date             TEXT,
      currency             TEXT NOT NULL DEFAULT 'HUF',
      net_amount           INTEGER,
      vat_amount           INTEGER,
      gross_amount         INTEGER,
      payment_method       TEXT,
      payment_status       TEXT NOT NULL DEFAULT 'UNPAID',
      bank_transaction_id  TEXT,
      document_id          TEXT,
      product_id           TEXT,
      cost_category        TEXT,
      contract_id          TEXT,
      accounting_period    TEXT,
      accounting_package_id TEXT,
      validation_status    TEXT NOT NULL DEFAULT 'UNVALIDATED',
      duplicate_hash       TEXT NOT NULL,
      version              INTEGER NOT NULL DEFAULT 1,
      notes                TEXT,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      -- AT-ZF02: a paid status must carry evidence (a bank_transaction_id).
      CHECK (payment_status IN ('UNPAID','PARTIAL','PAID','DISPUTED','CANCELLED')),
      CHECK (payment_status <> 'PAID' OR bank_transaction_id IS NOT NULL),
      UNIQUE(supplier_id, invoice_number, duplicate_hash)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zinv_case ON zst_invoices(case_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zinv_period ON zst_invoices(accounting_period)`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_accounting_packages (
      package_id                TEXT PRIMARY KEY,
      period                    TEXT NOT NULL,
      status                    TEXT NOT NULL DEFAULT 'OPEN',
      version                   INTEGER NOT NULL DEFAULT 1,
      incoming_invoice_count    INTEGER NOT NULL DEFAULT 0,
      outgoing_invoice_count    INTEGER NOT NULL DEFAULT 0,
      bank_statement_count      INTEGER NOT NULL DEFAULT 0,
      missing_document_count    INTEGER NOT NULL DEFAULT 0,
      unmatched_transaction_count INTEGER NOT NULL DEFAULT 0,
      validation_error_count    INTEGER NOT NULL DEFAULT 0,
      drive_folder_id           TEXT,
      accountant_contact_id     TEXT,
      draft_id                  TEXT,
      sent_message_id           TEXT,
      questions_open            INTEGER NOT NULL DEFAULT 0,
      created_at                INTEGER NOT NULL,
      completed_at              INTEGER,
      UNIQUE(period),
      CHECK (status IN ('OPEN','COLLECTING','VALIDATING','REVIEW','DRAFTED','SENT','WAITING_ACCOUNTANT','COMPLETED','CANCELLED'))
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_bank_transactions (
      bank_transaction_id  TEXT PRIMARY KEY,
      account_id           TEXT,
      statement_id         TEXT,
      booking_date         TEXT,
      value_date           TEXT,
      counterparty         TEXT,
      description          TEXT,
      reference            TEXT,
      amount               INTEGER,
      currency             TEXT NOT NULL DEFAULT 'HUF',
      direction            TEXT,
      matched_invoice_id   TEXT,
      matched_case_id      TEXT REFERENCES zst_cases(case_id),
      matched_product_id   TEXT,
      match_confidence     REAL,
      reconciliation_status TEXT NOT NULL DEFAULT 'UNMATCHED',
      category             TEXT,
      version              INTEGER NOT NULL DEFAULT 1,
      notes                TEXT,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      CHECK (reconciliation_status IN ('UNMATCHED','MATCH_SUGGESTED','MATCHED_VERIFIED','PARTIAL_MATCH','DUPLICATE_SUSPECTED','MISSING_INVOICE','NON_INVOICE_TRANSACTION','REVIEW_REQUIRED'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zbank_recon ON zst_bank_transactions(reconciliation_status)`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_reconciliation_items (
      recon_id            TEXT PRIMARY KEY,
      period              TEXT,
      bank_transaction_id TEXT REFERENCES zst_bank_transactions(bank_transaction_id),
      invoice_id          TEXT REFERENCES zst_invoices(invoice_id),
      status              TEXT NOT NULL DEFAULT 'SUGGESTED',
      confidence          REAL,
      note                TEXT,
      created_at          INTEGER NOT NULL,
      CHECK (status IN ('SUGGESTED','CONFIRMED','REJECTED'))
    )
  `)
}

// ── ZST Slice 3 — Contracts, vendors, licenses, procurement radar ─────────────
export function initZstContractsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_contracts (
      contract_id            TEXT PRIMARY KEY,
      case_id                TEXT REFERENCES zst_cases(case_id),
      title                  TEXT NOT NULL,
      contract_type          TEXT,
      counterparty_id        TEXT,
      status                 TEXT NOT NULL DEFAULT 'DRAFT',
      version                INTEGER NOT NULL DEFAULT 1,
      effective_date         TEXT,
      expiry_date            TEXT,
      renewal_type           TEXT,
      notice_period_days     INTEGER,
      termination_deadline   TEXT,
      financial_commitment   INTEGER,
      currency               TEXT,
      payment_frequency      TEXT,
      product_id             TEXT,
      vendor_id              TEXT,
      document_id            TEXT,
      document_hash          TEXT,
      legal_review_status    TEXT,
      data_processing_relevance TEXT,
      owner                  TEXT,
      next_action            TEXT,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL,
      CHECK (status IN ('DRAFT','UNDER_REVIEW','AWAITING_COUNTERPARTY','AWAITING_APPROVAL','SIGNED','ACTIVE','RENEWAL_DUE','TERMINATION_WINDOW','EXPIRED','TERMINATED','ARCHIVED'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zcontract_status ON zst_contracts(status)`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_obligations (
      obligation_id     TEXT PRIMARY KEY,
      contract_id       TEXT REFERENCES zst_contracts(contract_id),
      description       TEXT,
      obligation_type   TEXT,
      responsible_party TEXT,
      due_date          TEXT,
      recurrence        TEXT,
      financial_amount  INTEGER,
      evidence_required INTEGER NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'OPEN',
      follow_up_at      INTEGER,
      created_at        INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_vendors (
      vendor_id           TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      category            TEXT,
      contact_ids         TEXT,
      status              TEXT NOT NULL DEFAULT 'ACTIVE',
      products_supported  TEXT,
      monthly_cost        INTEGER,
      annual_cost         INTEGER,
      currency            TEXT,
      service_criticality TEXT,
      data_access_level   TEXT,
      security_review     TEXT,
      main_risk           TEXT,
      alternative_vendor  TEXT,
      version             INTEGER NOT NULL DEFAULT 1,
      notes               TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_licenses (
      license_id            TEXT PRIMARY KEY,
      vendor_id             TEXT REFERENCES zst_vendors(vendor_id),
      product_name          TEXT,
      plan                  TEXT,
      quantity              INTEGER,
      users                 INTEGER,
      product_id            TEXT,
      start_date            TEXT,
      renewal_date          TEXT,
      billing_cycle         TEXT,
      price                 INTEGER,
      currency              TEXT,
      auto_renew            INTEGER NOT NULL DEFAULT 0,
      notice_period         TEXT,
      owner                 TEXT,
      usage_status          TEXT,
      business_value        TEXT,
      cancellation_candidate INTEGER NOT NULL DEFAULT 0,
      contract_id           TEXT REFERENCES zst_contracts(contract_id),
      version               INTEGER NOT NULL DEFAULT 1,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zlic_renewal ON zst_licenses(renewal_date)`)
  // Procurement radar (spec §21) — data model. The offer-fetching adapter is
  // deferred (same as the personal product radar): items land ELHALASZTVA/AKTIV
  // and the offers table is populated when a real procurement adapter is wired.
  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_procurement_radar_items (
      radar_id               TEXT PRIMARY KEY,
      title                  TEXT NOT NULL,
      category               TEXT,
      product_id             TEXT,
      requirements_text      TEXT,
      target_price           INTEGER,
      hard_price_cap         INTEGER,
      currency               TEXT,
      quantity               INTEGER,
      license_or_service_model TEXT,
      acceptable_vendor_scope TEXT,
      preferred_vendors      TEXT,
      excluded_vendors       TEXT,
      vendor_country         TEXT,
      contract_term_limit    TEXT,
      auto_renew_allowed     INTEGER NOT NULL DEFAULT 0,
      resume_at              INTEGER,
      status                 TEXT NOT NULL DEFAULT 'ELHALASZTVA',
      best_offer_id          TEXT,
      linked_procurement_case_id TEXT REFERENCES zst_cases(case_id),
      selected_vendor        TEXT,
      last_notified_offer_id TEXT,
      last_notified_price    INTEGER,
      last_notified_at       INTEGER,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL,
      CHECK (status IN ('AKTIV_KERESES','ELHALASZTVA','MEGRENDELVE_VAGY_LESZERZODVE','LEZARVA'))
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_procurement_radar_offers (
      offer_id              TEXT PRIMARY KEY,
      radar_id              TEXT NOT NULL REFERENCES zst_procurement_radar_items(radar_id),
      offer_idempotency_key TEXT NOT NULL,
      vendor                TEXT,
      source_url            TEXT,
      original_currency     TEXT,
      original_final_price  INTEGER,
      comparison_currency   TEXT,
      fx_rate               REAL,
      fx_rate_source        TEXT,
      fx_rate_timestamp     INTEGER,
      converted_final_price INTEGER,
      delivery_time         TEXT,
      warranty              TEXT,
      sla                   TEXT,
      contract_term         TEXT,
      auto_renew            INTEGER,
      captured_at           INTEGER NOT NULL,
      meets_requirements    INTEGER,
      score                 REAL,
      rejection_reason      TEXT,
      UNIQUE(radar_id, offer_idempotency_key)
    )
  `)
}

// ── ZST Slice 4 — Partners and commercial opportunities ───────────────────────
export function initZstCommercialSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_partners (
      partner_id         TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      organization       TEXT,
      contact_ids        TEXT,
      relationship_type  TEXT,
      products           TEXT,
      status             TEXT NOT NULL DEFAULT 'ACTIVE',
      last_contact_at    INTEGER,
      next_follow_up_at  INTEGER,
      commercial_relevance TEXT,
      contract_ids       TEXT,
      opportunity_ids    TEXT,
      version            INTEGER NOT NULL DEFAULT 1,
      notes              TEXT,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_opportunities (
      opportunity_id     TEXT PRIMARY KEY,
      case_id            TEXT REFERENCES zst_cases(case_id),
      product_id         TEXT,
      partner_id         TEXT REFERENCES zst_partners(partner_id),
      title              TEXT NOT NULL,
      opportunity_type   TEXT,
      status             TEXT NOT NULL DEFAULT 'NEW_INQUIRY',
      version            INTEGER NOT NULL DEFAULT 1,
      estimated_value    INTEGER,
      currency           TEXT,
      probability        REAL,
      next_action        TEXT,
      next_action_owner  TEXT,
      decision_needed    INTEGER NOT NULL DEFAULT 0,
      commercial_terms   TEXT,
      data_sensitivity   TEXT,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      CHECK (status IN ('NEW_INQUIRY','QUALIFICATION_REQUIRED','QUALIFIED','RESPONSE_DRAFT','MEETING_PROPOSED','DISCOVERY','PILOT_DISCUSSION','OFFER_REQUIRED','AWAITING_ZST_APPROVAL','OFFER_SENT','NEGOTIATION','WON','LOST','ON_HOLD','CLOSED'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zopp_status ON zst_opportunities(status)`)
}

// ── ZST Slice 5 — Product Lab gateway + product portfolio ─────────────────────
export function initZstProductLabSchema(db: Database.Database): void {
  // Data-driven product portfolio (NOT a hardcoded enum — the list grows; add a
  // product = one INSERT). Seed rows MARV/QQ/ZSIB/WEB/SHARED are inserted by the
  // domain layer, not baked into the schema.
  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_products (
      product_id          TEXT PRIMARY KEY,
      product_name        TEXT NOT NULL,
      business_owner      TEXT,
      development_status  TEXT,
      strategic_goal      TEXT,
      target_market       TEXT,
      current_release     TEXT,
      next_milestone      TEXT,
      milestone_date      TEXT,
      monthly_cost        INTEGER,
      annual_cost         INTEGER,
      external_suppliers  TEXT,
      main_risk           TEXT,
      decision_needed     INTEGER NOT NULL DEFAULT 0,
      product_lab_url     TEXT,
      github_url          TEXT,
      drive_folder_id     TEXT,
      version             INTEGER NOT NULL DEFAULT 1,
      updated_at          INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_product_milestones (
      milestone_id   TEXT PRIMARY KEY,
      product_id     TEXT NOT NULL REFERENCES zst_products(product_id),
      title          TEXT NOT NULL,
      status         TEXT,
      due_date       TEXT,
      blocker        TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    )
  `)
  // Product Lab <-> ZST escalation bridge (spec §23).
  db.exec(`
    CREATE TABLE IF NOT EXISTS zst_product_escalations (
      escalation_id     TEXT PRIMARY KEY,
      source_workspace  TEXT NOT NULL,
      target_workspace  TEXT NOT NULL,
      zst_case_id       TEXT REFERENCES zst_cases(case_id),
      product_id        TEXT,
      request_type      TEXT,
      summary           TEXT,
      required_decision TEXT,
      required_output   TEXT,
      due_at            INTEGER,
      status            TEXT NOT NULL DEFAULT 'OPEN',
      source_references TEXT,
      result_reference  TEXT,
      created_at        INTEGER NOT NULL,
      completed_at      INTEGER,
      CHECK (status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','WAITING_SOURCE','RESULT_READY','ACCEPTED','REJECTED','CANCELLED'))
    )
  `)
}

// ── Autonomous Case Progression Layer v1.1 — Gate 0 foundation (Option B) ──────
// Separate progression-specific state table (Option B: smaller blast radius than
// adding columns to both personal_cases AND zst_cases, which already diverge by
// 14 columns). One migration, one code path, zero changes to existing case tables.
// Unique (domain, case_id) — one progression row per case, domain-scoped.
// progression_enabled=0 + progression_mode='off' means legacy behavior unchanged.
//
// case_progression_runs is the audit/replay ledger (plan §14): every progression
// cycle records its inputs, decision, and output here so the eval harness can
// replay historical cases deterministically.
export function initProgressionSchema(db: Database.Database): void {
  // ── case_progression_state (plan §7/§26, Option B) ─────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_progression_state (
      domain              TEXT NOT NULL,
      case_id             TEXT NOT NULL,
      goal                TEXT,
      definition_of_done_json TEXT,
      success_evidence_requirements_json TEXT,
      semantic_completion_status TEXT NOT NULL DEFAULT 'NOT_STARTED',
      rolling_plan_json   TEXT,
      plan_version        INTEGER NOT NULL DEFAULT 0,
      next_best_action_json TEXT,
      progression_enabled INTEGER NOT NULL DEFAULT 0,
      progression_mode    TEXT NOT NULL DEFAULT 'off',
      next_progression_at INTEGER,
      last_progressed_at  INTEGER,
      progression_claimed_by TEXT,
      progression_claim_expires_at INTEGER,
      blocked_reason      TEXT,
      waiting_on          TEXT,
      interruption_count  INTEGER NOT NULL DEFAULT 0,
      no_progress_run_count INTEGER NOT NULL DEFAULT 0,
      completed_plan_step INTEGER NOT NULL DEFAULT 0,
      goal_version        INTEGER NOT NULL DEFAULT 0,
      case_version        INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      PRIMARY KEY (domain, case_id),
      CHECK (domain IN ('personal','zst')),
      CHECK (progression_mode IN ('off','shadow','internal','external_shadow','live')),
      CHECK (semantic_completion_status IN ('NOT_STARTED','IN_PROGRESS','PROPOSED','VERIFIED'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cps_next_prog ON case_progression_state(domain, next_progression_at) WHERE progression_enabled = 1`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cps_claimed ON case_progression_state(progression_claimed_by, progression_claim_expires_at)`)

  // ── case_progression_runs (plan §14 — audit/replay ledger) ─────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_progression_runs (
      progression_run_id   TEXT PRIMARY KEY,
      domain               TEXT NOT NULL,
      case_id              TEXT NOT NULL,
      trigger_type         TEXT NOT NULL,
      trigger_reference    TEXT,
      case_version_before  INTEGER,
      case_version_after   INTEGER,
      goal_version         INTEGER,
      context_hash         TEXT,
      plan_version_before  INTEGER,
      plan_version_after   INTEGER,
      decision             TEXT,
      reason               TEXT,
      progress_delta_json  TEXT,
      action_ids_json      TEXT,
      escalation_id        TEXT,
      started_at           INTEGER NOT NULL,
      completed_at         INTEGER,
      status               TEXT NOT NULL DEFAULT 'STARTED',
      error_code           TEXT,
      error_summary        TEXT,
      -- Safety assertion results (JSON array of {assertion, passed, detail})
      safety_assertions_json TEXT,
      CHECK (domain IN ('personal','zst')),
      CHECK (status IN ('STARTED','COMPLETED','FAILED','RECOVERY_REQUIRED','CANCELLED')),
      CHECK (trigger_type IN ('INTAKE','SCHEDULED','MANUAL','WAKE','ESCALATION_RESOLVED','RECOVERY'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cpruns_case ON case_progression_runs(domain, case_id, started_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cpruns_status ON case_progression_runs(status, started_at)`)

  // Checkpoint C (card 53f1fd06): resolution audit trail (§10). Migrated in
  // place for existing dbs; the column defaults to NULL for pre-C rows.
  // Checkpoint D (card 6b7e7e5e): LLM-interpreted case summary (§10.2).
  // Checkpoint E.4 (card 25e06d97): DoD verification state (§10.4).
  ensureColumns(db, 'case_progression_state', {
    resolution_audit_json: 'TEXT',
    summary: 'TEXT',
    dod_verification_json: 'TEXT',
  })
  // Migration: completed_plan_step added post-GATE-2 (card 52250c7f follow-up).
  // ALTER TABLE ADD COLUMN with NOT NULL needs an explicit DEFAULT in SQLite.
  try {
    db.exec("ALTER TABLE case_progression_state ADD COLUMN completed_plan_step INTEGER NOT NULL DEFAULT 0")
  } catch { /* column already exists */ }
}
