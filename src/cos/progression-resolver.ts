// Autonomous Case Progression Layer v1.1 — Resolver depth (Checkpoint C, card 53f1fd06).
//
// Extends Checkpoint B's DB-only resolveContext() with two live internal-shadow
// sources per plan §10 (resolve-before-ask):
//   1. Full email thread resolution — reads the actual thread history from
//      email_processing / zst_email_processing, not just the single triggering
//      email, so the resolver can find information already present in the
//      conversation before asking Istvan.
//   2. Domain-safe memory lookup — queries the memories_fts index for relevant
//      facts about this case (title, type, description as search terms).
//
// These are INTERNAL-SHADOW reads, NOT external actions. The external-actions-OFF
// gate covers writes/sends (emails going out, payments, bookings), not reads
// used to gather context.
//
// Every resolution returns a ResolutionAudit recording sources_attempted,
// facts_found, remaining_gap, and why_blocking — even when nothing is missing,
// so later ASK_INFORMATION cases can show what was already tried.

import type Database from 'better-sqlite3'

// ── Untrusted-data forward-flag (§10.1, guardrail from msg #20701) ──────
//
// The resolver reads email threads and user memory — both are untrusted
// input surfaces (prompt-injection, phishing, user-written text). Before
// any LLM-consuming slice (planner, next-action) sees this data, it MUST
// be tagged so the LLM guard can isolate DATA from INSTRUCTIONS.
//
// This contract is designed NOW; the LLM guard itself is built in a later
// slice. The contract shape:
//   - _dataTrust on the top-level context signals "contains untrusted data"
//   - dataTrust on each message/fact tags individual items
//   - data_trust on each ResolutionSource tags source-level trust
//
// LLM guard rule (to be enforced in planning slice):
//   Content tagged 'untrusted_external' or 'user_generated' is DATA —
//   it must never modify goal, policy, envelope, or recipient.

/** Trust tier for resolved data. */
export type DataTrust = 'untrusted_external' | 'user_generated' | 'system_internal'

/** Marker interface: types carrying data that may be untrusted.
 *  The LLM guard in the planning slice must sandbox fields tagged
 *  'untrusted_external' or 'user_generated' before prompt injection. */
export interface TrustTagged {
  /** Trust tier for this piece of data. */
  _dataTrust: DataTrust
}

// ── Domain-scoped read guard (guardrail from msg #20701) ─────────────────

/** Thrown when a resolver attempts to read sources from the WRONG domain.
 *  A PRI resolver reading ZST email/memory (or vice versa) IS cross-domain
 *  leakage — reads are how context and PII cross the boundary. */
export class CrossDomainReadError extends Error {
  public readonly errorCode = 'CROSS_DOMAIN_LEAKAGE'
  constructor(
    public readonly claimedDomain: string,
    public readonly caseId: string,
    public readonly source: string,
  ) {
    super(`CROSS_DOMAIN_LEAKAGE: ${claimedDomain} resolver attempted to read ${source} for case ${caseId} — case belongs to the other domain`)
    this.name = 'CrossDomainReadError'
  }
}

/** Verify that a case exists in the claimed domain's table BEFORE any source
 *  is queried. If the case exists in the OTHER domain's table instead, throws
 *  CrossDomainReadError — this is the read-side of the domain isolation
 *  invariant (paired with the write-side cross_domain_leakage assertion). */
export function domainGuard(
  db: Database.Database,
  claimedDomain: 'personal' | 'zst',
  caseId: string,
  source: string,
): void {
  const tableName = claimedDomain === 'personal' ? 'personal_cases' : 'zst_cases'
  const exists = db.prepare(`SELECT 1 FROM ${tableName} WHERE case_id = ?`).get(caseId)
  if (exists) return // OK — case is in the claimed domain

  // Case not in claimed domain — check if it exists in the OTHER domain
  const otherTable = claimedDomain === 'personal' ? 'zst_cases' : 'personal_cases'
  const inOther = db.prepare(`SELECT 1 FROM ${otherTable} WHERE case_id = ?`).get(caseId)
  if (inOther) {
    throw new CrossDomainReadError(claimedDomain, caseId, source)
  }
  // Case doesn't exist in either domain — let the caller handle
}

