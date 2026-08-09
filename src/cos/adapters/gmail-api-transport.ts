// Personal Chief of Staff (COS) — real Gmail send transport (MailTransport).
//
// The live backing for GmailSendAdapter, used ONLY once marker persistence is
// proven (AC-26) and an outbound adapter is deliberately wired. It sends via the
// Gmail API with the account's write-scoped refresh token (gmail.send), and
// reads a sent message back by the idempotency marker.
//
// SEARCHABILITY (proven live 2026-08-06): Gmail does NOT preserve a caller-set
// Message-ID (so `rfc822msgid:` is out), and does NOT full-text-index custom
// headers (so the X-Marveen-Idempotency-Key header, while preserved, is not
// searchable). What IS searchable is the message BODY: a `COS-Ref: <marker>`
// footer line is found by full-text search within ~2s. So the searchable anchor
// is the body ref; the X-Marveen header rides along as machine-readable
// provenance for anything that fetches the full message.
//
// This module holds the send capability; nothing wires it into the autonomous
// loop by itself — that stays a separate, explicit owner decision.

import { readFileSync } from 'node:fs'
import type { MailTransport, OutboundEmail } from './gmail-send.js'
import { IDEMPOTENCY_HEADER } from './gmail-send.js'
import { TOOL_TIMEOUTS } from '../../tool-timeouts.js'

interface Creds { client_id: string; client_secret: string; refresh_token: string; token_uri: string }

/** The body footer that carries the searchable marker. */
export function bodyRefLine(marker: string): string {
  return `COS-Ref: ${marker}`
}

export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Build the base64url RFC822 message: To/Subject + the X-Marveen provenance
 *  header + the message body with the searchable COS-Ref footer. Pure/testable. */
/** RFC2047-encode a header value if it contains non-ASCII (e.g. a Hungarian
 *  subject). ASCII values pass through unchanged. Without this a non-ASCII
 *  Subject reaches the recipient as mojibake. */
export function encodeHeaderValue(v: string): string {
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7F]/.test(v) ? `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=` : v
}

export function buildRawMessage(email: OutboundEmail, marker: string, from?: string, embedMarker = true): string {
  // The searchable marker footer is embedded only when embedMarker is true. For
  // a customer-facing send where the owner approved the EXACT body, omit it so
  // what is sent equals what was approved (readback then reports unavailable →
  // the send rests at APPLIED_UNVERIFIED, confirmed instead by the returned id).
  const body = embedMarker ? `${email.body}\r\n\r\n${bodyRefLine(marker)}` : email.body
  const baseHeaders = [
    from ? `From: ${from}` : null,
    `To: ${email.to}`,
    `Subject: ${encodeHeaderValue(email.subject)}`,
    `${IDEMPOTENCY_HEADER}: ${marker}`,
    'MIME-Version: 1.0',
  ]

  if (email.attachments && email.attachments.length) {
    // multipart/mixed: text body part + one part per attachment (base64). Boundary
    // is deterministic from the marker (no RNG) so the build stays pure/testable.
    const boundary = `marveen_${marker.replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || 'part'}`
    const headers = [...baseHeaders, `Content-Type: multipart/mixed; boundary="${boundary}"`].filter(Boolean).join('\r\n')
    const parts: string[] = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
    ]
    for (const a of email.attachments) {
      // Re-wrap the base64 at 76 cols (RFC 2045) and use the standard alphabet.
      const b64 = a.contentBase64.replace(/\s+/g, '').replace(/(.{76})/g, '$1\r\n')
      parts.push(
        `--${boundary}`,
        `Content-Type: ${a.mimeType}; name="${a.filename.replace(/"/g, '')}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${a.filename.replace(/"/g, '')}"`,
        '',
        b64,
      )
    }
    parts.push(`--${boundary}--`, '')
    return base64url(Buffer.from(`${headers}\r\n\r\n${parts.join('\r\n')}`, 'utf8'))
  }

  const headers = [...baseHeaders, 'Content-Type: text/plain; charset="UTF-8"'].filter(Boolean).join('\r\n')
  return base64url(Buffer.from(`${headers}\r\n\r\n${body}`, 'utf8'))
}

