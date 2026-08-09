// CostOps Phase 4 -- weekly market watch: fetch -> normalize -> hash -> diff -> change event.
//
// This module is the deterministic core ONLY. It contains no network call, no
// subprocess, no exec, and no LLM/model call anywhere -- the structural test
// below proves that by scanning the source, not by trusting a convention.
// "fetch" is an injected function the caller supplies (see runMarketWatchCycle);
// this module never decides how a snapshot is obtained. Today WebFetch is
// blocked for the relevant vendor domains (see
// docs/optimization/phase4-market-snapshot-2026-07-30.md), so in practice a
// fetcher reads a WebSearch-gathered snapshot file -- that acquisition method
// is an operational concern outside this module's scope.
//
// Cache-by-hash: a re-fetch that normalizes to the same content hash as the
// previous cycle is a no-op -- no event, and (by construction, since this
// module never calls a model) no possibility of an LLM call either. Only a
// genuine content change produces a MarketChangeEvent, carrying exactly the
// added/removed/changed entries plus each entry's own source_url and
// read_date, so a downstream summarizer (if one is ever built) sees precisely
// what changed and where it came from -- never the whole snapshot repeated.

// ---- normalized shape --------------------------------------------------------

export interface MarketPricePoint {
  /** Stable composite id: `${provider}/${group-path}/${package-or-model}`. */
  key: string
  provider: string
  group_path: string
  package: string
  source_url: string | null
  read_date: string | null
  /** Canonical (sorted-key) JSON of the raw leaf entry -- the unit that hashes. */
  fingerprint: string
}

export interface NormalizedMarketSnapshot {
  snapshot_date: string | null
  read_date: string | null
  entries: MarketPricePoint[] // sorted by key, always
}

// ---- deterministic stable stringify -----------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`
}

// ---- normalize ----------------------------------------------------------------

function isLeafPricingEntry(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const rec = v as Record<string, unknown>
  return typeof rec.package === 'string' || typeof rec.model === 'string'
}

/**
 * Walks `raw.providers` (the shape of store/market-snapshot-*.json) and
 * collects every leaf pricing entry (identified by having a `package` or
 * `model` string field) into a flat, key-sorted list. Unknown/malformed input
 * degrades to an empty entry list rather than throwing -- this is read-only
 * market data, not a gate the phase depends on for correctness elsewhere.
 */
export function normalizeMarketSnapshot(raw: unknown): NormalizedMarketSnapshot {
  const entries: MarketPricePoint[] = []
  const root = (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {})
  const meta = (root.meta && typeof root.meta === 'object' ? root.meta as Record<string, unknown> : {})
  const providers = (root.providers && typeof root.providers === 'object' ? root.providers as Record<string, unknown> : {})

  function walk(provider: string, groupPath: string, node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) {
        if (isLeafPricingEntry(item)) {
          const name = String(item.package ?? item.model)
          const key = `${provider}/${groupPath}/${name}`
          entries.push({
            key,
            provider,
            group_path: groupPath,
            package: name,
            source_url: typeof item.source_url === 'string' ? item.source_url : null,
            read_date: typeof item.read_date === 'string' ? item.read_date : null,
            fingerprint: stableStringify(item),
          })
        } else if (item && typeof item === 'object') {
          walk(provider, groupPath, item)
        }
      }
      return
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(provider, groupPath ? `${groupPath}.${k}` : k, v)
      }
    }
  }

  for (const [provider, node] of Object.entries(providers)) {
    walk(provider, '', node)
  }

  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  return {
    snapshot_date: typeof meta.snapshot_date === 'string' ? meta.snapshot_date : null,
    read_date: typeof meta.read_date === 'string' ? meta.read_date : null,
    entries,
  }
}

// ---- hash -----------------------------------------------------------------

/**
 * A pure, dependency-free FNV-1a hash over the normalized snapshot's stable
 * JSON form. Not cryptographic -- this is a change-detection cache key, not a
 * security boundary, so a fast deterministic hash is the right tool and keeps
 * this module free of any imports beyond plain JS.
 */