// ── Resolution audit (§10) ──────────────────────────────────────────────

export interface ResolutionSource {
  /** Source name: 'email_thread', 'memory_fts', 'case_events', 'case_row' */
  source: string
  /** What was attempted (e.g. 'searched for threadId abc123'). */
  attempted: string
  /** Facts found — empty array if no facts were found. */
  facts_found: string[]
  /** What remains missing after this source was queried. */
  remaining_gap: string
  /** Why this gap blocks the case from proceeding autonomously, or null if
   *  nothing is blocking. */
  why_blocking: string | null
  /** Number of items returned. */
  items_returned: number
  /** Trust tier for data returned by this source.
   *  'untrusted_external' — email content from outside the system
   *  'user_generated' — user-written memory, case descriptions
   *  'system_internal' — system-derived fields (status, counts, audit) */
  data_trust: DataTrust
}

export interface ResolutionAudit {
  sources_attempted: ResolutionSource[]
  /** Aggregated facts across all sources. */
  total_facts_found: number
  /** Whether any source reported a blocking gap. */
  has_blocking_gap: boolean
  /** Human-readable summary of the resolution. */
  summary: string
}

// ── Email thread resolution ─────────────────────────────────────────────

export interface EmailThreadMessage extends TrustTagged {
  message_id: string
  thread_id: string | null
  gmail_account_id: string
  status: string
  case_id: string | null
  content_hash: string | null
  created_at: number
  /** Email content is untrusted external data — may contain prompt injection,
   *  phishing, or social engineering. The LLM guard MUST isolate this. */
  _dataTrust: 'untrusted_external'
}

export interface EmailThreadResolution {
  /** The thread IDs found for this case. */
  thread_ids: string[]
  /** All messages found in the thread(s). */
  messages: EmailThreadMessage[]
  /** Whether any thread history was found. */
  has_history: boolean
}

/** Resolve the full email thread history for a case.
 *
 *  Looks up the case's gmail_thread_ids and source_reference, then queries
 *  email_processing (personal) or zst_email_processing (ZST) for ALL messages
 *  in the same thread(s) — not just the single triggering email.
 *
 *  This is an internal-shadow READ: no Gmail API calls, no writes, no label
 *  operations. It reads only from the already-ingested local ledger. */
