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
  /** §8 / IN-2: the provider thread this action landed in. Without it a case
   *  cannot recognise the reply to its own letter — see gmail-send.send. */
  thread_ref: 'TEXT',
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
  // HOW THIS DETECTS "already wide" — and why it is NOT a write probe any more.
  //
  // The first version wrote `probeValue` onto a real row and threw '__rollback__'
  // to undo it. The try/catch sat INSIDE the transaction callback, so the throw
  // never reached better-sqlite3's wrapper and the transaction COMMITTED — with
  // the probe's UPDATE in it. Every process start silently rewrote the status of
  // the lowest-rowid row: email_processing_batches rowid 1 TERMINAL → BLOCKED,
  // and email_processing rowid 1 SOURCE_COMMITTED → SOURCE_COMMIT_SKIPPED. The
  // second one is the dangerous direction: SOURCE_COMMIT_SKIPPED is terminal, so
  // a batch became closeable and the account cursor advanceable over a message
  // nobody ever marked at the source (AC-11/AC-12, and §19's "cursor advanced on
  // a non-terminal batch" critical alert). Found by the second code review,
  // 2026-08-10; reproduced on the live store, both rows restored from the
  // pre-merge backup.
  //
  // Reading the stored CHECK is what should have been here from the start. I
  // argued against it in the original comment ("parsing text would be guessing")
  // and that was wrong twice over: it is precise enough — the constraint either
  // lists the literal or it does not — and, decisively, it CANNOT WRITE. A wrong
  // "already wide" only skips a rebuild that was not needed; a wrong "not wide"
  // triggers a rebuild that is verified by row count and foreign-key check
  // anyway. Neither failure mode can corrupt a row. The old one could, and did.
  const storedSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { sql: string } | undefined)?.sql
  if (!storedSql) return // no such table yet; the caller's CREATE will make it wide
  if (storedSql.includes(probeValue)) return // the CHECK already lists it

  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name).join(', ')
  const before = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

  // Two pragmas, both load-bearing, both learned by running this against a copy
  // of the live store and watching it throw FOREIGN KEY constraint failed:
  //
  //  legacy_alter_table=ON — without it, modern SQLite REWRITES other tables'
  //    REFERENCES clauses to follow the rename, so email_processing's foreign
  //    key would end up pointing at email_processing_batches_pre_widen and then
  //    at nothing when that is dropped.
  //  foreign_keys=OFF — during the window between the rename and the copy, child
  //    rows reference a table that does not exist under that name.
  //
  // Both must be set OUTSIDE the transaction: SQLite silently ignores a
  // foreign_keys change inside one, which would look like it worked.
  // Baseline FIRST. `foreign_key_check` inspects the WHOLE database, and this
  // store already carries 20 violations in tables this migration never touches
  // (zst_email_processing, zst_case_events — measured 2026-08-10). Failing on the
  // absolute count would abort every rebuild forever because of someone else's
  // orphans; only NEW violations are this migration's business.
  const fkKey = (v: unknown) => JSON.stringify(v)
  const fkBefore = new Set((db.pragma('foreign_key_check') as unknown[]).map(fkKey))
  const priorFk = (db.pragma('foreign_keys', { simple: true }) as number) === 1
  const priorLegacy = (db.pragma('legacy_alter_table', { simple: true }) as number) === 1
  db.pragma('foreign_keys = OFF')
  db.pragma('legacy_alter_table = ON')
  try {
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
    // Prove the references survived, rather than assuming the pragmas did their
    // job. An orphaned child row here would be a silent corruption.
    const introduced = (db.pragma('foreign_key_check') as unknown[]).filter(v => !fkBefore.has(fkKey(v)))
    if (introduced.length) {
      throw new Error(`widenCheckConstraint(${table}): the rebuild introduced ${introduced.length} foreign key violations`)
    }
  } finally {
    if (!priorLegacy) db.pragma('legacy_alter_table = OFF')
    if (priorFk) db.pragma('foreign_keys = ON')
  }
}