export interface GmailApiTransportOptions {
  credsPath?: string
  /** Override the sender address (default: the account's own address). */
  from?: string
  /** Max ms to keep polling readback for a just-sent message (Gmail indexes the
   *  Message-ID with a short lag). 0 = single shot. */
  readbackWaitMs?: number
  /** Per-call HTTP deadline for send + token refresh (ms). Defaults to the
   *  registered gmail-send tool timeout. An abort surfaces as a send error the
   *  executor recovers from, rather than hanging the tick (gap-matrix #8). */
  sendTimeoutMs?: number
  /** Per-call HTTP deadline for the readback search (ms). */
  readbackTimeoutMs?: number
  /** Embed the searchable COS-Ref marker in the body (default true → crash-safe
   *  search readback). Set false for a customer email approved by the owner
   *  verbatim: the exact approved body is sent, and readback reports unavailable
   *  (the send rests at APPLIED_UNVERIFIED, confirmed by the returned message id). */
  embedBodyMarker?: boolean
}

export class GmailApiTransport implements MailTransport {
  private readonly credsPath: string
  private readonly from?: string
  private readonly readbackWaitMs: number
  private readonly sendTimeoutMs: number
  private readonly readbackTimeoutMs: number
  private readonly embedBodyMarker: boolean
  private token?: { value: string; expiresAt: number }

  constructor(opts: GmailApiTransportOptions = {}) {
    this.credsPath = opts.credsPath ?? 'store/.google-private-creds.json'
    this.from = opts.from
    this.readbackWaitMs = opts.readbackWaitMs ?? 0
    this.sendTimeoutMs = opts.sendTimeoutMs ?? TOOL_TIMEOUTS['gmail-send']
    this.readbackTimeoutMs = opts.readbackTimeoutMs ?? TOOL_TIMEOUTS['gmail-readback']
    this.embedBodyMarker = opts.embedBodyMarker ?? true
  }

  private creds(): Creds { return JSON.parse(readFileSync(this.credsPath, 'utf8')) as Creds }

  /** Short-lived access token from the refresh token, cached until ~1 min before expiry. */
  private async accessToken(nowMs: number): Promise<string> {
    if (this.token && this.token.expiresAt > nowMs + 60_000) return this.token.value
    const c = this.creds()
    const body = new URLSearchParams({
      client_id: c.client_id, client_secret: c.client_secret,
      refresh_token: c.refresh_token, grant_type: 'refresh_token',
    })
    const r = await fetch(c.token_uri, { method: 'POST', body, signal: AbortSignal.timeout(this.sendTimeoutMs) })
    if (!r.ok) throw new Error(`token refresh failed: ${r.status} ${await r.text()}`)
    const j = await r.json() as { access_token: string; expires_in: number }
    this.token = { value: j.access_token, expiresAt: nowMs + (j.expires_in ?? 3600) * 1000 }
    return j.access_token
  }

  async send(email: OutboundEmail): Promise<{ messageId: string }> {
    const marker = email.headers[IDEMPOTENCY_HEADER]
    if (!marker) throw new Error('outbound email missing idempotency marker header')
    const token = await this.accessToken(Date.now())
    const raw = buildRawMessage(email, marker, this.from, this.embedBodyMarker)
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(this.sendTimeoutMs),
    })
    if (!r.ok) throw new Error(`gmail send failed: ${r.status} ${await r.text()}`)
    const j = await r.json() as { id: string }
    return { messageId: j.id }
  }

  /** Find a sent message by the marker → full-text search the body ref in Sent.
   *  `available` is false only when the search itself could not run (network/
   *  auth), so a transient failure is never misread as "the message is absent". */
  async findSentByHeader(name: string, value: string): Promise<{ found: boolean; messageId?: string; available?: boolean }> {
    if (name !== IDEMPOTENCY_HEADER) return { found: false }
    // No searchable marker was embedded → we cannot search-confirm. Report
    // UNAVAILABLE (never "absent") so the executor keeps the send at
    // APPLIED_UNVERIFIED instead of false-alarming RECOVERY_REQUIRED.
    if (!this.embedBodyMarker) return { found: false, available: false }
    const q = `in:sent "${bodyRefLine(value)}"`
    const deadline = Date.now() + this.readbackWaitMs
    for (;;) {
      try {
        const token = await this.accessToken(Date.now())
        const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=1`
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(this.readbackTimeoutMs) })
        if (!r.ok) return { found: false, available: false }
        const j = await r.json() as { messages?: Array<{ id: string }> }
        const hit = j.messages?.[0]
        if (hit) return { found: true, messageId: hit.id, available: true }
        if (Date.now() >= deadline) return { found: false, available: true }
      } catch {
        return { found: false, available: false }
      }
      await new Promise(res => setTimeout(res, 2000)) // indexing lag: brief poll
    }
  }
}