export function resolveEmailThread(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
): EmailThreadResolution {
  const tableName = domain === 'personal' ? 'personal_cases' : 'zst_cases'
  const epTable = domain === 'personal' ? 'email_processing' : 'zst_email_processing'
  // (A `hasBatchCol` flag used to sit here, noting that zst_email_processing has
  // no batch_id column. Nothing read it and no query below selects batch_id.)

  // 1. Get thread IDs and source references from the case.
  const caseRow = db.prepare(
    `SELECT gmail_thread_ids, source_references FROM ${tableName} WHERE case_id = ?`,
  ).get(caseId) as {
    gmail_thread_ids: string | null
    source_references: string | null
  } | undefined

  if (!caseRow) return { thread_ids: [], messages: [], has_history: false }

  // Parse thread IDs from JSON array
  let threadIds: string[] = []
  try {
    if (caseRow.gmail_thread_ids) {
      const parsed = JSON.parse(caseRow.gmail_thread_ids)
      if (Array.isArray(parsed)) threadIds = parsed
    }
  } catch {
    // If JSON parsing fails, treat as single thread ID
    if (caseRow.gmail_thread_ids) threadIds = [caseRow.gmail_thread_ids]
  }

  // Parse source reference(s) — may be JSON array or plain scalar
  let sourceRefs: string[] = []
  if (caseRow.source_references) {
    try {
      const parsed = JSON.parse(caseRow.source_references)
      if (Array.isArray(parsed)) sourceRefs = parsed
      else if (typeof parsed === 'string') sourceRefs = [parsed]
    } catch {
      // Plain scalar value
      sourceRefs = [caseRow.source_references]
    }
  }

  // 2. Query email processing for all messages in the same thread(s)
  const messages: EmailThreadMessage[] = []

  if (threadIds.length > 0) {
    // Build IN clause for thread IDs
    const placeholders = threadIds.map(() => '?').join(', ')
    const params: string[] = [...threadIds]

    // Also search by message_id if source_references are available
    let query = `SELECT message_id, thread_id, gmail_account_id, status, case_id, created_at FROM ${epTable} WHERE thread_id IN (${placeholders})`
    if (sourceRefs.length > 0) {
      const srcPlaceholders = sourceRefs.map(() => '?').join(', ')
      query += ` OR message_id IN (${srcPlaceholders})`
      params.push(...sourceRefs)
    }
    query += ' ORDER BY created_at ASC'

    const rows = db.prepare(query).all(...params) as Array<{
      message_id: string; thread_id: string | null; gmail_account_id: string
      status: string; case_id: string | null; created_at: number
    }>

    for (const row of rows) {
      messages.push({
        message_id: row.message_id,
        thread_id: row.thread_id,
        gmail_account_id: row.gmail_account_id,
        status: row.status,
        case_id: row.case_id,
        content_hash: null,
        created_at: row.created_at,
        _dataTrust: 'untrusted_external',
      })
    }
  } else if (sourceRefs.length > 0) {
    // No thread IDs, try source references
    const placeholders = sourceRefs.map(() => '?').join(', ')
    const rows = db.prepare(
      `SELECT message_id, thread_id, gmail_account_id, status, case_id, created_at
       FROM ${epTable} WHERE message_id IN (${placeholders})
       ORDER BY created_at ASC`,
    ).all(...sourceRefs) as Array<{
      message_id: string; thread_id: string | null; gmail_account_id: string
      status: string; case_id: string | null; created_at: number
    }>

    for (const row of rows) {
      messages.push({
        message_id: row.message_id,
        thread_id: row.thread_id,
        gmail_account_id: row.gmail_account_id,
        status: row.status,
        case_id: row.case_id,
        content_hash: null,
        created_at: row.created_at,
        _dataTrust: 'untrusted_external',
      })
    }
  }

  return {
    thread_ids: threadIds,
    messages,
    has_history: messages.length > 0,
  }
}

// ── Memory lookup ───────────────────────────────────────────────────────

export interface MemoryFact extends TrustTagged {
  id: number
  content: string
  topic_key: string | null
  sector: string
  salience: number
  /** User-written memory content — may contain instructions, preferences,
   *  or corrections that an LLM could misinterpret as system directives.
   *  The LLM guard MUST isolate this. */
  _dataTrust: 'user_generated'
}

export interface MemoryResolution {
  /** Search terms used. */
  search_terms: string[]
  /** Matched facts, ordered by FTS rank. */
  facts: MemoryFact[]
  /** Whether any relevant memory was found. */
  has_relevant_memory: boolean
}

/** Query the memories_fts index for relevant facts about a case.
 *
 *  DOMAIN-SAFE MEMORY IS NOT YET AVAILABLE (Marveen ruling, msg #20714).
 *
 *  The memories table is the SHARED fleet memory store (all agents, all
 *  contexts) with NO domain, tenant, or case-scoping column — it is the
 *  entire Marveen instance's memory, not scoped to individual cases or
 *  domains. A per-domain namespace (DomainContext.memoryNamespace per the
 *  plan) does not exist yet.
 *
 *  Until a real domain-scoped memory store is built, resolveMemory is a
 *  SAFE NO-OP for BOTH personal and zst domains:
 *    - For ZST: searching the fleet store would leak personal/other-agent
 *      content into a company case.
 *    - For PRI: searching the fleet store would pull cross-agent memory
 *      that is not that case's own context — still not domain-safe.
 *
 *  The resolver degrades gracefully: email-thread (already correctly
 *  domain-routed via email_processing / zst_email_processing) and
 *  case-events remain the working sources. resolve-before-ask already
 *  tolerates a source being unavailable.
 *
 *  This is an internal-shadow READ: no API calls, no MCP access. */