function ensureColumns(db: Database.Database, table: string, defs: Record<string, string>): void {
  const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name))
  for (const [name, def] of Object.entries(defs)) {
    if (have.has(name)) continue
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`)
    } catch (err) {
      // W12 (2026-08-25), found while building the two-process ingest test.
      // This is CHECK-THEN-ACT across processes: two boots against the same
      // fresh store both read PRAGMA table_info, both see the column missing,
      // and the loser dies with `duplicate column name: <name>` -- during
      // startup, before any of its own work. Exactly the shape W12 is about,
      // one layer down.
      //
      // The post-condition of this function is "the column exists", and a
      // duplicate-column error is that post-condition already being true. Every
      // OTHER error still throws: a failed ALTER that is not this is a schema
      // problem and must not be swallowed, which is why this catch inspects the
      // message instead of being bare.
      const msg = err instanceof Error ? err.message : String(err)
      if (!/duplicate column name/i.test(msg)) throw err
    }
  }
}

import { ensureLadderSchema } from './autonomy-ladder.js'
import { ensureQuoteSchema } from './quote-campaign.js'
import { ensureEnvelopeSchema } from './delegation-envelope.js'
import { ensureTemporalFactsSchema } from './temporal-facts.js'
import { ensureFeatureRunSchema } from './consumer-manifest.js'
import { ensureRecoveryQueueSchema } from './recovery-queue.js'
import { ensureDisclosureSchema } from './disclosure.js'
import { ensureCanarySchema } from './canary.js'

/**
 * E9 (review 2026-08-13). A ledger of one-time migrations that have already run.
 *
 * initCosSchema runs on EVERY process start, and everything in it has to be
 * idempotent. CREATE TABLE IF NOT EXISTS and ensureColumns are; a bare `UPDATE
 * ... SET scope='MIGRATED_UNVERIFIED'` is not — it is a one-time §17 data
 * migration written in the shape of a recurring one, so a case Istvan had
 * reviewed and confirmed was silently demoted back to "unverified" on the next
 * restart. Rewriting a human's judgement on a timer is the worst class of this
 * bug, because it looks like the system simply never learned.
 *
 * runOnce is the general answer, not a patch for that one statement: any future
 * data migration goes through it, and the marker says when it ran.
 */
function runOnce(db: Database.Database, migrationId: string, body: () => void): boolean {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cos_schema_migrations (
      migration_id TEXT PRIMARY KEY,
      applied_at   INTEGER NOT NULL
    )
  `)
  const done = db.prepare(`SELECT 1 FROM cos_schema_migrations WHERE migration_id = ?`).get(migrationId)
  if (done) return false
  // The marker is written in the SAME transaction as the migration: a crash
  // between the two would otherwise leave a migration that is either applied
  // twice or never marked, and both are how one-time migrations become forever.
  db.transaction(() => {
    body()
    db.prepare(`INSERT INTO cos_schema_migrations (migration_id, applied_at) VALUES (?, ?)`)
      .run(migrationId, Math.floor(Date.now() / 1000))
  })()
  return true
}

