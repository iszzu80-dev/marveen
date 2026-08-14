// APG 1.9 WP2 §10.3-b — the dashboard stops deciding currentness for itself.
//
// The defect: two different rules minted the same label. The kernel's
// `resolve_verification_status()` is the only decision point — it never accepts
// a caller-asserted status, requires all six receipt keys, requires a
// class-authoritative method, excludes code/comment/doc/kanban/commit/self-report
// sources from ever being current, and (since the stale-receipt fix) requires
// the receipt to be inside a recency window. The dashboard, meanwhile, granted
// VERIFIED_CURRENT to any PRESENT evidence row whose receipt shared a
// replay_run_id with any PASS checkpoint — no authority, no recency, no source
// exclusion, and it never once opened the `claims` table.
//
// A second implementation of a rule IS the finding, so these tests cover both
// halves: a source-level assertion that the weak derivation is *gone* (the
// defect was its presence, not any one of its answers), and behavioural
// assertions that the projection now reports what the kernel resolved — or says
// plainly that the kernel has not spoken.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildApgWorkItemDetail } from '../apg/ui-projection.js'
import type { ApgClaim } from '../apg/ui-types.js'

const PROJECTION_SRC = readFileSync(
  join(process.cwd(), 'src/apg/ui-projection.ts'),
  'utf8',
)

describe('the weak rule is gone, not merely outvoted', () => {
  it('HEADLINE: nothing in the projection returns VERIFIED_CURRENT of its own accord', () => {
    // The whole defect in one grep. The label may be RELABELLED from a kernel
    // status (a table lookup with no evidence input); it may never be RETURNED
    // by a function that looked at evidence and made up its mind.
    expect(PROJECTION_SRC).not.toMatch(/return 'VERIFIED_CURRENT'/)
  })

  it('the claim projection cannot see checkpoints, receipts or replay runs at all', () => {
    // Structural, not behavioural: the old rule needed exactly these three
    // inputs. If none of them is reachable from the claim code, no second
    // currentness rule can be hiding in it — including one added next month.
    const start = PROJECTION_SRC.indexOf('function asNonEmptyString')
    const end = PROJECTION_SRC.indexOf('function summaryFor')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const region = PROJECTION_SRC.slice(start, end)
    expect(region).not.toMatch(/replay_run_id/)
    expect(region).not.toMatch(/candidate\.checkpoints/)
    expect(region).not.toMatch(/candidate\.receipts/)
    expect(region).not.toMatch(/'PASS'/)
  })

  it('no hardcoded superseded_by/verifier null is presented as a finding', () => {
    expect(PROJECTION_SRC).not.toMatch(/superseded_by:\s*null/)
    expect(PROJECTION_SRC).not.toMatch(/verifier:\s*null/)
  })

  it('the projection reads the kernel claims table', () => {
    expect(PROJECTION_SRC).toMatch(/FROM claims/)
  })
})

// ---------------------------------------------------------------------------
// Behavioural half, against a real sidecar-shaped SQLite file.
//
// APG_KERNEL_DB_PATH is the injectable seam the projection already exposes
// (resolveApgKernelDbPath), which is what makes this testable without chmod
// tricks — this container runs as root, so an unwritable/unreadable path proves
// nothing.
// ---------------------------------------------------------------------------

const SIDECAR_SCHEMA = `
  CREATE TABLE canonical_artifact_versions (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, logical_id TEXT NOT NULL,
    version INTEGER NOT NULL, content_digest TEXT NOT NULL, source_ref TEXT,
    created_at INTEGER NOT NULL);
  CREATE TABLE lineage_heads (
    logical_id TEXT PRIMARY KEY, head_version INTEGER NOT NULL,
    head_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE assisted_recommendations (
    id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, replay_run_id TEXT,
    evidence_completeness TEXT NOT NULL, missing_evidence_json TEXT NOT NULL,
    proposed_status_text TEXT NOT NULL, basis_json TEXT NOT NULL,
    draft_marker TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE change_delivery_transitions (
    id TEXT PRIMARY KEY, change_logical_id TEXT NOT NULL, from_state TEXT NOT NULL,
    to_state TEXT NOT NULL, checkpoint TEXT, checkpoint_result TEXT,
    replay_run_id TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE checkpoint_results (
    id TEXT PRIMARY KEY, replay_run_id TEXT NOT NULL, checkpoint TEXT NOT NULL,
    result TEXT NOT NULL, failed_checks TEXT, profile_overlay TEXT,
    created_at INTEGER NOT NULL);
  CREATE TABLE execution_receipts (
    id TEXT PRIMARY KEY, replay_run_id TEXT NOT NULL, change_logical_id TEXT NOT NULL,
    tested_commit TEXT, built_commit TEXT, deployed_artifact TEXT,
    commit_chain_status TEXT NOT NULL, runtime_status TEXT NOT NULL,
    created_at INTEGER NOT NULL);
  CREATE TABLE evidence_references (
    id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, link TEXT NOT NULL,
    ref_kind TEXT NOT NULL, ref_locator TEXT, ref_digest TEXT,
    status TEXT NOT NULL, created_at INTEGER NOT NULL);
`