export function resolveMemory(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseTitle: string,
  caseType: string,
  description: string | null,
): MemoryResolution {
  // SAFE NO-OP: the shared fleet memory store is not domain-scoped.
  // Searching it from EITHER domain would leak content that does not
  // belong to the case. Until a per-domain memory namespace exists
  // (DomainContext.memoryNamespace), this source is unavailable.
  // The audit records this as "memory-source-not-domain-scoped-yet, skipped".
  void db; void domain; void caseTitle; void caseType; void description
  return {
    search_terms: [],
    facts: [],
    has_relevant_memory: false,
  }
}

// ── Deep resolver ───────────────────────────────────────────────────────

export interface DeepResolvedContext {
  /** Top-level trust marker: this context CONTAINS untrusted data from email
   *  threads and/or user memory. Before injecting any field into an LLM prompt,
   *  the planning slice MUST isolate fields tagged 'untrusted_external' or
   *  'user_generated' from system control fields (goal, policy, envelope,
   *  recipient). See §10.1 untrusted-data forward-flag contract. */
  _dataTrust: 'CONTAINS_UNTRUSTED_DATA'
  /** Number of events in the case history. */
  eventCount: number
  /** Last event type + reason, for context. */
  lastEventType: string | null
  lastEventReason: string | null
  /** Whether the case has a parent (linked). */
  hasParent: boolean
  /** Whether the case has child cases. */
  hasChildren: boolean
  /** Days since case creation. */
  ageDays: number
  /** Case sensitivity tier. */
  sensitivity: string
  /** Email thread resolution result, or null if no thread data available. */
  emailThread: EmailThreadResolution | null
  /** Memory lookup result. */
  memory: MemoryResolution
  /** Resolution audit trail (§10). */
  audit: ResolutionAudit
}

/** Resolve context for a case using all available internal-shadow sources.
 *
 *  Sources queried (in order):
 *    1. Case row + event history (DB-only, from Checkpoint B)
 *    2. Email thread history (email_processing / zst_email_processing)
 *    3. Domain-safe memory lookup (memories_fts)
 *
 *  Every source is recorded in the audit trail with what was attempted,
 *  what was found, and what (if anything) remains missing. */