export function initCosSchema(db: Database.Database): void {
  // §22 fokozatos autonomia tablai
  ensureLadderSchema(db)
  // §13.1 ajanlatkero-kampany
  ensureQuoteSchema(db)
  // §21 delegation envelope -- csak az allapot (visszavonva/visszakapcsolva);
  // maga a jogosultsag kodkonstans, mert az tulajdonosi dontes es reviewalando.
  ensureEnvelopeSchema(db)
  // v4.4/v1.4.5 shared hardening schema belongs to the root CoS seam.
  ensureTemporalFactsSchema(db)
  ensureFeatureRunSchema(db)
  // W12 / §6.7: the recovery queue and its policy table (see recovery-queue.ts).
  ensureRecoveryQueueSchema(db)
  // W13 / §7.4: the disclosure decision record (see disclosure.ts).
  ensureDisclosureSchema(db)
  // W14 / §8.5: the canary table. Created at boot like its siblings rather than
  // lazily on first use: a table that only appears once a feature enrols cannot
  // be queried by anything that wants to ask "what is under canary right now",
  // and the merge-migration proof would have to special-case it.
  ensureCanarySchema(db)

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
      -- IN-2 / §8: 1 = the thread id was DERIVED (no producer value, so the
      -- message was filed as its own thread), 0 = observed from the source.
      thread_id_derived INTEGER NOT NULL DEFAULT 0,
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
  // IN-2 / §8, and it belongs HERE, after the rebuild, for the reason the block
  // above states about itself: a column added before the A.3 rename lands on the
  // table that gets renamed away, so on a fresh database it silently does not
  // exist. (That is not a hypothetical — it is how this very column was written
  // the first time, and eight tests caught it.) A database that already has the
  // wide key never enters the rebuild, so it needs the ALTER; a fresh one gets
  // the column from EPROC_A3_DDL and this is a no-op.
  ensureColumns(db, 'email_processing', { thread_id_derived: 'INTEGER NOT NULL DEFAULT 0' })
  // Stage 2G (2026-08-17): which triage receipt opened this case. Nullable on
  // purpose — rows written before the gate existed have no receipt, and a
  // back-filled default would invent provenance that never existed.
  ensureColumns(db, 'email_processing', { triage_receipt_id: 'TEXT' })
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
  //
  // E9: ONCE. This statement sat bare in a function that runs on every process
  // start, so a case Istvan reviewed and moved back to PERSONAL_CONFIRMED was
  // demoted again by the next restart — his decision quietly overwritten by a
  // migration that had already finished months ago. It is a one-time backfill of
  // an import, not a rule about the column, and it now says so.
  runOnce(db, '2026-08-13-s17-mark-drive-imports-unverified', () => {
    db.exec(`
      UPDATE personal_cases SET scope = 'MIGRATED_UNVERIFIED'
      WHERE source_system = 'chatgpt-cos-drive' AND scope = 'PERSONAL_CONFIRMED'
    `)
  })

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
  // E19 (review 2026-08-13). Every authorizeSend and every admission check counts
  // `WHERE campaign_id=? [AND outbound_kind=?] AND status NOT IN (...)`, and the
  // only indexes were on status and case_id — so the hottest query on the send
  // path scanned the ledger, INSIDE the transaction that holds the SENDING write.
  // Created here rather than in the CREATE TABLE because campaign_id arrives via
  // ensureColumns one line up. Additive and IF NOT EXISTS: safe to re-run.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_outbound_campaign_status ON outbound_ledger(campaign_id, status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_outbound_campaign_kind ON outbound_ledger(campaign_id, outbound_kind, status)`)
  // The ZST ledger is created LATER in this same function, so the guarded call
  // that used to stand here was a no-op on every fresh database and only ever
  // fired on one that already had the table. It has moved to just after the
  // CREATE (search: ZST_LEDGER_COLUMNS_AFTER_CREATE). Found by F-2: the new
  // columns landed on the personal ledger and every ZST send threw
  // "no such column: recipient" — on a fresh db the ZST ledger had never been
  // through ensureColumns at all.

  // ── §22 kill switch audit ────────────────────────────────────────────
  // cos_autonomy_global holds the CURRENT state; this holds the HISTORY. A stop
  // with no record of who, when and why is a stop nobody can review afterwards,
  // and the review afterwards is most of what a kill switch is for.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cos_kill_switch_events (
      event_id        INTEGER PRIMARY KEY AUTOINCREMENT,
      engaged         INTEGER NOT NULL,
      reason          TEXT,
      actor           TEXT NOT NULL,
      tickets_revoked INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    )
  `)

  // ── §22.2 action authorization tickets ───────────────────────────────
  // The gate issues, the executor consumes. Opaque single-use records rather
  // than a caller-side boolean: see src/cos/action-authorization.ts for why the
  // boolean model is forbidden and why this variant was chosen over an HMAC
  // ticket or an in-process capability object.
  db.exec(`
    CREATE TABLE IF NOT EXISTS action_authorizations (
      authorization_id       TEXT PRIMARY KEY,   -- 32 random bytes; not derivable by a caller
      domain                 TEXT NOT NULL,
      case_id                TEXT,
      case_version           INTEGER,
      goal_version           INTEGER,
      action_id              TEXT NOT NULL,      -- the ledger row this authorises, and ONLY it
      action_type            TEXT NOT NULL,
      intent                 TEXT NOT NULL,
      target_reference       TEXT,
      recipient              TEXT,
      payload_hash           TEXT,
      policy_evaluation_hash TEXT NOT NULL,      -- TOCTOU: everything bound, in one comparison
      approval_id            TEXT,
      delegation_envelope_id TEXT,
      issued_at              INTEGER NOT NULL,
      expires_at             INTEGER NOT NULL,
      single_use             INTEGER NOT NULL DEFAULT 1,
      nonce                  TEXT NOT NULL,
      consumed_at            INTEGER,            -- the audit trail §22.2 asks for
      CHECK (domain IN ('personal','zst'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_action_auth_action ON action_authorizations(action_id)`)
  // E8 (review 2026-08-13). Revocation used to be spelled "set consumed_at", and
  // consumeAuthorization only treats consumed_at as blocking when single_use=1
  // (`consumed_at IS NULL OR single_use = 0`). So a ticket issued with
  // singleUse:false SURVIVED the kill switch's "revoked every outstanding
  // ticket" while the audit row counted it as revoked — the §22.2 revocation
  // contract broken and the audit trail agreeing that it was not. Latent today
  // only because every issuer happens to pass single-use.
  //
  // A dedicated column, checked UNCONDITIONALLY, also fixes the second half of
  // the complaint: consumed and revoked were the same fact in the same field, so
  // "was this ticket spent or killed?" had no answer afterwards.
  // Additive, and ensureColumns is a no-op when the columns are already there,
  // so this is safe to re-run on every start.
  ensureColumns(db, 'action_authorizations', {
    revoked_at:     'INTEGER',
    revoked_reason: 'TEXT',
  })
  db.exec(`CREATE INDEX IF NOT EXISTS idx_action_auth_live ON action_authorizations(revoked_at, consumed_at)`)

  // ── connector_health (Slice 1 reliability; §20 connector matrix) ──────
  // F-10 / B.3: where the marker-persistence proof is recorded. Without a
  // place to put it, the proof could only ever be a log line.
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
  // F-13: where the Scope Gate's verdict and its review reason are recorded.
  // The verdict used to be returned in the HTTP response and dropped, and the
  // review note was squatting in blocked_reason (a §6.1 column meaning something
  // else). Both namespaces, because the gate routes to both.
  ensureColumns(db, 'personal_cases', { scope_review_reason: 'TEXT' })
  // The ZST half is added in initZstSchema, AFTER zst_cases is created. Writing
  // it here behind "if the table exists" is the trap this file already fell into
  // twice tonight (the ZST ledger and the ZST approval envelope): a silent
  // no-op on every fresh database.
  ensureColumns(db, 'connector_health', {
    marker_proof_at:     'INTEGER',
    marker_proof_detail: 'TEXT',
  })

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
      converted_final_price INTEGER,
      -- Deliverability to Hungary for THIS offer: 'YES' | 'NO' | 'UNKNOWN'.
      -- Three-valued on purpose: "we could not establish it" is a different
      -- fact from "it does not ship", and collapsing the two is how a blind
      -- radar looks like a quiet one.
      shippable_hu TEXT NOT NULL DEFAULT 'UNKNOWN'
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_radarobs_item ON radar_observations(radar_id, observed_at)`)
  // Existing dbs (radar tables predate P1.5/P1.6): add the new columns in place.
  ensureColumns(db, 'radar_items', {
    last_notified_offer_id: 'TEXT', last_notified_price: 'INTEGER',
    last_notified_at: 'INTEGER', notification_reason: 'TEXT',
    // The SHAPE of the watch decides its rhythm (see radar-rhythm.ts). Default
    // STANDING because that is what the nine existing items are: lasting
    // wishes with no end date. Not a guess — a DEADLINE row without a date
    // would be a contradiction, and ONE_OFF would close them all on the next
    // tick.
    watch_shape: "TEXT NOT NULL DEFAULT 'STANDING'",
    // When a DEADLINE watch becomes moot. NULL for the other two shapes.
    expires_at: 'INTEGER',
    // How many checks this item has had. ONE_OFF is defined by having had one;
    // without a counter "has it run?" is only answerable by joining the
    // observations, which is the kind of derivation that silently breaks when
    // an observation is pruned.
    checks_count: 'INTEGER NOT NULL DEFAULT 0',
    // A CLOSURE IS NEWS, AND WE HAVE TO KNOW WHETHER IT WAS TOLD.
    //
    // A watch that ends is the one moment the owner most needs a sentence: a
    // ONE_OFF that found nothing, or a deadline that arrived. Both look exactly
    // like a system that stopped working. So the closure is recorded as a fact
    // (when, why) and separately as a receipt (was it reported) -- the same
    // shape as last_notified_*, and for the same reason: without the receipt,
    // "we told him" is an assumption, and the digest either repeats itself for
    // ever or says it once into a void.
    closed_at: 'INTEGER',
    closure_reason: 'TEXT',
    closure_reported_at: 'INTEGER',
  })
  ensureColumns(db, 'radar_observations', {
    offer_id: 'TEXT', original_currency: 'TEXT', original_final_price: 'INTEGER',
    comparison_currency: 'TEXT', fx_rate: 'REAL', fx_rate_source: 'TEXT',
    fx_rate_timestamp: 'INTEGER', converted_final_price: 'INTEGER',
    // Can this offer actually be ordered from Hungary and delivered here?
    // 'YES' | 'NO' | 'UNKNOWN' (see Shippability in radar.ts).
    //
    // THE DEFAULT IS 'UNKNOWN', AND THAT IS THE POINT. Every row written before
    // this column existed was recorded without anyone checking delivery, so
    // 'UNKNOWN' is what those rows actually mean. Defaulting to 'YES' would
    // backdate a verification that never happened onto 87 historical rows — the
    // same move as reading `best_price IS NULL` as "price above target", which
    // is exactly the misreading that hid a week of radar silence.
    shippable_hu: "TEXT NOT NULL DEFAULT 'UNKNOWN'",
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
  // F-13: the Scope Gate writes its verdict onto the case in BOTH namespaces.
  ensureColumns(db, 'zst_cases', { scope: 'TEXT', scope_review_reason: 'TEXT' })
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
  ensureColumns(db, 'zst_email_processing', { triage_receipt_id: 'TEXT' })
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
  // E19: the same campaign+status count runs on the corporate ledger, from the
  // same shared approval and executor cores. One implementation, two table sets
  // — so one missing index is two missing indexes.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zst_outbound_campaign_status ON zst_outbound_ledger(campaign_id, status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zst_outbound_campaign_kind ON zst_outbound_ledger(campaign_id, outbound_kind, status)`)

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
  // ── §10.8 trigger contract ───────────────────────────────────────────
  // HERE, not in initCosSchema. I put it there first and it threw
  // "no such table: case_progression_state" on every fresh database, because
  // that function runs BEFORE this one. Third time tonight in this same file —
  // and the first time it was LOUD instead of silent, because ensureColumns on
  // a missing table errors rather than quietly doing nothing. Loud is better.
  //
  // wait_version completes §10.8's dedup key: a wait re-armed with a new
  // deadline is a NEW state even when nothing else about the case moved, and
  // without it the re-armed wait looks identical to the one already reasoned
  // over.
  ensureColumns(db, 'case_progression_state', {
    wait_version:         'INTEGER NOT NULL DEFAULT 0',
    last_effective_state: 'TEXT',
    last_event_seen:      'INTEGER',
  })

  db.exec(`CREATE INDEX IF NOT EXISTS idx_cps_next_prog ON case_progression_state(domain, next_progression_at) WHERE progression_enabled = 1`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cps_claimed ON case_progression_state(progression_claimed_by, progression_claim_expires_at)`)

  // ── case_progression_runs (plan §14 — audit/replay ledger) ─────────────
  const RUNS_DDL = `
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
      -- §10.8 named its own trigger vocabulary; the old six stay so existing
      -- rows remain legal. SCHEDULED survives as a value but is no longer
      -- WRITTEN by the heartbeat: "the clock came round" is not a reason.
      CHECK (trigger_type IN ('INTAKE','SCHEDULED','MANUAL','WAKE','ESCALATION_RESOLVED','RECOVERY',
        'NEW_RELEVANT_EVENT','WAIT_WAKE_DUE','FOLLOW_UP_DUE','APPROVAL_RESOLVED',
        'DECISION_RESOLVED','USER_INPUT','CAPABILITY_RECOVERED','MANUAL_REVIEW_REQUEST'))
    )
  `
  db.exec(RUNS_DDL)
  // §10.8: existing stores carry the narrow six-value CHECK. Widened in place
  // so a run triggered by NEW_RELEVANT_EVENT can actually be written.
  widenCheckConstraint(db, 'case_progression_runs', 'NEW_RELEVANT_EVENT', RUNS_DDL)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cpruns_case ON case_progression_runs(domain, case_id, started_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cpruns_status ON case_progression_runs(status, started_at)`)

  // Checkpoint C (card 53f1fd06): resolution audit trail (§10). Migrated in
  // place for existing dbs; the column defaults to NULL for pre-C rows.
  // Checkpoint D (card 6b7e7e5e): LLM-interpreted case summary (§10.2).
  // Checkpoint E.4 (card 25e06d97): DoD verification state (§10.4).
  // §19 / §26(28): WAIT_SYSTEM. A case parked on a CAPABILITY, not on a person.
  //
  // Deliberately a column on the existing progression state and not a table of
  // its own: this is one more thing the engine knows about a case it already
  // tracks, and §3 spends its whole length forbidding the parallel subsystem
  // that a `case_capability_waits` table would be the first brick of.
  ensureColumns(db, 'case_progression_state', {
    resolution_audit_json: 'TEXT',
    summary: 'TEXT',
    dod_verification_json: 'TEXT',
    wait_system_json: 'TEXT',
  })
  // Partial: almost every row is NULL here, and the query that reads it asks
  // "which cases are waiting on the machine" — never "which are not".
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cps_wait_system ON case_progression_state(domain, case_id)
           WHERE wait_system_json IS NOT NULL`)
  // Migration: completed_plan_step added post-GATE-2 (card 52250c7f follow-up).
  // ALTER TABLE ADD COLUMN with NOT NULL needs an explicit DEFAULT in SQLite.
  try {
    db.exec("ALTER TABLE case_progression_state ADD COLUMN completed_plan_step INTEGER NOT NULL DEFAULT 0")
  } catch { /* column already exists */ }

  // ── case_evidence_packets (§10.2 Reader output + §13.1 arbitration audit) ──
  //
  // REFUSALS ARE ROWS TOO. refusal_reason is populated when a reading was
  // discarded (empty context, model error, schema or provenance failure), and
  // packet_json is then NULL. A store that only keeps successful readings cannot
  // distinguish "the Reader looked and found little" from "the Reader never
  // produced anything usable", and those need opposite responses.
  //
  // The four §13.1 audit fields are columns rather than JSON so a conflict can
  // be counted with a query instead of a script.
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_evidence_packets (
      packet_id        TEXT PRIMARY KEY,
      domain           TEXT NOT NULL,
      case_id          TEXT NOT NULL,
      /* The progression run this reading is ABOUT. */
      progression_run_id TEXT,
      created_at       INTEGER NOT NULL,
      /* Context Builder receipts — what the Reader was actually given. */
      context_items    INTEGER NOT NULL DEFAULT 0,
      context_excluded INTEGER NOT NULL DEFAULT 0,
      context_unavailable INTEGER NOT NULL DEFAULT 0,
      packet_json      TEXT,
      plan_json        TEXT,
      confidence       REAL,
      /* §13.1 audit, four fields, named as the spec names them. */
      reader_candidate TEXT,
      policy_result    TEXT,
      final_decision   TEXT,
      conflict_reason  TEXT,
      safe_fallback_decision TEXT,
      decided_by       TEXT,
      refusal_reason   TEXT,
      model            TEXT,
      CHECK (domain IN ('personal','zst'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cep_case ON case_evidence_packets(domain, case_id, created_at)`)

  // ── cos_owner_questions (§10.4 Writer, first slice) ──────────────────────
  //
  // What was ASKED, so the same ask does not go out twice. Keyed by a hash of
  // the ASK — not of the packet — because a new fact that does not change what
  // Istvan has to answer must not re-ask him. Same doctrine as the pipeline's
  // owner-answer matching: identity is the question's content, not the run.
  //
  // `answered_at` is the release: once an answer is recorded, the same question
  // may legitimately be asked again if the situation returns.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cos_owner_questions (
      case_id        TEXT NOT NULL,
      domain         TEXT NOT NULL,
      question_hash  TEXT NOT NULL,
      question_text  TEXT NOT NULL,
      asked_at       INTEGER NOT NULL,
      answered_at    INTEGER,
      answer_text    TEXT,
      -- Set when a BETTER-WORDED question about the same case replaces this one.
      -- Deliberately NOT answered_at: nobody answered it, and writing an answer
      -- timestamp to close a row would make "answered" mean two different
      -- things — the same lie SOURCE_COMMITTED told about labelling.
      superseded_at  INTEGER,
      PRIMARY KEY (case_id, question_hash)
    )
  `)
  ensureColumns(db, 'cos_owner_questions', {
    superseded_at: 'INTEGER',
    // Istvan's decision (2026-08-11): the CoS gets its OWN Telegram bot and
    // chat, and his answer there must reach the case. That only works if the
    // question records WHERE it went out -- otherwise a reply arriving on one
    // channel cannot be matched to a question asked on another, and the whole
    // separation would cost him the answer path it exists to protect.
    //
    // Nullable on purpose: every question asked before the split has no channel,
    // and a NULL here means "wherever the old single channel was". Backfilling a
    // guess would invent provenance.
    channel: 'TEXT',
    channel_target: 'TEXT',
    // WHICH PROGRESSION RUN the question came out of (review #6, H-2).
    //
    // The answer path writes a case event, and its consumer
    // (consumeOwnerAnswer) refuses any answer without a source_reference naming
    // the run -- it cannot verify question identity otherwise. The answer event
    // was written without one, so every Telegram answer was DROPPED by the
    // engine: the question closed, the case did not move, the next Reader sweep
    // produced the same packet and asked the same question again. Measured: two
    // identical messages, after answering.
    //
    // Nullable for the same reason as `channel`: rows asked before this column
    // existed have no run to name, and inventing one would fabricate provenance.
    progression_run_id: 'TEXT',
  })
  db.exec(`CREATE INDEX IF NOT EXISTS idx_coq_open ON cos_owner_questions(answered_at, asked_at)`)

  // ── cos_channel_outbox ───────────────────────────────────────────────────
  //
  // Messages waiting to LEAVE on a channel. The owner-question path keeps its
  // own table (the question IS the state there); this is for producers that have
  // something to say and no state of their own to hang it on — the radar first.
  //
  // `dedupe_key` is the identity of the THING announced, not of the attempt, and
  // it is UNIQUE: a retry, a second radar tick or a restarted process must not
  // send the same hit twice. `sent_at IS NULL` is the whole queue semantics — a
  // failed send leaves the row alone, so the next drain retries rather than
  // losing it. A price falls below target once.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cos_channel_outbox (
      outbox_id      INTEGER PRIMARY KEY AUTOINCREMENT,
      channel        TEXT NOT NULL,
      kind           TEXT NOT NULL,
      dedupe_key     TEXT NOT NULL UNIQUE,
      text           TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      sent_at        INTEGER,
      channel_target TEXT,
      attempts       INTEGER NOT NULL DEFAULT 0,
      last_error     TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_outbox_pending
             ON cos_channel_outbox(channel, sent_at, created_at)`)

  // ── cos_channel_held ─────────────────────────────────────────────────────
  //
  // Owner messages that arrived on a channel and could NOT be attributed to a
  // case. Written 2026-08-11, an hour after the rule that produces them.
  //
  // The rule (matchAnswerTarget) refuses to guess when several questions are
  // open — correct, because a wrong attribution puts the owner's words on a case
  // he never mentioned. But the first live firing showed the hole in it: the
  // poll counted `ambiguous: 1`, advanced the Telegram offset, and the SENTENCE
  // WAS GONE. Telegram does not re-serve an update once a higher offset is
  // requested. "Held, not lost" was only true of the counter, not of the words.
  //
  // So the text is stored here before the cursor moves. `resolved_at` is set
  // when it has been dealt with -- attached to a case, or answered directly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cos_channel_held (
      held_id      INTEGER PRIMARY KEY AUTOINCREMENT,
      channel      TEXT NOT NULL,
      chat_id      TEXT,
      message_id   INTEGER,
      text         TEXT NOT NULL,
      reason       TEXT NOT NULL,
      received_at  INTEGER NOT NULL,
      resolved_at  INTEGER,
      resolution   TEXT,
      UNIQUE (channel, message_id)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_held_open ON cos_channel_held(resolved_at, received_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cep_conflict ON case_evidence_packets(conflict_reason, created_at)`)

  // ── Checkpoint E.5 (card 59c06cbc): structured escalation records ──────
  // SHADOW-ONLY: escalations are LOGGED, never delivered. No Telegram, email,
  // or bus side effect. The payload_json carries descriptive strings only —
  // prompt-injected thread content cannot fabricate an escalation that carries
  // an action (same construction discipline as Checkpoint D's validateInterpretation).
  // Controlled Action Executor is absent/inert at this stage.
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_escalations (
      escalation_id       TEXT PRIMARY KEY,
      domain              TEXT NOT NULL,
      case_id             TEXT NOT NULL,
      progression_run_id  TEXT,
      trigger_reason      TEXT NOT NULL,
      escalation_level    TEXT NOT NULL,
      summary             TEXT NOT NULL,
      source_context      TEXT,
      decision_context    TEXT,
      payload_json        TEXT,
      resolution_status   TEXT NOT NULL DEFAULT 'OPEN',
      resolved_by         TEXT,
      resolution_note     TEXT,
      created_at          INTEGER NOT NULL,
      resolved_at         INTEGER,
      CHECK (domain IN ('personal','zst')),
      CHECK (escalation_level IN ('L1_INFO_GAP','L2_BLOCKED','L3_OVERDUE','L4_RECOVERY_FAILED','L5_POLICY_GATE')),
      CHECK (resolution_status IN ('OPEN','ACKNOWLEDGED','RESOLVED','DISMISSED'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cesc_case ON case_escalations(domain, case_id, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cesc_status ON case_escalations(domain, resolution_status, created_at)`)

  // LAST in this function: the projection seam needs both case tables AND
  // case_progression_state to exist, and this is the first point where all
  // three are guaranteed.
  initCaseProjectionSchema(db)
}

