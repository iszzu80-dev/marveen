// Personal Chief of Staff (COS) — reading the whole thread (§8).
//
// The spec's inbound step is "teljes thread + Scope Gate + delta + case-match".
// What the intake actually receives is a 300-character snippet, so the case
// type, title and sensitivity are all decided from a preview. On 2026-08-09 the
// GLS notice carried the parcel number in its body; the case got the preview,
// and when the number was needed it had to be fetched by hand from Gmail.
//
// Deliberately NOT in the synchronous intake path. Making case creation depend
// on a network round-trip would tie the seam's reliability to Gmail's, and an
// intake that fails when the network hiccups loses mail — the exact failure the
// whole chain is built to avoid. This runs afterwards, from the case-wake job,
// and a case simply carries its thread a few minutes later than its title.
//
// Read-only against Gmail. Uses the same credentials file as the send adapter,
// so there is one credential path, not two.

import { readFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { storeDocument } from './cos-documents.js'

interface Creds { client_id: string; client_secret: string; refresh_token: string; token_uri: string }

export interface ThreadMessage {
  id: string
  from: string
  to: string
  date: string
  subject: string
  body: string
}

export interface GmailThreadReaderOptions {
  credsPath?: string
  timeoutMs?: number
}

/** Reads a full Gmail thread. Separate from GmailApiTransport because that class
 *  is the WRITE surface: mixing read and write in one object makes it easy to
 *  hand a send-capable thing to code that only needs to look. */
export class GmailThreadReader {
  private readonly credsPath: string
  private readonly timeoutMs: number
  private token?: { value: string; expiresAt: number }

  constructor(opts: GmailThreadReaderOptions = {}) {
    this.credsPath = opts.credsPath ?? 'store/.google-private-creds.json'
    this.timeoutMs = opts.timeoutMs ?? 20_000
  }

  private async accessToken(nowMs: number): Promise<string> {
    if (this.token && this.token.expiresAt > nowMs + 60_000) return this.token.value
    const c = JSON.parse(readFileSync(this.credsPath, 'utf8')) as Creds
    const r = await fetch(c.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: c.client_id, client_secret: c.client_secret,
        refresh_token: c.refresh_token, grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!r.ok) throw new Error(`token refresh failed: ${r.status}`)
    const j = await r.json() as { access_token: string; expires_in: number }
    this.token = { value: j.access_token, expiresAt: nowMs + j.expires_in * 1000 }
    return j.access_token
  }

  async fetchThread(threadId: string): Promise<ThreadMessage[]> {
    const tok = await this.accessToken(Date.now())
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
      { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(this.timeoutMs) },
    )
    if (!r.ok) throw new Error(`thread fetch failed: ${r.status}`)
    const j = await r.json() as { messages?: Array<Record<string, unknown>> }
    return (j.messages ?? []).map((m) => decodeMessage(m))
  }
}

