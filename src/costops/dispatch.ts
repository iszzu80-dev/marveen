// CostOps Phase 2 / P2-A -- Dispatch & Outcome Attribution (MEASUREMENT ONLY).
//
// Gives every Node-side work-package dispatch a stable, opaque `dispatch_id`
// that links: dispatch -> routing_event -> token_usage -> outcome -> cost, so
// `cost_per_accepted_task` is computable per agent/profile/model. This is
// additive to CostOps and changes NO dispatch behaviour: NO runtime routing,
// NO fallback, NO model switching, NO LLM. Deterministic SQL + rules only.
//
// Seam: the DDL below is invoked from initCostOpsSchema(db) (costops/schema.ts,
// the LOCAL-FORK CostOps seam), NOT from db.ts and NOT as a second parallel
// seam -- so these tables travel with the rest of CostOps across upstream
// merges. Marginal cost REUSES costops/pricing.ts (loadPricingConfig +
// estimateModelCost); there is no second pricing implementation here.
//
// DATA SENSITIVITY (hard): no column, id, or log line in this module may carry
// prompt text, PII, secrets, or credentials. `dispatch_id` is an opaque uuid.
// The concrete billing-map lives only under gitignored store/; the committed
// illustrative copy is config-examples/billing-map.example.json. The attribution
// bounds config follows the same pattern (store/dispatch-attribution.json,
// example in config-examples/dispatch-attribution.example.json).

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'
import { loadPricingConfig, estimateModelCost, type PricingConfig } from './pricing.js'
import { EXECUTION_ROLES, type ExecutionRole } from '../execution-role.js'

// ---- domain types ----------------------------------------------------------

export type DispatchSource =
  | 'kanban' | 'message' | 'scheduler' | 'worker' | 'reinject' | 'manual'

export type BillingMode =
  | 'subscription_included' | 'subscription_credit' | 'api_payg' | 'local_compute' | 'unknown'

export type OutcomeKind =
  | 'accepted' | 'retry' | 'failed' | 'cancelled' | 'unknown'

/**
 * APG 1.9 §11.2 execution-principal ROLE, carried on the dispatch row.
 *
 * §11.2 requires an execution identity whose `role` is one of producer /
 * verifier / executor / owner, and §9.3's dual-sided acceptance plus §26's
 * first invariant ("an agent may not accept its own final output") are
 * un-expressible without it: before this column every dispatch looked the same,
 * so nothing in the store could say which agent AUTHORED a work package and
 * which one merely ran something on its behalf.
 *
 * This is the Marveen half only. It is not a cryptographic identity and does
 * not pretend to be: §11.1 is explicit that a shared bearer token proves
 * nothing. What it IS: the role is decided SERVER-side at the origin, from the
 * origin's own knowledge (which agent the card was dispatched to, which agent
 * the router is delivering to), never from a self-declared request field -- so
 * it cannot be spoofed by the agent it describes, which is exactly the property
 * §11.1 says `from_agent` lacks.
 *
 * 'owner' is declared and unwritten today: no owner-decision dispatch exists
 * yet. That absence is deliberate and visible -- ui-projection.ts's accepter
 * field resolves to null BECAUSE no such dispatch row exists, not because the
 * value is hardcoded. 'verifier' stopped being decorative in WP4: the fresh
 * verifier (§12.3, web/fresh-verifier.ts) mints a verifier-role dispatch for
 * an agent that is provably not the producer.
 *
 * WP4 MOVED THE FOUR WORDS one level down, to src/execution-role.ts, and
 * re-exports them here under their original names. The reason is §12.1-e: the
 * context packet must carry the same `execution_role`, and context-packet.ts is
 * dependency-free by contract, so it cannot import this module. A second
 * spelling of a closed vocabulary is the failure that file exists to prevent;
 * nothing about this module's API changed.
 */
export type DispatchRole = ExecutionRole

export const DISPATCH_ROLES: readonly DispatchRole[] = EXECUTION_ROLES

// ---- schema (idempotent boot DDL; invoked via the CostOps seam) ------------

/**
 * Create the P2-A measurement tables + the token_usage link column. Idempotent
 * (CREATE TABLE IF NOT EXISTS + try/catch ALTER), forward-only, nullable. All
 * new columns are nullable and the tables are independent, so disabling the
 * feature leaves them inert with zero data loss (rollback constraint). Called
 * from initCostOpsSchema(db) AFTER token_usage exists (it ALTERs that table).
 */