/** P1 §10.1/§10.2 — the projection seam between the canonical state machine and
 *  the case board.
 *
 *  Measured 2026-08-26, before any of this existed: Invariant A (every active
 *  case carries a next action, or a wait condition plus a review time) held
 *  166 of 167 in `case_progression_state` and failed 90 of 147 on the case
 *  board. Not because the board was WRONG about a case — because it was silent
 *  about it, and nothing reconciled the two views or noticed the gap.
 *
 *  WHY NEW COLUMNS INSTEAD OF FILLING THE OBVIOUS ONES
 *
 *  The audit that opened this packet said `next_wake_at` (0/122) was the board's
 *  unwritten twin of `next_progression_at` (166/167), and that the fix was to
 *  fill it. Three separate live consumers say otherwise, and each one would have
 *  broken quietly:
 *
 *    `next_wake_at` is an APPOINTMENT, not a poll time. `alertWokenCases` posts
 *    every due case to the owner and then CLEARS the column, by design. Filling
 *    it from `next_progression_at` (a five-minute engine cadence, usually in the
 *    past) would have alerted ~120 cases at once and then re-armed them on the
 *    next cycle: a permanent alert loop, built by a reconciliation whose whole
 *    purpose was to stop drift.
 *
 *    `waiting_on` is where `followup-autodraft` finds the RECIPIENT — it regexes
 *    an address out of it. Overwriting it with the engine's free-text wait
 *    reason would silently disarm follow-up drafting, or worse, redirect one.
 *
 *    `next_action` is in `case-link`'s TRUSTED_CASE_FIELDS, and it is also
 *    exactly what `isUsableRecommendation` REFUSES to show the owner: the
 *    engine's next-best-action text is a closed set of internal English plan
 *    labels ("Execute first recovery action"), banned from owner-facing surfaces
 *    after that string shipped to Istvan once already.
 *
 *  So the projection gets its own, engine-owned columns. One writer each, no
 *  meaning borrowed from a column that already had one. That is also the whole
 *  point of the packet: two writers on one fact is how the two representations
 *  drifted apart in the first place.
 *
 *  `proj_next_action_kind` rather than the text carries Invariant A. The
 *  invariant asks whether a next action EXISTS, which is a fact; the English
 *  label is a rendering, and a banned rendering does not make the fact absent.
 */