function header(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

/** Walk the MIME tree for text/plain; fall back to the top-level body. Exported
 *  so it can be tested without a network. */
export function decodeMessage(m: Record<string, unknown>): ThreadMessage {
  const payload = (m.payload ?? {}) as Record<string, unknown>
  const headers = (payload.headers ?? []) as Array<{ name: string; value: string }>
  let text = ''
  const stack: Array<Record<string, unknown>> = [payload]
  while (stack.length) {
    const p = stack.pop()!
    if (p.mimeType === 'text/plain') text += decodePart(p)
    for (const sub of ((p.parts ?? []) as Array<Record<string, unknown>>)) stack.push(sub)
  }
  if (!text) text = decodePart(payload)
  return {
    id: String(m.id ?? ''), from: header(headers, 'From'), to: header(headers, 'To'),
    date: header(headers, 'Date'), subject: header(headers, 'Subject'), body: text,
  }
}

function decodePart(p: Record<string, unknown>): string {
  const body = (p.body ?? {}) as { data?: string }
  if (!body.data) return ''
  try {
    return Buffer.from(body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  } catch { return '' }
}

/** Render a thread as the plain text a human would want to read. */
export function renderThread(messages: ThreadMessage[]): string {
  return messages.map((m, i) => [
    `--- ${i + 1}/${messages.length} ---`,
    `Feladó: ${m.from}`, `Címzett: ${m.to}`, `Dátum: ${m.date}`, `Tárgy: ${m.subject}`,
    '', m.body.trim(),
  ].join('\n')).join('\n\n')
}

/** Records a failed fetch so it is not retried forever. A runner that retries a
 *  permanently-broken id every ten minutes produces a failure line every ten
 *  minutes, and a failure line that always appears stops being read — which is
 *  how the real one gets missed. */
export function recordThreadFetchFailure(
  db: Database.Database, caseId: string, threadId: string, reason: string, now: number,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cos_thread_fetch_failures (
      case_id    TEXT NOT NULL,
      thread_id  TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (case_id, thread_id)
    )
  `)
  db.prepare(
    `INSERT INTO cos_thread_fetch_failures (case_id, thread_id, attempts, last_error, updated_at)
     VALUES (@c, @t, 1, @e, @now)
     ON CONFLICT(case_id, thread_id) DO UPDATE SET
       attempts = attempts + 1, last_error = @e, updated_at = @now`
  ).run({ c: caseId, t: threadId, e: reason.slice(0, 300), now })
}

/** Attempts after which a thread is left alone. */
export const THREAD_FETCH_MAX_ATTEMPTS = 3

export interface StoreThreadResult {
  stored: boolean
  messages: number
  reason: string
  documentId?: string
}

/**
 * Fetch a case's thread and file it as a document on the case.
 *
 * Sensitivity is left to the store's default rather than asserted here. A full
 * mail thread can contain anything, and guessing "PERSONAL" on a body nobody has
 * read is exactly the kind of confident wrong answer the sensitivity policy
 * exists to prevent — the store's fail-closed default is the honest one.
 */
export async function storeCaseThread(
  db: Database.Database,
  reader: Pick<GmailThreadReader, 'fetchThread'>,
  caseId: string,
  threadId: string,
  namespace: 'personal' | 'zst' = 'personal',
  now: number = Math.floor(Date.now() / 1000),
): Promise<StoreThreadResult> {
  let messages: ThreadMessage[]
  try {
    messages = await reader.fetchThread(threadId)
  } catch (e) {
    // A failed fetch must never damage the case. The thread arrives later or
    // not at all; the case is unaffected either way.
    return { stored: false, messages: 0, reason: `a szál nem tölthető le: ${(e as Error).message}` }
  }
  if (!messages.length) return { stored: false, messages: 0, reason: 'a szál üres' }

  const text = renderThread(messages)
  const doc = storeDocument(db, {
    namespace, caseId, source: 'email' as never, sourceRef: threadId,
    filename: `thread-${threadId}.txt`, mimeType: 'text/plain',
    bytes: Buffer.from(text, 'utf8'), docKind: 'email_thread',
  }, { now })
  return { stored: true, messages: messages.length, reason: `${messages.length} üzenet eltárolva`, documentId: (doc as { documentId?: string }).documentId }
}

/** Cases that have a thread id but no stored thread document yet. */
export function casesMissingThreadText(
  db: Database.Database, limit = 20,
): Array<{ case_id: string; thread_id: string }> {
  try {
    return db.prepare(
      `SELECT c.case_id, json_extract(c.gmail_thread_ids, '$[0]') AS thread_id
       FROM personal_cases c
       WHERE c.gmail_thread_ids IS NOT NULL AND c.archived_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM cos_documents d
           WHERE d.case_id = c.case_id AND d.doc_kind = 'email_thread')
         -- and not one we have already given up on
         AND NOT EXISTS (
           SELECT 1 FROM cos_thread_fetch_failures f
           WHERE f.case_id = c.case_id AND f.attempts >= ${THREAD_FETCH_MAX_ATTEMPTS})
       ORDER BY c.updated_at DESC LIMIT ?`
    ).all(limit) as never
  } catch {
    // The failures table may not exist yet on a fresh install; fall back to the
    // unfiltered query rather than returning nothing, because "no candidates"
    // and "cannot tell" must not look the same.
    try {
      return db.prepare(
        `SELECT c.case_id, json_extract(c.gmail_thread_ids, '$[0]') AS thread_id
         FROM personal_cases c
         WHERE c.gmail_thread_ids IS NOT NULL AND c.archived_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM cos_documents d
             WHERE d.case_id = c.case_id AND d.doc_kind = 'email_thread')
         ORDER BY c.updated_at DESC LIMIT ?`
      ).all(limit) as never
    } catch { return [] }
  }
}

/** Threads we stopped trying to fetch, so the give-up is inspectable rather
 *  than just an absence. */
export function abandonedThreadFetches(
  db: Database.Database,
): Array<{ case_id: string; thread_id: string; attempts: number; last_error: string }> {
  try {
    return db.prepare(
      `SELECT case_id, thread_id, attempts, last_error FROM cos_thread_fetch_failures
       WHERE attempts >= ? ORDER BY updated_at DESC`
    ).all(THREAD_FETCH_MAX_ATTEMPTS) as never
  } catch { return [] }
}