export function initDispatchSchema(db: Database.Database): void {
  // dispatches: one row per work-package dispatch. Only dispatch_id/created_at/
  // agent are NOT NULL (per spec); `source` is always known at the origin so it
  // is populated for every row but kept nullable to match the spec's contract.
  // NO prompt text / PII / secret column exists here by construction.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatches (
      dispatch_id      TEXT PRIMARY KEY,
      created_at       INTEGER NOT NULL,
      source           TEXT,
      card_id          TEXT,
      agent            TEXT NOT NULL,
      project          TEXT,
      session_id       TEXT,
      task_type        TEXT,
      model_profile    TEXT,
      configured_model TEXT,
      runtime_model    TEXT,
      provider         TEXT,
      auth_profile     TEXT,
      billing_mode     TEXT
    )
  `)
  // APG 1.9 §11.2 execution-principal role. Additive, nullable, forward-only --
  // the same idempotent-ALTER convention every other CostOps column uses (see
  // costops/schema.ts). A pre-migration row keeps role NULL, which honestly
  // means "this dispatch predates role attribution", never a guessed 'producer'.
  try { db.exec('ALTER TABLE dispatches ADD COLUMN role TEXT') } catch { /* already exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dispatches_agent ON dispatches(agent, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dispatches_card_role ON dispatches(card_id, role, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dispatches_session ON dispatches(agent, session_id, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dispatches_card ON dispatches(card_id)`)

  // routing_events: single structure, CostOps-linked. In Phase 2 essentially
  // every row is reason_code='default_route', fallback_used=0 (no routing yet).
  db.exec(`
    CREATE TABLE IF NOT EXISTS routing_events (
      routing_event_id  TEXT PRIMARY KEY,
      dispatch_id       TEXT,
      card_id           TEXT,
      agent             TEXT,
      configured_profile TEXT,
      runtime_profile   TEXT,
      configured_model  TEXT,
      runtime_model     TEXT,
      provider          TEXT,
      auth_profile      TEXT,
      billing_mode      TEXT,
      capacity_state    TEXT,
      reason_code       TEXT,
      fallback_used     INTEGER NOT NULL DEFAULT 0,
      timestamp         INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_routing_events_dispatch ON routing_events(dispatch_id)`)

  // dispatch_outcomes: acceptance/retry/etc. Absence of a row means 'unknown'.
  // Old dispatches are NEVER backfilled with a guessed outcome.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_outcomes (
      outcome_id        TEXT PRIMARY KEY,
      dispatch_id       TEXT,
      outcome           TEXT,
      retry_of          TEXT,
      correction_of     TEXT,
      fallback_event_id TEXT,
      evidence          TEXT,
      created_at        INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dispatch_outcomes_dispatch ON dispatch_outcomes(dispatch_id)`)

  // token_usage <-> dispatch link. Nullable, forward-only, never backfilled
  // with a guessed value -- disabling the feature leaves this column inert.
  try { db.exec('ALTER TABLE token_usage ADD COLUMN dispatch_id TEXT') } catch { /* already exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_dispatch ON token_usage(dispatch_id)`)
}

// ---- write path: create a dispatch (+ its default routing_event) -----------

export interface DispatchInput {
  source: DispatchSource
  agent: string
  /**
   * §11.2 execution role. Optional so an un-migrated / un-role-aware caller
   * stores NULL rather than a fabricated default -- "we do not know what this
   * agent was acting as" has exactly one spelling, the same discipline
   * dispatch-identity.ts applies to the model columns.
   */
  role?: DispatchRole | null
  cardId?: string | null
  project?: string | null
  sessionId?: string | null
  taskType?: string | null
  modelProfile?: string | null
  configuredModel?: string | null
  runtimeModel?: string | null
  provider?: string | null
  authProfile?: string | null
  billingMode?: BillingMode | null
}

/**
 * Insert one dispatch row (opaque uuid id) + its default routing_event. Returns
 * the dispatch_id. `now` is epoch MILLISECONDS (Date.now()); it is stored as
 * epoch SECONDS to line up with token_usage.timestamp (seconds) for the window
 * correlation. Runtime code may use randomUUID/Date.now (allowed in src/).
 */