export function initCaseProjectionSchema(db: Database.Database): void {
  const projectionColumns = {
    /** Owner-safe action text, or NULL when the engine's label is internal
     *  machine vocabulary. NULL here is not a missing action — see the kind. */
    proj_next_action:      'TEXT',
    /** VERIFY | GATHER_INFO | EXECUTE | AWAIT_EXTERNAL | AWAIT_DECISION |
     *  RECOVER | COMMUNICATE — the machine fact Invariant A reads. */
    proj_next_action_kind: 'TEXT',
    proj_next_action_step: 'INTEGER',
    /** The engine's wait reason. Deliberately NOT `waiting_on`. */
    proj_wait_condition:   'TEXT',
    /** The engine's `next_progression_at`. Deliberately NOT `next_wake_at`. */
    proj_next_review_at:   'INTEGER',
    proj_blocked_reason:   'TEXT',
    /** Fence: the `canonical_revision` this row reflects. A projection carrying
     *  an older revision is refused rather than allowed to overwrite a newer
     *  one. */
    projected_revision:    'INTEGER',
    /** Hash of the values this projection last wrote. A mismatch means somebody
     *  other than the projection changed them — a conflict, not a drift. */
    projection_fingerprint: 'TEXT',
    projection_conflict_reason: 'TEXT',
    /** When the two views were last confirmed to agree. Its ABSENCE is the
     *  finding: a case nothing has reconciled cannot report that it drifted. */
    last_reconciled_at:    'INTEGER',
  }
  ensureColumns(db, 'personal_cases', projectionColumns)
  ensureColumns(db, 'zst_cases', projectionColumns)

  // Partial indexes: every query here asks "which rows are behind / in
  // conflict", never "which are fine".
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pcases_unreconciled ON personal_cases(last_reconciled_at)
           WHERE last_reconciled_at IS NULL`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zcases_unreconciled ON zst_cases(last_reconciled_at)
           WHERE last_reconciled_at IS NULL`)

  // ── canonical_revision, and why it is a TRIGGER ──────────────────────────
  //
  // The fence needs a monotonic version of the canonical row. Bumping it from
  // application code would mean editing every canonical writer — there are
  // eleven of them across seven modules today, and the twelfth one written next
  // month would silently not bump, which is the exact failure mode this column
  // exists to catch. A trigger is the table's choke point: it covers writers
  // that do not exist yet.
  //
  // It watches ONLY the fields the projection reads, so the revision means
  // "the projection's input changed" and not merely "the row was touched".
  // A goal rewrite that changes nothing projectable must not make every board
  // row look stale.
  //
  // `IS NOT` rather than `!=`: half these columns are NULL most of the time and
  // `NULL != NULL` is NULL, so `!=` would miss every transition into and out of
  // NULL. Verified against better-sqlite3 before writing it: a no-op UPDATE
  // does not bump, a NULL->value and a value->NULL both do, and
  // `recursive_triggers` is OFF so the trigger's own UPDATE does not re-fire.
  ensureColumns(db, 'case_progression_state', {
    canonical_revision: 'INTEGER NOT NULL DEFAULT 0',
  })
  db.exec(`DROP TRIGGER IF EXISTS trg_cps_canonical_revision`)
  db.exec(`
    CREATE TRIGGER trg_cps_canonical_revision
    AFTER UPDATE ON case_progression_state
    FOR EACH ROW WHEN
         (NEW.next_best_action_json IS NOT OLD.next_best_action_json)
      OR (NEW.next_progression_at   IS NOT OLD.next_progression_at)
      OR (NEW.waiting_on            IS NOT OLD.waiting_on)
      OR (NEW.blocked_reason        IS NOT OLD.blocked_reason)
      OR (NEW.wait_system_json      IS NOT OLD.wait_system_json)
    BEGIN
      UPDATE case_progression_state SET canonical_revision = OLD.canonical_revision + 1
       WHERE domain = NEW.domain AND case_id = NEW.case_id;
    END
  `)
  // An INSERT that already carries projectable content starts at revision 1, so
  // a freshly enrolled case is never mistaken for "projected and up to date"
  // by a board row whose projected_revision defaults to NULL.
  db.exec(`DROP TRIGGER IF EXISTS trg_cps_canonical_revision_insert`)
  db.exec(`
    CREATE TRIGGER trg_cps_canonical_revision_insert
    AFTER INSERT ON case_progression_state
    FOR EACH ROW WHEN
         NEW.next_best_action_json IS NOT NULL
      OR NEW.next_progression_at   IS NOT NULL
      OR NEW.waiting_on            IS NOT NULL
      OR NEW.blocked_reason        IS NOT NULL
      OR NEW.wait_system_json      IS NOT NULL
    BEGIN
      UPDATE case_progression_state SET canonical_revision = 1
       WHERE domain = NEW.domain AND case_id = NEW.case_id;
    END
  `)
}