export function resolveContextDeep(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  now: number,
): DeepResolvedContext {
  // ── Domain-scoped read guard (msg #20701 guardrail 1) ──
  // Every source read MUST be within the case's own domain. A PRI case reads
  // PRI email/memory ONLY; a ZST case reads ZST ONLY. Cross-domain reads ARE
  // cross-domain leakage — reads are how context and PII cross the boundary.
  domainGuard(db, domain, caseId, 'resolveContextDeep')

  const tableName = domain === 'personal' ? 'personal_cases' : 'zst_cases'
  const eventsTable = domain === 'personal' ? 'personal_case_events' : 'zst_case_events'

  // ── Source 1: Case row + events (DB-only) ──

  const caseRow = db.prepare(
    `SELECT title, case_type, description, status, sensitivity, parent_case_id, created_at
     FROM ${tableName} WHERE case_id = ?`,
  ).get(caseId) as {
    title: string; case_type: string; description: string | null; status: string
    sensitivity: string; parent_case_id: string | null; created_at: number
  } | undefined

  if (!caseRow) {
    throw new Error(`Case not found: ${domain}/${caseId}`)
  }

  const eventCount = (db.prepare(
    `SELECT count(*) as c FROM ${eventsTable} WHERE case_id = ?`,
  ).get(caseId) as { c: number }).c

  const lastEvent = db.prepare(
    // "The last thing that happened to this case" must not be the engine's own
    // note about the last time it looked (2026-08-12). The progression writes at
    // the END of its run, so without this filter the newest event on every
    // progression-enabled case is the engine describing itself, and the field
    // stops meaning what its name says.
    //
    // Inert today — `lastEventType` is carried into ProgressionContext and no
    // consumer reads it — which is exactly why it is worth fixing now: a wrong
    // value with no reader becomes a wrong value with a reader the moment
    // somebody uses the field, and nothing about that change would look risky.
    `SELECT event_type, reason FROM ${eventsTable}
      WHERE case_id = ? AND (source_system IS NULL OR source_system != 'progression')
      ORDER BY created_at DESC LIMIT 1`,
  ).get(caseId) as { event_type: string; reason: string | null } | undefined

  const childCount = (db.prepare(
    `SELECT count(*) as c FROM ${tableName} WHERE parent_case_id = ?`,
  ).get(caseId) as { c: number }).c

  const ageDays = Math.floor((now - caseRow.created_at) / 86400)

  // ── Source 2: Email thread ──

  const emailThread = resolveEmailThread(db, domain, caseId)

  // ── Source 3: Memory lookup ──

  const memory = resolveMemory(db, domain, caseRow.title, caseRow.case_type, caseRow.description)

  // ── Build audit trail ──

  const sources: ResolutionSource[] = []

  // Audit: case row + events
  sources.push({
    source: 'case_row',
    attempted: `Read case row and event history from ${tableName} + ${eventsTable}`,
    facts_found: [
      `Case title: ${caseRow.title}`,
      `Case type: ${caseRow.case_type}`,
      `Status: ${caseRow.status}`,
      `Sensitivity: ${caseRow.sensitivity}`,
      `Events: ${eventCount}`,
      `Age: ${ageDays}d`,
    ],
    remaining_gap: caseRow.status === 'INFORMATION_REQUIRED' || caseRow.status === 'INFO_REQUIRED'
      ? 'Case is in information-required status; case row alone cannot fill the gap'
      : 'Case status does not indicate missing information',
    why_blocking: (caseRow.status === 'INFORMATION_REQUIRED' || caseRow.status === 'INFO_REQUIRED')
      ? 'Information is explicitly required to proceed'
      : null,
    items_returned: 1,
    data_trust: 'system_internal',
  })

  // Audit: email thread
  const emailFacts: string[] = []
  if (emailThread.has_history) {
    emailFacts.push(`Found ${emailThread.messages.length} message(s) in thread(s): ${emailThread.thread_ids.join(', ')}`)
    for (const msg of emailThread.messages) {
      emailFacts.push(`Message ${msg.message_id} (status: ${msg.status}, case: ${msg.case_id ?? 'none'})`)
    }
  }
  sources.push({
    source: 'email_thread',
    attempted: `Query ${domain === 'personal' ? 'email_processing' : 'zst_email_processing'} for thread IDs ${emailThread.thread_ids.join(', ') || '(none)'}`,
    facts_found: emailFacts,
    remaining_gap: emailThread.has_history
      ? 'Thread history available — no blocking information gap from email source'
      : 'No thread history found; email source cannot fill information gaps',
    why_blocking: null,
    items_returned: emailThread.messages.length,
    data_trust: 'untrusted_external',
  })

  // Audit: memory — safe no-op for both domains (fleet-shared store is not
  // domain-scoped; per-domain memory namespace does not exist yet)
  sources.push({
    source: 'memory_fts',
    attempted: 'memory-source-not-domain-scoped-yet, skipped',
    facts_found: [],
    remaining_gap: 'Domain-scoped memory store not available — fleet-shared memories table has no domain/tenant/case column and would leak cross-domain/cross-agent content if searched',
    why_blocking: null,
    items_returned: 0,
    data_trust: 'user_generated',
  })

  const totalFacts = sources.reduce((sum, s) => sum + s.facts_found.length, 0)
  const hasBlockingGap = sources.some(s => s.why_blocking !== null)

  const audit: ResolutionAudit = {
    sources_attempted: sources,
    total_facts_found: totalFacts,
    has_blocking_gap: hasBlockingGap,
    summary: hasBlockingGap
      ? `Resolution found ${totalFacts} facts but has blocking gaps`
      : `Resolution found ${totalFacts} facts across ${sources.length} sources; no blocking gaps`,
  }

  return {
    _dataTrust: 'CONTAINS_UNTRUSTED_DATA',
    eventCount,
    lastEventType: lastEvent?.event_type ?? null,
    lastEventReason: lastEvent?.reason ?? null,
    hasParent: !!caseRow.parent_case_id,
    hasChildren: childCount > 0,
    ageDays,
    sensitivity: caseRow.sensitivity,
    emailThread: emailThread.has_history ? emailThread : null,
    memory,
    audit,
  }
}