export function createDispatch(db: Database.Database, input: DispatchInput, now: number = Date.now()): string {
  const id = randomUUID()
  const createdAt = Math.floor(now / 1000)
  db.prepare(`
    INSERT INTO dispatches
      (dispatch_id, created_at, source, role, card_id, agent, project, session_id, task_type,
       model_profile, configured_model, runtime_model, provider, auth_profile, billing_mode)
    VALUES
      (@dispatch_id, @created_at, @source, @role, @card_id, @agent, @project, @session_id, @task_type,
       @model_profile, @configured_model, @runtime_model, @provider, @auth_profile, @billing_mode)
  `).run({
    dispatch_id: id,
    created_at: createdAt,
    source: input.source,
    // An unrecognised role is stored as NULL, not passed through: the column is
    // an enum in intent, and a typo'd value would read downstream as a role
    // that does not exist rather than as the absence of one.
    role: input.role && DISPATCH_ROLES.includes(input.role) ? input.role : null,
    card_id: input.cardId ?? null,
    agent: input.agent,
    project: input.project ?? null,
    session_id: input.sessionId ?? null,
    task_type: input.taskType ?? null,
    model_profile: input.modelProfile ?? null,
    configured_model: input.configuredModel ?? null,
    runtime_model: input.runtimeModel ?? null,
    provider: input.provider ?? null,
    auth_profile: input.authProfile ?? null,
    billing_mode: input.billingMode ?? null,
  })
  // Default routing_event: Phase 2 has NO routing, so every event is the
  // static default route with no fallback. This rides CostOps (no parallel DB).
  insertRoutingEvent(db, {
    dispatchId: id,
    cardId: input.cardId ?? null,
    agent: input.agent,
    configuredProfile: input.modelProfile ?? null,
    runtimeProfile: input.modelProfile ?? null,
    configuredModel: input.configuredModel ?? null,
    runtimeModel: input.runtimeModel ?? null,
    provider: input.provider ?? null,
    authProfile: input.authProfile ?? null,
    billingMode: input.billingMode ?? null,
    capacityState: 'normal',
    reasonCode: 'default_route',
    fallbackUsed: 0,
  }, createdAt)
  return id
}

/**
 * Best-effort dispatch creation for the hot dispatch paths: a measurement
 * failure must NEVER break the actual send (additive constraint). Returns the
 * dispatch_id, or null if the insert threw (logged, not raised).
 */
export function createDispatchSafe(db: Database.Database, input: DispatchInput, now: number = Date.now()): string | null {
  try {
    return createDispatch(db, input, now)
  } catch (err) {
    logger.warn({ err, source: input.source, agent: input.agent }, 'createDispatch failed; dispatch un-instrumented (send unaffected)')
    return null
  }
}

export interface RoutingEventInput {
  dispatchId: string | null
  cardId?: string | null
  agent?: string | null
  configuredProfile?: string | null
  runtimeProfile?: string | null
  configuredModel?: string | null
  runtimeModel?: string | null
  provider?: string | null
  authProfile?: string | null
  billingMode?: BillingMode | null
  capacityState?: string | null
  reasonCode?: string | null
  fallbackUsed?: 0 | 1
}

/** Insert one routing_event row (opaque uuid id). `atSec` is epoch seconds. */
export function insertRoutingEvent(db: Database.Database, ev: RoutingEventInput, atSec: number = Math.floor(Date.now() / 1000)): string {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO routing_events
      (routing_event_id, dispatch_id, card_id, agent, configured_profile, runtime_profile,
       configured_model, runtime_model, provider, auth_profile, billing_mode, capacity_state,
       reason_code, fallback_used, timestamp)
    VALUES
      (@routing_event_id, @dispatch_id, @card_id, @agent, @configured_profile, @runtime_profile,
       @configured_model, @runtime_model, @provider, @auth_profile, @billing_mode, @capacity_state,
       @reason_code, @fallback_used, @timestamp)
  `).run({
    routing_event_id: id,
    dispatch_id: ev.dispatchId,
    card_id: ev.cardId ?? null,
    agent: ev.agent ?? null,
    configured_profile: ev.configuredProfile ?? null,
    runtime_profile: ev.runtimeProfile ?? null,
    configured_model: ev.configuredModel ?? null,
    runtime_model: ev.runtimeModel ?? null,
    provider: ev.provider ?? null,
    auth_profile: ev.authProfile ?? null,
    billing_mode: ev.billingMode ?? null,
    capacity_state: ev.capacityState ?? null,
    reason_code: ev.reasonCode ?? 'default_route',
    fallback_used: ev.fallbackUsed ?? 0,
    timestamp: atSec,
  })
  return id
}

// ---- outcomes --------------------------------------------------------------

export interface OutcomeInput {
  dispatchId: string
  outcome: OutcomeKind
  retryOf?: string | null
  correctionOf?: string | null
  fallbackEventId?: string | null
  evidence?: string | null
}

/** Record a dispatch outcome (opaque uuid id). `now` is epoch milliseconds. */
export function recordOutcome(db: Database.Database, input: OutcomeInput, now: number = Date.now()): string {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO dispatch_outcomes
      (outcome_id, dispatch_id, outcome, retry_of, correction_of, fallback_event_id, evidence, created_at)
    VALUES
      (@outcome_id, @dispatch_id, @outcome, @retry_of, @correction_of, @fallback_event_id, @evidence, @created_at)
  `).run({
    outcome_id: id,
    dispatch_id: input.dispatchId,
    outcome: input.outcome,
    retry_of: input.retryOf ?? null,
    correction_of: input.correctionOf ?? null,
    fallback_event_id: input.fallbackEventId ?? null,
    evidence: input.evidence ?? null,
    created_at: Math.floor(now / 1000),
  })
  return id
}

