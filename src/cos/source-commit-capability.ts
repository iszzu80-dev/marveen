// Can we actually write the source mark? Measure it. Do not assume it.
//
// INCIDENT 2026-08-31, and the reason this file exists.
//
// `cos-close-batches.ts` chose between the real GmailLabelCommitter and the
// honest NoSourceWriteCommitter like this:
//
//     const committer = existsSync(credsPath) ? new GmailLabelCommitter(...) : ...
//
// The comment above it was proud of that: "the choice is made from the CREDS
// FILE's presence, not from a flag someone has to remember to flip". The
// intention was right and the instrument was wrong. A file's presence is not a
// capability; it is a proxy for one, and the proxy went stale the moment the
// token behind the file changed shape.
//
// It did. Istvan granted `gmail.modify` on 2026-08-11 and the labelling worked
// until 08-17. The re-auths of 08-18 and 08-25 ran with a read-only scope list,
// and an OAuth consent does not merge -- what you do not ask for, it takes away.
// The file was still there, so the writer was still chosen, so every label call
// returned 403 `insufficient authentication scopes`, so thirteen real messages
// sat at LOCAL_APPLIED and thirteen batches stayed open and the mailbox cursor
// did not move for two weeks. Nothing anywhere said "scope". The only sentence
// the system could produce was "a koteg nem minden eleme terminalis", which is
// true of every open batch and therefore evidence of nothing.
//
// So: ask the provider what it granted, and let the answer decide.
//
// THREE ANSWERS, NOT TWO. The third one is the point.
//   CAPABLE    the scope is granted -> use the real committer.
//   INCAPABLE  measured, and the scope is absent -> the no-write committer, on
//              the owner's audited policy, with the MEASURED reason on the row.
//   UNKNOWN    we could not measure (network, unreadable creds, dead refresh
//              token) -> close NOTHING this run. We do not know whether the
//              mark is possible, and "unknown" must not be spent as "cannot":
//              terminalising a message as SOURCE_COMMIT_SKIPPED is irreversible
//              in the sense that matters -- the label never gets written and the
//              cursor has already passed. A batch left open is a visible wait; a
//              batch skipped on a guess is an invisible loss.

import { readFileSync } from 'node:fs'

/** The scope a `messages.modify` label write requires. */
export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'

export type SourceWriteVerdict = 'CAPABLE' | 'INCAPABLE' | 'UNKNOWN'

export interface SourceWriteCapability {
  verdict: SourceWriteVerdict
  /** Exactly what the provider said it granted. Empty when UNKNOWN. */
  scopes: readonly string[]
  /** Why, in one line. Never empty: an unexplained verdict is how a gap hides. */
  reason: string
}

interface Creds { client_id: string; client_secret: string; refresh_token: string; token_uri: string }

/**
 * Ask the token endpoint what this refresh token actually carries.
 *
 * The `scope` field of a refresh response is the authoritative granted-scope
 * list. It costs nothing extra: the label write has to mint an access token
 * anyway, so this is the same call the committer would make on its first
 * message, made once, before we decide who the committer is.
 *
 * Deliberately NOT read from the creds file -- that file has never had a scope
 * field, and inventing one would put a second, drifting copy of the truth next
 * to the real one.
 */
export async function probeSourceWriteCapability(
  credsPath: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<SourceWriteCapability> {
  const f = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 30_000

  let creds: Creds
  try {
    creds = JSON.parse(readFileSync(credsPath, 'utf8')) as Creds
  } catch (e) {
    return { verdict: 'UNKNOWN', scopes: [], reason: `a hitelesito fajl nem olvashato (${credsPath}): ${(e as Error).message}` }
  }
  if (!creds?.refresh_token || !creds?.token_uri) {
    return { verdict: 'UNKNOWN', scopes: [], reason: `a hitelesito fajlbol hianyzik a refresh_token vagy a token_uri (${credsPath})` }
  }

  let granted: string
  try {
    const body = new URLSearchParams({
      client_id: creds.client_id, client_secret: creds.client_secret,
      refresh_token: creds.refresh_token, grant_type: 'refresh_token',
    })
    const r = await f(creds.token_uri, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) {
      return { verdict: 'UNKNOWN', scopes: [], reason: `a token-frissites nem sikerult: HTTP ${r.status}` }
    }
    const j = await r.json() as { scope?: string }
    // A refresh response without a scope field is not an empty grant, it is an
    // unanswered question. Treating "" as "no scopes" would turn a provider
    // quirk into a policy decision about somebody's mailbox.
    if (typeof j.scope !== 'string' || j.scope.trim() === '') {
      return { verdict: 'UNKNOWN', scopes: [], reason: 'a token-valasz nem tartalmazott scope mezot, a jogok nem allapithatok meg' }
    }
    granted = j.scope
  } catch (e) {
    return { verdict: 'UNKNOWN', scopes: [], reason: `a jogok merese nem sikerult: ${(e as Error).message}` }
  }

  const scopes = granted.split(/\s+/).filter(Boolean).sort()
  if (scopes.includes(GMAIL_MODIFY_SCOPE)) {
    return { verdict: 'CAPABLE', scopes, reason: 'a token hordozza a gmail.modify jogot, a forras-jeloles elvegezheto' }
  }
  return {
    verdict: 'INCAPABLE',
    scopes,
    // The measured list, in the reason. The old policy file carried a sentence
    // written in 2026-08-09 ("a token csak gmail.send jogot hordoz") that was
    // still being copied onto rows in 2026-08-31, by which time it named a scope
    // the token had not had for weeks. A reason that is typed once and repeated
    // forever is a date stamp pretending to be a measurement.
    reason: `a token NEM hordozza a gmail.modify jogot, ezert a COS/Processed cimke nem irhato fel; mert jogok: ${scopes.join(' ') || '(nincs)'}`,
  }
}