// Migration 0009 verbatim (the ten fields), so the "kernel has not added the
// new columns yet" case is the DEFAULT this suite runs against.
const CLAIMS_TABLE_0009 = `
  CREATE TABLE claims (
    id TEXT PRIMARY KEY, claim_text TEXT NOT NULL, claim_class TEXT NOT NULL,
    source_type TEXT, source_locator TEXT, source_observed_at INTEGER,
    verification_status TEXT NOT NULL, verification_receipt_json TEXT NOT NULL,
    allowed_wording TEXT NOT NULL, blocking_reason TEXT NOT NULL,
    created_at INTEGER NOT NULL);
`

const NOW = 1_770_000_000
const OBSERVED_AT = NOW - 3600

/** A full receipt: all six REQUIRED_RECEIPT_KEYS, as the kernel would store it. */
function receiptJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    method: 'live_probe',
    target_environment: 'production',
    observed_at: OBSERVED_AT,
    result: 'CONFIRMED',
    source_locator: 'src/foo.ts',
    store_record_ref: 'replay:r1',
    ...overrides,
  })
}

let tempRoot: string
let dbPath: string

/**
 * A sidecar containing exactly the shape that used to mint a false
 * VERIFIED_CURRENT: one PRESENT evidence row, on a receipt, on a replay run
 * whose release_ready checkpoint PASSed. Every test below starts here, so the
 * old rule would have said "current" for all of them.
 */