/**
 * Best-effort outcome write for the hot delivery/worker paths, mirroring
 * createDispatchSafe: recording that a dispatch failed is MEASUREMENT, so it
 * must never throw into the path that just handled the real failure. Returns
 * the outcome_id, or null if the insert threw (logged, not raised).
 */
export function recordOutcomeSafe(
  db: Database.Database,
  input: OutcomeInput,
  now: number = Date.now(),
): string | null {
  try {
    return recordOutcome(db, input, now)
  } catch (err) {
    logger.warn(
      { err, outcome: input.outcome, dispatchId: input.dispatchId },
      'recordOutcome failed; dispatch outcome un-recorded (delivery handling unaffected)',
    )
    return null
  }
}

/**
 * Wire `accepted` from kanban status->done: mark every EXISTING dispatch for
 * this card accepted (evidence 'kanban:done'). It only acts on dispatches that
 * already exist -- it NEVER creates a dispatch or backfills an outcome for a
 * card that was never instrumented (old rows stay unknown). Idempotent: a card
 * that already has an accepted outcome is skipped. Returns rows written.
 */
export function recordAcceptedOutcomeForCard(db: Database.Database, cardId: string, now: number = Date.now()): number {
  const rows = db.prepare('SELECT dispatch_id FROM dispatches WHERE card_id = ?').all(cardId) as { dispatch_id: string }[]
  let written = 0
  for (const r of rows) {
    const already = db.prepare("SELECT 1 FROM dispatch_outcomes WHERE dispatch_id = ? AND outcome = 'accepted' LIMIT 1").get(r.dispatch_id)
    if (already) continue
    recordOutcome(db, { dispatchId: r.dispatch_id, outcome: 'accepted', evidence: 'kanban:done' }, now)
    written++
  }
  return written
}

// ---- §11.2 role reads ------------------------------------------------------

/**
 * The agents that acted in each §11.2 role on one kanban card, newest dispatch
 * wins. A role with no dispatch row resolves to null -- which is the honest
 * answer and the reason ui-projection.ts can stop hardcoding one: today only
 * 'producer' is ever written (the kanban origin), so verifier/owner come back
 * null BECAUSE no verification or owner-decision dispatch exists, not because
 * the projection decided to print null.
 *
 * Read-only and defensive: called from a projection path and from the
 * scope-override authority check, neither of which may throw on a DB that
 * predates the `role` column.
 */
export interface CardRoleAgents {
  producer: string | null
  verifier: string | null
  owner: string | null
}

export function resolveCardRoleAgents(db: Database.Database, cardId: string): CardRoleAgents {
  const out: CardRoleAgents = { producer: null, verifier: null, owner: null }
  const rows = db.prepare(
    `SELECT role, agent FROM dispatches
     WHERE card_id = ? AND role IS NOT NULL
     ORDER BY created_at DESC, rowid DESC`
  ).all(cardId) as { role: string; agent: string }[]
  for (const r of rows) {
    if (r.role === 'producer' && out.producer === null) out.producer = r.agent
    if (r.role === 'verifier' && out.verifier === null) out.verifier = r.agent
    if (r.role === 'owner' && out.owner === null) out.owner = r.agent
  }
  return out
}

/**
 * EVERY agent that has ever produced against this card (not just the newest).
 * §24.0.5's prohibition is on the producer/worker/chain downgrading its own
 * scope, and a card handed between two agents has two producers -- taking only
 * the latest would let the earlier one downgrade the card it authored.
 */
export function listCardProducerAgents(db: Database.Database, cardId: string): string[] {
  const rows = db.prepare(
    `SELECT DISTINCT agent FROM dispatches WHERE card_id = ? AND role = 'producer'`
  ).all(cardId) as { agent: string }[]
  return rows.map((r) => r.agent)
}

