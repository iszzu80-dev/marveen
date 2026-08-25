#!/usr/bin/env npx tsx
/**
 * W10 — re-measure what the external credentials are actually allowed to do, and
 * compare it to what `external-capability-inventory.ts` claims.
 *
 * Istvan's HYBRID EXTERNAL ACTION BOUNDARY decision (2026-08-25) permits direct
 * read-only external access on four conditions, the first of which is that the
 * credential is PROVABLY read-only. "Provably" is the load-bearing word: a
 * read-only claim nobody can check is worse than no claim, because it is
 * believed. This script is the check.
 *
 * It asks the PROVIDER, not this repository. Google's tokeninfo endpoint returns
 * the scopes actually attached to a token, so the answer cannot be wrong in the
 * way a comment can be wrong -- and on its first run it falsified two
 * long-standing comments in this codebase.
 *
 * READ-ONLY BY CONSTRUCTION. It refreshes a token and reads its scope list. It
 * calls no Gmail, Calendar or Drive method, and it prints no token, no client
 * secret and no refresh token -- only scope strings, which are public API names.
 *
 * Exit codes:
 *   0  inventory matches the provider
 *   1  drift: a scope the inventory claims is missing, or a WRITE scope is
 *      attached to a credential the inventory calls read-only
 *   2  could not measure (network, revoked token) -- NOT the same as "fine"
 */
import { readFileSync, existsSync } from 'node:fs'
import {
  EXTERNAL_CAPABILITIES, connectorsWithScopeGaps,
} from '../src/identity/external-capability-inventory.js'

/** Scopes that can change something at the provider. Anything not here is
 *  treated as a read scope only if it ENDS in `.readonly`, so a new write scope
 *  Google invents next year is not silently classified as harmless. */
const KNOWN_WRITE_SCOPES = [
  'gmail.send', 'gmail.modify', 'gmail.compose', 'gmail.insert', 'gmail.labels',
  'calendar.events', 'calendar', 'drive.file', 'drive', 'spreadsheets',
]

function isWriteScope(scope: string): boolean {
  const leaf = scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, '')
  if (leaf.endsWith('.readonly')) return false
  return KNOWN_WRITE_SCOPES.includes(leaf) || !leaf.includes('readonly')
}

async function scopesFor(credsPath: string): Promise<string[]> {
  const c = JSON.parse(readFileSync(credsPath, 'utf8')) as {
    client_id: string; client_secret: string; refresh_token: string; token_uri: string
  }
  const body = new URLSearchParams({
    client_id: c.client_id, client_secret: c.client_secret,
    refresh_token: c.refresh_token, grant_type: 'refresh_token',
  })
  const t = await fetch(c.token_uri, { method: 'POST', body, signal: AbortSignal.timeout(30_000) })
  if (!t.ok) throw new Error(`token refresh failed: ${t.status}`)
  const tok = await t.json() as { access_token: string }
  const r = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(tok.access_token)}`,
    { signal: AbortSignal.timeout(30_000) })
  if (!r.ok) throw new Error(`tokeninfo failed: ${r.status}`)
  const info = await r.json() as { scope?: string }
  return (info.scope ?? '').split(/\s+/).filter(Boolean).map(s =>
    s.replace(/^https:\/\/www\.googleapis\.com\/auth\//, ''))
}

const problems: string[] = []
const report: Record<string, unknown> = { at: new Date().toISOString() }

// One measurement per credential FILE, not per connector: several connectors
// share a credential, and asking the provider four times for the same token
// would be four chances to get four different answers to one question.
const credFiles = new Set<string>()
for (const e of EXTERNAL_CAPABILITIES) for (const f of e.credentialFiles) credFiles.add(f)

const measured: Record<string, string[]> = {}
for (const f of credFiles) {
  if (!existsSync(f)) { problems.push(`credential file missing: ${f}`); continue }
  try {
    measured[f] = await scopesFor(f)
  } catch (e) {
    // Could not measure is NOT the same as measured-and-fine, and must not exit 0.
    problems.push(`could not measure ${f}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
report.measured = measured

for (const e of EXTERNAL_CAPABILITIES) {
  if (!e.credentialFiles.length) continue // bot tokens have no introspection endpoint
  const seen = new Set(e.credentialFiles.flatMap(f => measured[f] ?? []))
  if (!seen.size) continue

  for (const claimed of e.grantedScopes) {
    if (!seen.has(claimed)) {
      problems.push(`${e.id}: inventory claims scope '${claimed}' which the provider does not grant on ${e.credentialFiles.join(' / ')}`)
    }
  }
  // A connector declared read-only must USE only read scopes. This is a claim
  // about the scopes it rides on, not about the whole token -- see the
  // unaccounted-write check below for the risk a shared token actually carries.
  if (e.readOnly) {
    const writes = e.grantedScopes.filter(isWriteScope)
    if (writes.length) {
      problems.push(`${e.id}: declared read-only but its own scopes include WRITE [${writes.join(', ')}]`)
    }
  }
}

// THE CHECK THAT MATTERS MOST, and the one a per-connector view cannot make.
//
// Several connectors share one Google credential, so the token is only as
// harmless as its WIDEST scope. A write scope attached to that token and claimed
// by NO inventory entry is a capability this system holds and has not declared --
// exactly the thing the inventory exists to make impossible. Note what this does
// NOT say: a declared write scope (calendar.events, claimed by gcal.write) is
// fine. The defect is the undeclared one.
for (const [file, scopes] of Object.entries(measured)) {
  const claimedHere = new Set(
    EXTERNAL_CAPABILITIES.filter(e => e.credentialFiles.includes(file)).flatMap(e => [...e.grantedScopes]))
  const unaccounted = scopes.filter(sc => isWriteScope(sc) && !claimedHere.has(sc))
  if (unaccounted.length) {
    problems.push(
      `${file}: holds WRITE scopes no inventory entry declares: [${unaccounted.join(', ')}]. `
      + 'An undeclared capability is one the broker cannot gate, because nothing tells it the connector exists.')
  }
}

const gaps = connectorsWithScopeGaps()
report.declaredScopeGaps = gaps.map(g => ({ id: g.id, gap: g.scopeGap }))
report.problems = problems

console.log(JSON.stringify(report, null, 1))
if (problems.some(p => p.startsWith('could not measure'))) process.exit(2)
process.exit(problems.length ? 1 : 0)