function seedSidecar(claimsTableSql: string | null): Database.Database {
  rmSync(dbPath, { force: true })
  const db = new Database(dbPath)
  db.exec(SIDECAR_SCHEMA)
  if (claimsTableSql !== null) db.exec(claimsTableSql)
  db.prepare(`INSERT INTO canonical_artifact_versions VALUES (?,?,?,?,?,?,?)`)
    .run('change:chg-1:1', 'change', 'chg-1', 1, 'digest-1', 'card 1732a148', NOW)
  db.prepare(`INSERT INTO lineage_heads VALUES (?,?,?,?)`)
    .run('chg-1', 1, 'change:chg-1:1', NOW)
  db.prepare(`INSERT INTO execution_receipts VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('rcpt-1', 'r1', 'chg-1', 'abc123', 'abc123', 'deploy-1', 'CONSISTENT', 'OBSERVED', NOW)
  db.prepare(`INSERT INTO checkpoint_results VALUES (?,?,?,?,?,?,?)`)
    .run('ck-1', 'r1', 'release_ready', 'PASS', '[]', '[]', NOW)
  db.prepare(`INSERT INTO evidence_references VALUES (?,?,?,?,?,?,?,?)`)
    .run('ev-1', 'rcpt-1', 'implementation', 'commit', 'src/foo.ts', 'sha-1', 'PRESENT', NOW)
  return db
}

function insertClaim(db: Database.Database, row: Record<string, unknown>): void {
  const full = {
    id: 'claim-1',
    claim_text: 'the Twilio integration is live',
    claim_class: 'INTEGRATION_CONNECTED',
    source_type: 'live_probe_result',
    source_locator: 'src/foo.ts',
    source_observed_at: OBSERVED_AT,
    verification_status: 'STALE',
    verification_receipt_json: receiptJson(),
    allowed_wording: 'This claim was observed by a method insufficient for its class...',
    blocking_reason: '',
    created_at: NOW,
    ...row,
  }
  const columns = Object.keys(full)
  db.prepare(
    `INSERT INTO claims (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
  ).run(...columns.map((key) => (full as Record<string, unknown>)[key]))
}

function detailClaims(): { claims: ApgClaim[]; projection_error?: string; claim_counts: any } {
  const detail = buildApgWorkItemDetail('assisted', 'chg-1')
  if ('error' in detail) throw new Error(`unexpected projection error: ${detail.error}`)
  return detail
}

describe('WP2 §10.3-b: the kernel decides currentness, the dashboard reports it', () => {
  beforeEach(() => {
    tempRoot ??= mkdtempSync(join(tmpdir(), 'apg-claim-currentness-'))
    dbPath = join(tempRoot, 'apg-kernel.db')
    process.env.APG_KERNEL_DB_PATH = dbPath
  })

  afterAll(() => {
    delete process.env.APG_KERNEL_DB_PATH
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  })

  it('HEADLINE: evidence with no resolved claim is NOT_RESOLVED_BY_ENGINE, not VERIFIED_CURRENT', () => {
    // The exact input the old rule turned green: PRESENT evidence + PASS gate.
    seedSidecar(CLAIMS_TABLE_0009).close()

    const { claims, claim_counts } = detailClaims()
    expect(claims).toHaveLength(1)
    expect(claims[0].status).toBe('NOT_RESOLVED_BY_ENGINE')
    expect(claim_counts.verified_current).toBe(0)
    expect(claim_counts.not_resolved).toBe(1)
    // §3.7: an honest unresolved state, not a downgraded guess either. The
    // reader must be able to tell "nobody checked" from "checked, and weak".
    expect(claims[0].status).not.toBe('SUPPORTED_BUT_NOT_RUNTIME_VERIFIED')
    expect(claims[0].status).not.toBe('UNKNOWN')
    expect(claims[0].allowed_wording).toMatch(/nem döntött/)
  })

  it('an unresolved claim carries no fabricated verified_at, verifier or superseded_by', () => {
    seedSidecar(CLAIMS_TABLE_0009).close()

    const [claim] = detailClaims().claims
    // Absent, not null. A `superseded_by: null` reads as "the kernel checked and
    // found no supersede"; the kernel was never asked.
    expect('verified_at' in claim).toBe(false)
    expect('verifier' in claim).toBe(false)
    expect('superseded_by' in claim).toBe(false)
    expect('kernel_verification_status' in claim).toBe(false)
    expect(JSON.stringify(claim)).not.toMatch(/null/)
  })

  it('a resolved claim projects the kernel status verbatim — including STALE on a PASSing gate', () => {
    // The stale-receipt trust attack, end to end: the kernel resolved this to
    // STALE, and the PASS checkpoint next to it must not be able to overrule
    // that from the dashboard side.
    const db = seedSidecar(CLAIMS_TABLE_0009)
    insertClaim(db, { verification_status: 'STALE' })
    db.close()

    const [claim] = detailClaims().claims
    expect(claim.kernel_verification_status).toBe('STALE')
    expect(claim.status).toBe('STALE_OR_SUPERSEDED')
    expect(claim.kernel_allowed_wording).toMatch(/insufficient for its class/)
    // verified_at is the receipt's observation time, not the evidence row's
    // bookkeeping timestamp — that substitution is what made a stale receipt
    // look freshly verified.
    expect(claim.verified_at).toBe(new Date(OBSERVED_AT * 1000).toISOString())
  })

  it('VERIFIED_CURRENT appears only because the kernel resolved it that way', () => {
    const db = seedSidecar(CLAIMS_TABLE_0009)
    insertClaim(db, { verification_status: 'VERIFIED_CURRENT' })
    db.close()

    const { claims, claim_counts } = detailClaims()
    expect(claims[0].kernel_verification_status).toBe('VERIFIED_CURRENT')
    expect(claims[0].status).toBe('VERIFIED_CURRENT')
    expect(claims[0].kernel_claim_id).toBe('claim-1')
    expect(claim_counts.verified_current).toBe(1)
    expect(claim_counts.not_resolved).toBe(0)
  })

  it('every kernel status reaches the display vocabulary without inventing currency', () => {
    const expected: Record<string, string> = {
      VERIFIED_CURRENT: 'VERIFIED_CURRENT',
      VERIFIED_HISTORICAL_ONLY: 'VERIFIED_HISTORICAL',
      SELF_REPORTED_ONLY: 'SUPPORTED_BUT_NOT_RUNTIME_VERIFIED',
      STALE: 'STALE_OR_SUPERSEDED',
      UNKNOWN: 'UNKNOWN',
      MISSING: 'BLOCKED_FROM_USE',
      CONTRADICTED: 'CONFLICTING_EVIDENCE',
    }
    for (const [kernelStatus, displayStatus] of Object.entries(expected)) {
      const db = seedSidecar(CLAIMS_TABLE_0009)
      insertClaim(db, { verification_status: kernelStatus })
      db.close()
      const [claim] = detailClaims().claims
      expect(claim.status, `kernel ${kernelStatus}`).toBe(displayStatus)
    }
  })

  it('the receipt store_record_ref wins over a locator match — the kernel naming the row', () => {
    const db = seedSidecar(CLAIMS_TABLE_0009)
    // Same locator, resolved STALE...
    insertClaim(db, { id: 'claim-locator', verification_status: 'STALE' })
    // ...and one whose receipt points AT this evidence row, resolved current.
    insertClaim(db, {
      id: 'claim-record-ref',
      source_locator: 'something/else.ts',
      verification_status: 'VERIFIED_CURRENT',
      verification_receipt_json: receiptJson({ store_record_ref: 'ev-1' }),
    })
    db.close()

    const [claim] = detailClaims().claims
    expect(claim.kernel_claim_id).toBe('claim-record-ref')
    expect(claim.status).toBe('VERIFIED_CURRENT')
  })

  it('within one tier the newest append wins — claims is append-only, not updated in place', () => {
    const db = seedSidecar(CLAIMS_TABLE_0009)
    insertClaim(db, { id: 'claim-old', verification_status: 'VERIFIED_CURRENT', created_at: NOW - 500 })
    insertClaim(db, { id: 'claim-new', verification_status: 'STALE', created_at: NOW })
    db.close()

    const [claim] = detailClaims().claims
    expect(claim.kernel_claim_id).toBe('claim-new')
    expect(claim.status).toBe('STALE_OR_SUPERSEDED')
  })

  it('a claims table that cannot be read says so, instead of reading as "engine had nothing to say"', () => {
    // F-9's lesson applied to the claim path: an absent table and a silent
    // engine produce the same claim status, so the difference has to surface on
    // the error channel or it is lost.
    seedSidecar(null).close()

    const detail = detailClaims()
    expect(detail.claims[0].status).toBe('NOT_RESOLVED_BY_ENGINE')
    expect(detail.projection_error).toMatch(/no such table: claims/)
  })

  it('a kernel status this build does not know is UNKNOWN plus a contract error, never silence', () => {
    const db = seedSidecar(CLAIMS_TABLE_0009)
    insertClaim(db, { verification_status: 'VERIFIED_PROBABLY' })
    db.close()

    const detail = detailClaims()
    // The engine DID speak, so NOT_RESOLVED_BY_ENGINE would be a lie in the
    // other direction; and nothing may round it up to a verified label.
    expect(detail.claims[0].status).toBe('UNKNOWN')
    expect(detail.claims[0].kernel_verification_status).toBeUndefined()
    expect(detail.projection_error).toMatch(/unrecognised kernel verification_status/)
  })

  it('§10.1/§10.2/§10.3 columns are projected verbatim the day the kernel stores them', () => {
    // The kernel's parallel WP2 work adds product_id, currentness and
    // supersede. This projection must not need a change when they land — and
    // must not fabricate them before they do (covered above).
    const db = seedSidecar(`
      CREATE TABLE claims (
        id TEXT PRIMARY KEY, claim_text TEXT NOT NULL, claim_class TEXT NOT NULL,
        source_type TEXT, source_locator TEXT, source_observed_at INTEGER,
        verification_status TEXT NOT NULL, verification_receipt_json TEXT NOT NULL,
        allowed_wording TEXT NOT NULL, blocking_reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        product_id TEXT, currentness TEXT, superseded_by TEXT);
    `)
    insertClaim(db, {
      verification_status: 'VERIFIED_HISTORICAL_ONLY',
      product_id: 'marveen-dashboard',
      currentness: 'SUPERSEDED',
      superseded_by: 'claim-2',
    })
    db.close()

    const [claim] = detailClaims().claims
    expect(claim.status).toBe('VERIFIED_HISTORICAL')
    expect(claim.product_id).toBe('marveen-dashboard')
    expect(claim.currentness).toBe('SUPERSEDED')
    expect(claim.superseded_by).toBe('claim-2')
  })
})