/** The project-scope counterpart. `dispatches.project` is stamped by the kanban origin. */
export function listProjectProducerAgents(db: Database.Database, project: string): string[] {
  const rows = db.prepare(
    `SELECT DISTINCT agent FROM dispatches WHERE project = ? AND role = 'producer'`
  ).all(project) as { agent: string }[]
  return rows.map((r) => r.agent)
}

/** Resolve the current outcome for a dispatch. No outcome row => 'unknown'. */
export function resolveOutcome(db: Database.Database, dispatchId: string): OutcomeKind {
  const r = db.prepare(
    'SELECT outcome FROM dispatch_outcomes WHERE dispatch_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
  ).get(dispatchId) as { outcome: OutcomeKind } | undefined
  return r?.outcome ?? 'unknown'
}

// ---- token_usage <-> dispatch window correlation ---------------------------

/**
 * Outcomes that CLOSE a dispatch's attribution window. 'retry' and 'unknown'
 * are deliberately NOT terminal: a retried dispatch is still consuming tokens
 * for the same work package, and 'unknown' is merely the absence of a verdict.
 */
export const TERMINAL_OUTCOMES: readonly OutcomeKind[] = ['accepted', 'failed', 'cancelled']

/**
 * Default hard cap on how long after its created_at a dispatch may still absorb
 * token_usage rows. 6 hours: comfortably longer than any single work package
 * this fleet dispatches (the longest observed multi-hour build sessions), yet
 * short enough that a pane left idle overnight -- or a human typing in it the
 * next morning -- can never be billed to the last dispatch of that session.
 * There is NO unbounded mode: a missing/invalid config falls back to this.
 */
export const DEFAULT_MAX_ATTRIBUTION_WINDOW_SECONDS = 6 * 60 * 60 // 21600

/** Deployment-local attribution config (gitignored store/; example is tracked). */
export const DISPATCH_ATTRIBUTION_CONFIG_PATH = join(PROJECT_ROOT, 'store', 'dispatch-attribution.json')

export interface DispatchAttributionConfig {
  /** Hard cap in seconds. Always a finite, positive number -- never unbounded. */
  maxWindowSeconds: number
}

/**
 * Load the deployment-local attribution config. Missing file, unreadable file,
 * invalid JSON, or a non-finite / non-positive max_window_seconds all resolve to
 * DEFAULT_MAX_ATTRIBUTION_WINDOW_SECONDS -- never to "unbounded".
 */
export function loadDispatchAttributionConfig(
  path: string = DISPATCH_ATTRIBUTION_CONFIG_PATH,
): DispatchAttributionConfig {
  if (!existsSync(path)) return { maxWindowSeconds: DEFAULT_MAX_ATTRIBUTION_WINDOW_SECONDS }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    return { maxWindowSeconds: sanitizeMaxWindowSeconds(raw?.max_window_seconds) }
  } catch (err) {
    logger.warn({ err, path }, 'loadDispatchAttributionConfig: invalid dispatch-attribution.json; using the default cap')
    return { maxWindowSeconds: DEFAULT_MAX_ATTRIBUTION_WINDOW_SECONDS }
  }
}

/** A cap is only honoured when it is a finite positive number; else the default. */
function sanitizeMaxWindowSeconds(v: unknown): number {
  return (typeof v === 'number' && Number.isFinite(v) && v > 0)
    ? Math.floor(v)
    : DEFAULT_MAX_ATTRIBUTION_WINDOW_SECONDS
}

/**
 * Attribute token_usage rows to dispatches by dispatch-time window within
 * (agent, session_id). Deterministic, rule-based, no LLM. Refines (does not
 * replace) the fuzzy kanban correlation. Forward-only: only fills rows where
 * dispatch_id is currently NULL, and only for dispatches that carry a
 * session_id (a dispatch with no session_id cannot be placed into a session's
 * timeline, so it is skipped rather than guessed).
 *
 * A row is attributed to a dispatch when its timestamp is inside ALL of:
 *   1. >= dispatch.created_at                        (forward-only from dispatch)
 *   2. <  next dispatch of the same (agent, session) (unchanged session timeline)
 *   3. <= created_at + maxWindowSeconds              (BOUND: hard cap)
 *   4. <= earliest TERMINAL outcome's created_at     (BOUND: outcome closes it)
 * Bounds 3 and 4 exist because rule 2 alone leaves the LAST dispatch of a
 * session open-ended, so it would absorb every later row in that session
 * forever -- a human typing in the pane hours later, or unrelated
 * self-initiated work -- systematically inflating cost_per_accepted_task.
 * 'retry'/'unknown' outcomes do NOT close the window (see TERMINAL_OUTCOMES).
 *
 * Rows outside every window simply stay unattributed (dispatch_id NULL); that
 * is the honest result and no bucket is invented for them.
 *
 * Idempotent: windows are non-overlapping within a session and only ever
 * narrowed, and already-linked rows are never touched, so re-running changes
 * nothing and can never double-attribute. Returns the rows linked this run.
 */