export function hashSnapshot(normalized: NormalizedMarketSnapshot): string {
  const s = stableStringify(normalized)
  let h1 = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i)
    h1 = Math.imul(h1, 0x01000193)
  }
  return (h1 >>> 0).toString(16).padStart(8, '0')
}

// ---- diff / change event ------------------------------------------------------

export interface MarketEntryChange {
  key: string
  provider: string
  package: string
  source_url: string | null
  read_date: string | null
  previous_fingerprint: string
  new_fingerprint: string
}

export interface MarketChangeEvent {
  detected_at: number // epoch sec -- caller-supplied, never Date.now() inside this pure module
  previous_hash: string | null
  new_hash: string
  added: MarketPricePoint[]
  removed: MarketPricePoint[]
  changed: MarketEntryChange[]
}

/**
 * Diffs two normalized snapshots by entry key. Returns null when nothing
 * differs by key/fingerprint (the hash-unchanged no-op case is handled one
 * level up in runMarketWatchCycle, before this is even called).
 */
export function diffSnapshots(
  previous: NormalizedMarketSnapshot | null,
  next: NormalizedMarketSnapshot,
  previousHash: string | null,
  newHash: string,
  detectedAt: number,
): MarketChangeEvent {
  const prevByKey = new Map((previous?.entries ?? []).map(e => [e.key, e]))
  const nextByKey = new Map(next.entries.map(e => [e.key, e]))

  const added: MarketPricePoint[] = []
  const changed: MarketEntryChange[] = []
  for (const [key, entry] of nextByKey) {
    const prevEntry = prevByKey.get(key)
    if (!prevEntry) {
      added.push(entry)
    } else if (prevEntry.fingerprint !== entry.fingerprint) {
      changed.push({
        key,
        provider: entry.provider,
        package: entry.package,
        source_url: entry.source_url,
        read_date: entry.read_date,
        previous_fingerprint: prevEntry.fingerprint,
        new_fingerprint: entry.fingerprint,
      })
    }
  }

  const removed: MarketPricePoint[] = []
  for (const [key, entry] of prevByKey) {
    if (!nextByKey.has(key)) removed.push(entry)
  }

  return { detected_at: detectedAt, previous_hash: previousHash, new_hash: newHash, added, removed, changed }
}

// ---- cycle orchestration -------------------------------------------------------

export interface MarketWatchCache {
  hash: string
  normalized: NormalizedMarketSnapshot
}

export interface MarketWatchCycleResult {
  hash: string
  normalized: NormalizedMarketSnapshot
  changed: boolean
  /** Non-null exactly when `changed` is true. */
  event: MarketChangeEvent | null
}

/**
 * fetch -> normalize -> hash -> diff -> change event, in one deterministic
 * pass. `fetchSnapshot` is caller-supplied (see module header) and
 * `detectedAt` is caller-supplied (epoch sec) rather than read from the
 * clock in here, so this whole cycle stays a pure function of its inputs --
 * same inputs, same output, every time (see the repeat-run test).
 *
 * A null `previous` cache (first-ever run) still produces a change event --
 * everything is "new" relative to no prior observation -- which is the
 * correct baseline to record, not a special no-op case.
 */
export function runMarketWatchCycle(
  fetchSnapshot: () => unknown,
  previous: MarketWatchCache | null,
  detectedAt: number,
): MarketWatchCycleResult {
  const raw = fetchSnapshot()
  const normalized = normalizeMarketSnapshot(raw)
  const hash = hashSnapshot(normalized)

  if (previous && previous.hash === hash) {
    return { hash, normalized, changed: false, event: null }
  }

  const event = diffSnapshots(previous?.normalized ?? null, normalized, previous?.hash ?? null, hash, detectedAt)
  return { hash, normalized, changed: true, event }
}