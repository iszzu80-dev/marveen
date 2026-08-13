// CostOps v0.3 -- provider cost collector framework (types).
//
// Provider-agnostic, deterministic, NO LLM. The HTTP fetcher is INJECTED so
// collectors are unit-tested fully offline with fixtures -- no live provider
// call happens unless a real fetcher is passed in by an explicitly-approved run.
// Secrets are passed in by the runner (from the Vault) and are NEVER logged.

export type CostConfidenceApi = 'provider_api' | 'billing_export' | 'provider_plan_estimate'

export interface NormalizedCostLine {
  provider: string
  service: string                 // maps to a cost_sources.id (e.g. 'anthropic-api')
  billing_period_start: number    // epoch sec
  billing_period_end: number      // epoch sec
  amount: number                  // in `currency`
  currency: string
  confidence: CostConfidenceApi
  usage_type?: string | null
  quantity?: number | null
  unit?: string | null
  data_freshness_at: number       // provider "as of" time (epoch sec)
  raw_ref_hash?: string | null    // sha256(salt, raw id) -- NEVER a raw account/invoice id
  dedup_key: string               // idempotent upsert key
  // COS-OPS-M4 (fold of deepseek.ts's hand-rolled upsertLine into the shared
  // runner writer): optional fx provenance for a line whose `amount` was
  // converted from a native currency (card a1552362 -- same columns
  // email-ingest.ts retains). Omitted/null for lines already native in
  // `currency` -- never fabricated.
  original_amount?: number | null
  original_currency?: string | null
  fx_rate?: number | null
  fx_date?: number | null
}

// Injected HTTP GET returning parsed JSON. Tests pass a stub that returns a
// fixture; a live run would pass a real implementation (only after approval).
export type HttpGetJson = (url: string, headers: Record<string, string>) => Promise<unknown>

export interface CollectOpts {
  periodStart: number
  periodEnd: number
  secret: string                  // from Vault; NEVER logged/persisted
  fxUsdHuf: number
  idSalt: string                  // for raw_ref_hash
  httpGetJson: HttpGetJson        // injected -- offline in tests
  // The real collection instant (epoch seconds). This is an INGEST timestamp,
  // never a billing-period boundary -- a collector must not substitute
  // periodStart/periodEnd for it (card 320c477a: doing so left data_freshness
  // carrying a period-END date, which then out-won a real invoice on an
  // equal-tier freshness tiebreak).
  now: number
}

export interface ProviderCollector {
  provider: string
  collectorName: string
  // PURE network READ + normalize. Never writes to the provider. No LLM.
  collect(opts: CollectOpts): Promise<NormalizedCostLine[]>
  // Optional: same READ, but also returns the raw response so a DRY-RUN can
  // describe its SHAPE (types only, never values). No secret is in `raw`'s
  // shape description. Collectors without this fall back to lines-only dry-run.
  collectRaw?(opts: CollectOpts): Promise<{ raw: unknown; lines: NormalizedCostLine[] }>
}

// 'dry_run' marks a preview run that imported NOTHING (imported_count always 0).
// Phase 1 (GAP-07): 'locked' added -- a concurrent run for the same provider
// was already in flight, so this run skipped entirely without touching any
// data (see import-durability.ts's withImportLock).
// P2-C: 'skipped' added -- the collector was DUE and really attempted, but had
// nothing it could legitimately do (no credential available to it, no manual
// snapshot to promote, no API in existence). It is deliberately distinct from
// 'error' (something broke, retry may help) and from 'ok' (data landed): a
// documented hard blocker must not read as either a failure to fix or a success.
export type ImportStatus = 'ok' | 'partial' | 'rate_limited' | 'error' | 'dry_run' | 'locked' | 'skipped'

// The status vocabulary above, partitioned ONCE for every consumer (ledger.ts
// provider_sync, alerts-capture.ts failed_sync, inventory.ts/lifecycle.ts
// 'blocked', period-close.ts close-readiness via provider_sync). Re-deriving
// "failure" locally as `status !== 'ok'` is exactly the drift that made a
// benign hourly 'skipped' tick read as a permanently-failed provider
// (COS-OPS-H3 / COS-CORE-M2): use these instead.
//
// FAILURE: something actually broke -- retry/attention may help.
export const FAILURE_IMPORT_STATUSES: readonly ImportStatus[] = ['error', 'partial', 'rate_limited']
// BENIGN: the run happened and deliberately did nothing ('skipped' documented
// hard blocker, 'locked' concurrent-run no-op, 'dry_run' preview). A benign
// run carries NO sync-health evidence either way: it must neither read as a
// failure NOR as a success that masks/clears an earlier real failure.
export const BENIGN_IMPORT_STATUSES: readonly ImportStatus[] = ['skipped', 'locked', 'dry_run']
// HEALTH-BEARING: the statuses that DO carry sync-health evidence ('ok' plus
// the failures). "Latest run" health derivations must look at the latest run
// with one of THESE statuses, so an ok -> skipped sequence stays ok and an
// error -> skipped sequence stays failed.
export const HEALTH_IMPORT_STATUSES: readonly ImportStatus[] = ['ok', ...FAILURE_IMPORT_STATUSES]

export function isFailureStatus(status: string): boolean {
  return (FAILURE_IMPORT_STATUSES as readonly string[]).includes(status)
}
export function isBenignImportStatus(status: string): boolean {
  return (BENIGN_IMPORT_STATUSES as readonly string[]).includes(status)
}

// Ready-made `'a', 'b', ...` fragments for SQL `status IN (...)` filters. The
// values are this module's own literals above -- never user input.
export const SQL_FAILURE_STATUS_LIST = FAILURE_IMPORT_STATUSES.map(s => `'${s}'`).join(', ')
export const SQL_HEALTH_STATUS_LIST = HEALTH_IMPORT_STATUSES.map(s => `'${s}'`).join(', ')

// A sanitized description of a value's STRUCTURE -- types, object keys, and
// array lengths ONLY. It carries NO scalar values, so no secret, account id,
// invoice ref, or raw provider datum can travel in it.
export type ShapeNode =
  | 'string' | 'number' | 'boolean' | 'null' | 'undefined'
  | { type: 'array'; length: number; of: ShapeNode }
  | { type: 'object'; keys: Record<string, ShapeNode> }

// Result of a DRY-RUN: what a real import WOULD do, without persisting any
// provider_api cost line. Secret-free by construction.
export interface DryRunReport {
  provider: string
  collectorName: string
  status: 'dry_run' | 'error'
  plannedLines: NormalizedCostLine[]  // normalized lines (raw_ref_hash is a hash, no raw id)
  dedupKeys: string[]                 // the idempotent keys a real import would upsert on
  responseShape: ShapeNode | null     // sanitized shape of the provider response (null if unavailable)
  wouldImportCount: number            // how many provider_api lines a real import WOULD write
  errorCode: string | null
  errorMessageSanitized: string | null
}

export interface ImportRunResult {
  provider: string
  collectorName: string
  status: ImportStatus
  importedCount: number
  errorCode: string | null
  errorMessageSanitized: string | null
  dataFreshnessAt: number | null
}