export function correlateTokenUsageToDispatches(
  db: Database.Database,
  opts: { agent?: string; sessionId?: string; maxWindowSeconds?: number; configPath?: string } = {},
): number {
  // Explicit caller value wins; otherwise deployment-local config; otherwise the
  // committed default. An invalid explicit value degrades to the default too.
  const maxWindowSeconds = opts.maxWindowSeconds !== undefined
    ? sanitizeMaxWindowSeconds(opts.maxWindowSeconds)
    : loadDispatchAttributionConfig(opts.configPath).maxWindowSeconds

  const where: string[] = ['session_id IS NOT NULL']
  const params: unknown[] = []
  if (opts.agent) { where.push('agent = ?'); params.push(opts.agent) }
  if (opts.sessionId) { where.push('session_id = ?'); params.push(opts.sessionId) }
  const dispatches = db.prepare(
    `SELECT dispatch_id, agent, session_id, created_at FROM dispatches
     WHERE ${where.join(' AND ')} ORDER BY agent, session_id, created_at ASC`
  ).all(...params) as { dispatch_id: string; agent: string; session_id: string; created_at: number }[]

  // Earliest terminal outcome per dispatch. MIN, so a later terminal outcome can
  // never RE-OPEN a window that was already closed.
  const closedAt = new Map<string, number>()
  const terminalRows = db.prepare(
    `SELECT dispatch_id, MIN(created_at) AS closed_at FROM dispatch_outcomes
     WHERE dispatch_id IS NOT NULL AND outcome IN (${TERMINAL_OUTCOMES.map(() => '?').join(', ')})
     GROUP BY dispatch_id`
  ).all(...TERMINAL_OUTCOMES) as { dispatch_id: string; closed_at: number }[]
  for (const r of terminalRows) closedAt.set(r.dispatch_id, r.closed_at)

  // Bind order: dispatch_id, agent, session_id, from, nextStart, capEnd, outcomeEnd.
  const link = db.prepare(
    `UPDATE token_usage SET dispatch_id = ?
     WHERE dispatch_id IS NULL AND agent = ? AND session_id = ?
       AND timestamp >= ?      -- 1. forward-only from the dispatch
       AND timestamp < ?       -- 2. next dispatch of the same (agent, session)
       AND timestamp <= ?      -- 3. BOUND: created_at + maxWindowSeconds
       AND timestamp <= ?      -- 4. BOUND: earliest terminal outcome`
  )
  let linked = 0
  const tx = db.transaction(() => {
    for (let i = 0; i < dispatches.length; i++) {
      const d = dispatches[i]
      const next = dispatches[i + 1]
      // Session-timeline end: the next dispatch of the SAME (agent, session_id),
      // otherwise a sentinel -- which is exactly why bounds 3/4 are required.
      const nextStart = (next && next.agent === d.agent && next.session_id === d.session_id)
        ? next.created_at
        : Number.MAX_SAFE_INTEGER
      const capEnd = d.created_at + maxWindowSeconds
      const outcomeEnd = closedAt.get(d.dispatch_id) ?? Number.MAX_SAFE_INTEGER
      linked += link.run(d.dispatch_id, d.agent, d.session_id, d.created_at, nextStart, capEnd, outcomeEnd).changes
    }
  })
  tx()
  return linked
}

/**
 * Best-effort correlation for the token-collection path. The correlation is
 * MEASUREMENT: it runs immediately after every collection (see
 * collectTokenUsage), and a fault in it -- a missing P2-A table on an
 * un-migrated DB, a locked file, anything -- must NOT break the collection that
 * just wrote real token rows. Returns the rows linked, or 0 if it threw
 * (logged, not raised). Idempotent by construction (the inner function only
 * touches `dispatch_id IS NULL` rows), so a swallowed fault simply means the
 * rows stay unattributed until the next collection retries them.
 */
export function correlateTokenUsageToDispatchesSafe(
  db: Database.Database,
  opts: { agent?: string; sessionId?: string; maxWindowSeconds?: number; configPath?: string } = {},
): number {
  try {
    return correlateTokenUsageToDispatches(db, opts)
  } catch (err) {
    logger.warn({ err }, 'correlateTokenUsageToDispatches failed; token rows stay unattributed (collection unaffected)')
    return 0
  }
}

// ---- billing mode (from deployment-local config, NEVER a heuristic) --------

export interface BillingMapEntry {
  provider: string
  auth_profile: string
  billing_mode: BillingMode
}
export interface BillingMap {
  version?: number
  entries: BillingMapEntry[]
}

export const BILLING_MAP_PATH = join(PROJECT_ROOT, 'store', 'billing-map.json')

const VALID_BILLING_MODES: ReadonlySet<string> = new Set<BillingMode>([
  'subscription_included', 'subscription_credit', 'api_payg', 'local_compute', 'unknown',
])

/**
 * Resolve billingMode strictly from the config map keyed by (provider,
 * auth_profile). There is NO provider-name heuristic: an unmapped pair -- even
 * a well-known provider like 'anthropic' -- resolves to 'unknown', never a
 * false 'free'/'not_billed'. Null/blank provider or auth_profile => 'unknown'.
 */
export function resolveBillingMode(
  map: BillingMap | null | undefined,
  provider: string | null | undefined,
  authProfile: string | null | undefined,
): BillingMode {
  if (!map || !provider || !authProfile) return 'unknown'
  const hit = map.entries.find(e => e.provider === provider && e.auth_profile === authProfile)
  if (!hit) return 'unknown'
  return VALID_BILLING_MODES.has(hit.billing_mode) ? hit.billing_mode : 'unknown'
}

/** Load the deployment-local billing map (gitignored store/). Missing/invalid => null. */
export function loadBillingMap(path: string = BILLING_MAP_PATH): BillingMap | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (!raw || !Array.isArray(raw.entries)) return null
    const entries: BillingMapEntry[] = []
    for (const e of raw.entries) {
      if (e && typeof e.provider === 'string' && typeof e.auth_profile === 'string' && typeof e.billing_mode === 'string') {
        entries.push({ provider: e.provider, auth_profile: e.auth_profile, billing_mode: e.billing_mode as BillingMode })
      }
    }
    return { version: raw.version, entries }
  } catch (err) {
    logger.warn({ err, path }, 'loadBillingMap: invalid billing-map.json; treating as absent (unknown)')
    return null
  }
}

// ---- cost_per_accepted_task ------------------------------------------------

export interface CostPerAcceptedGroup {
  agent: string | null
  modelProfile: string | null
  model: string | null
  provider: string | null
  taskType: string | null
  project: string | null
  billingMode: string | null
  period: string           // 'YYYY-MM' (UTC)
  acceptedTasks: number
  // MARGINAL: actual execution $ (pricing.ts token estimate) attributed to the
  // accepted dispatches in this group. null when no priced token_usage is
  // attributable (unpriced model => visibly unknown, never a fake 0).
  marginalCost: number | null
  marginalCostPerTask: number | null
  // ALLOCATED: prorated subscription monthly $ divided across accepted tasks --
  // computed at (provider, period) level so it never mixes with marginal. null
  // when there is no subscription line for that provider/period.
  allocatedCostPerTask: number | null
}

interface AcceptedTokenRow {
  dispatch_id: string
  agent: string | null
  model_profile: string | null
  runtime_model: string | null
  provider: string | null
  task_type: string | null
  project: string | null
  billing_mode: string | null
  created_at: number
  tu_model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_creation_tokens: number | null
}

function periodOf(createdAtSec: number): string {
  const d = new Date(createdAtSec * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * cost_per_accepted_task: join accepted dispatches -> their token_usage (via
 * dispatch_id) -> pricing (costops/pricing.ts). Returns MARGINAL (actual token
 * $) and ALLOCATED (prorated subscription monthly / accepted tasks) as SEPARATE
 * values, never mixed. Grouped by agent, modelProfile, model, provider,
 * task_type, project, billingMode, period. Mirrors getTokenCostByAgent's
 * read-function shape; no new endpoint required for P2-A but it is a callable.
 */
export function costPerAcceptedTask(
  db: Database.Database,
  opts: { pricing?: PricingConfig | null; from?: number; to?: number } = {},
): CostPerAcceptedGroup[] {
  const pricing = opts.pricing ?? loadPricingConfig().pricing

  const conds: string[] = ["o.outcome = 'accepted'"]
  const params: unknown[] = []
  if (opts.from) { conds.push('d.created_at >= ?'); params.push(opts.from) }
  if (opts.to) { conds.push('d.created_at < ?'); params.push(opts.to) }

  // LEFT JOIN token_usage: an accepted dispatch counts even when no token_usage
  // is attributed yet (marginal stays null; acceptedTasks still counts it).
  const rows = db.prepare(`
    SELECT d.dispatch_id, d.agent, d.model_profile, d.runtime_model, d.provider,
           d.task_type, d.project, d.billing_mode, d.created_at,
           tu.model AS tu_model, tu.input_tokens, tu.output_tokens,
           tu.cache_read_tokens, tu.cache_creation_tokens
    FROM dispatches d
    JOIN dispatch_outcomes o ON o.dispatch_id = d.dispatch_id AND o.outcome = 'accepted'
    LEFT JOIN token_usage tu ON tu.dispatch_id = d.dispatch_id
    WHERE ${conds.join(' AND ')}
  `).all(...params) as AcceptedTokenRow[]

  // Group accumulator. Marginal is summed per token_usage row; acceptedTasks is
  // counted per DISTINCT dispatch (a dispatch with N token rows is one task).
  interface Acc {
    key: string
    g: Omit<CostPerAcceptedGroup, 'acceptedTasks' | 'marginalCost' | 'marginalCostPerTask' | 'allocatedCostPerTask'>
    dispatches: Set<string>
    marginal: number
    marginalSeen: boolean
    provider: string | null
    period: string
  }
  const groups = new Map<string, Acc>()
  // provider+period accepted-task counts, for the allocated denominator.
  const providerPeriodTasks = new Map<string, Set<string>>()

  for (const r of rows) {
    const period = periodOf(r.created_at)
    const model = r.runtime_model ?? r.tu_model ?? null
    const key = [r.agent, r.model_profile, model, r.provider, r.task_type, r.project, r.billing_mode, period].map(v => v ?? ' ').join('|')
    let acc = groups.get(key)
    if (!acc) {
      acc = {
        key,
        g: {
          agent: r.agent, modelProfile: r.model_profile, model, provider: r.provider,
          taskType: r.task_type, project: r.project, billingMode: r.billing_mode, period,
        },
        dispatches: new Set(),
        marginal: 0,
        marginalSeen: false,
        provider: r.provider,
        period,
      }
      groups.set(key, acc)
    }
    acc.dispatches.add(r.dispatch_id)

    const ppKey = `${r.provider ?? ' '}|${period}`
    if (!providerPeriodTasks.has(ppKey)) providerPeriodTasks.set(ppKey, new Set())
    providerPeriodTasks.get(ppKey)!.add(r.dispatch_id)

    if (r.input_tokens != null || r.output_tokens != null) {
      const marginal = estimateModelCost(pricing, model ?? r.tu_model, {
        input: r.input_tokens ?? 0,
        output: r.output_tokens ?? 0,
        cache_read: r.cache_read_tokens ?? 0,
        cache_creation: r.cache_creation_tokens ?? 0,
      })
      if (marginal != null) { acc.marginal += marginal; acc.marginalSeen = true }
    }
  }

  return [...groups.values()].map(acc => {
    const acceptedTasks = acc.dispatches.size
    const marginalCost = acc.marginalSeen ? round4(acc.marginal) : null
    const marginalCostPerTask = marginalCost != null && acceptedTasks > 0 ? round4(marginalCost / acceptedTasks) : null
    const allocatedCostPerTask = allocatedPerTask(db, acc.provider, acc.period, providerPeriodTasks.get(`${acc.provider ?? ' '}|${acc.period}`)?.size ?? acceptedTasks)
    return { ...acc.g, acceptedTasks, marginalCost, marginalCostPerTask, allocatedCostPerTask }
  })
}

/**
 * Allocated cost per accepted task = (subscription $ for this provider in this
 * period, from cost_line_items) / (accepted tasks for this provider+period).
 * null when there is no subscription line -- allocated is never fabricated.
 */
function allocatedPerTask(db: Database.Database, provider: string | null, period: string, providerPeriodAcceptedTasks: number): number | null {
  if (!provider || providerPeriodAcceptedTasks <= 0) return null
  const [y, m] = period.split('-').map(n => parseInt(n, 10))
  if (!y || !m) return null
  const start = Math.floor(Date.UTC(y, m - 1, 1) / 1000)
  const end = Math.floor(Date.UTC(y, m, 1) / 1000)
  const row = db.prepare(`
    SELECT COALESCE(SUM(li.billed_cost), 0) AS total, COUNT(*) AS n
    FROM cost_line_items li
    JOIN cost_sources s ON s.id = li.source_id
    WHERE s.provider = ? AND li.charge_category = 'subscription'
      AND li.charge_period_start < ? AND li.charge_period_end > ?
  `).get(provider, end, start) as { total: number; n: number }
  if (!row || row.n === 0) return null
  return round4(row.total / providerPeriodAcceptedTasks)
}

function round4(n: number): number { return Math.round(n * 10000) / 10000 }
