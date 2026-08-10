import { describe, it, expect } from 'vitest'
import { buildRawMessage, bodyRefLine, base64url } from '../cos/adapters/gmail-api-transport.js'
import { IDEMPOTENCY_HEADER, type OutboundEmail } from '../cos/adapters/gmail-send.js'

// The real Gmail transport's message construction (pure part). The live send +
// readback round-trip (AC-26) is proven out-of-band against the real account —
// Gmail strips a caller Message-ID and does not full-text-index custom headers,
// so the searchable marker lives in the body (COS-Ref), verified live 2026-08-06.

const EMAIL: OutboundEmail = {
  to: 'vendor@example.com', subject: 'Quote request', body: 'Please send a quote.',
  headers: { [IDEMPOTENCY_HEADER]: 'mv-c1-EMAIL_SEND-1' },
}

function decode(rawUrl: string): string {
  const b64 = rawUrl.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('utf8')
}

describe('GmailApiTransport message construction', () => {
  it('embeds the searchable marker in the BODY (not just a header)', () => {
    const raw = decode(buildRawMessage(EMAIL, 'mv-c1-EMAIL_SEND-1', 'me@gmail.com'))
    expect(raw).toContain('COS-Ref: mv-c1-EMAIL_SEND-1')          // searchable body ref
    expect(raw).toContain(`${IDEMPOTENCY_HEADER}: mv-c1-EMAIL_SEND-1`) // provenance header
    expect(raw).toContain('To: vendor@example.com')
    expect(raw).toContain('Subject: Quote request')
    expect(raw).toContain('From: me@gmail.com')
    expect(raw).toContain('Please send a quote.')                 // original body preserved
    // header block is separated from the body
    expect(raw.indexOf('Please send a quote.')).toBeGreaterThan(raw.indexOf('Content-Type'))
  })

  it('bodyRefLine is the deterministic searchable footer', () => {
    expect(bodyRefLine('mv-x-1')).toBe('COS-Ref: mv-x-1')
  })

  it('RFC2047-encodes a non-ASCII subject (no mojibake); ASCII passes through', () => {
    const raw = decode(buildRawMessage({ ...EMAIL, subject: 'RE: törött WPC – árajánlat' }, 'mv-x-1', 'me@gmail.com'))
    expect(raw).toContain('Subject: =?UTF-8?B?')       // encoded
    expect(raw).not.toContain('Subject: RE: törött')   // not raw non-ASCII
    const ascii = decode(buildRawMessage(EMAIL, 'mv-x-1', 'me@gmail.com'))
    expect(ascii).toContain('Subject: Quote request')  // ASCII unchanged
  })

  it('embedMarker=false sends the EXACT body (no COS-Ref footer) — for owner-approved customer mail', () => {
    const raw = decode(buildRawMessage(EMAIL, 'mv-c1-EMAIL_SEND-1', 'me@gmail.com', false))
    expect(raw).not.toContain('COS-Ref')                 // nothing appended
    expect(raw).toContain('Please send a quote.')        // exactly the approved body
    expect(raw.trimEnd().endsWith('Please send a quote.')).toBe(true)
  })

  it('From is omitted when not provided (Gmail fills the account address)', () => {
    const raw = decode(buildRawMessage(EMAIL, 'mv-x-1'))
    expect(raw).not.toContain('From:')
  })

  it('base64url has no +/=/ padding chars', () => {
    const out = base64url(Buffer.from('\xff\xff\xff\xfe', 'binary'))
    expect(out).not.toMatch(/[+/=]/)
  })
})

// ── Threading (card 169fca9b) ─────────────────────────────────────────────
//
// Added 2026-08-10, the morning after the first real corporate send went out
// as a NEW CONVERSATION instead of a reply. The subject began with "Re:", so it
// looked like a reply from our side and arrived in the lawyer's mailbox as an
// unrelated message. The cause: the type promised
// `headers: Record<string, string>` and the builder wrote exactly one of them.
//
// Each test below fails against the code as it stood at the moment of that send.
describe('reply threading', () => {
  const PARENT = '<CAF=abc123@mail.gmail.com>'

  it('emits In-Reply-To and References when the caller supplies them', () => {
    const raw = decode(buildRawMessage(
      { ...EMAIL, headers: { ...EMAIL.headers, 'In-Reply-To': PARENT, References: PARENT } },
      'mv-c1-EMAIL_SEND-1', 'me@zstradio.com'))
    expect(raw).toContain(`In-Reply-To: ${PARENT}`)
    expect(raw).toContain(`References: ${PARENT}`)
  })

  it('emits neither when the caller supplies neither — a first approach is a new thread', () => {
    const raw = decode(buildRawMessage(EMAIL, 'mv-c1-EMAIL_SEND-1', 'me@zstradio.com'))
    expect(raw).not.toContain('In-Reply-To:')
    expect(raw).not.toContain('References:')
  })

  it('accepts the header name in any case — a caller writing in-reply-to means the same thing', () => {
    const raw = decode(buildRawMessage(
      { ...EMAIL, headers: { ...EMAIL.headers, 'in-reply-to': PARENT } },
      'mv-c1-EMAIL_SEND-1'))
    expect(raw).toContain(`In-Reply-To: ${PARENT}`)
  })

  it('ignores a blank value rather than emitting an empty header', () => {
    const raw = decode(buildRawMessage(
      { ...EMAIL, headers: { ...EMAIL.headers, 'In-Reply-To': '   ' } },
      'mv-c1-EMAIL_SEND-1'))
    expect(raw).not.toContain('In-Reply-To:')
  })

  it('does NOT pass through headers outside the allowlist', () => {
    // The body is owner-approved text; the headers are not. A caller able to
    // set any header could set Bcc, Reply-To or From on an approved message.
    const raw = decode(buildRawMessage(
      { ...EMAIL, headers: { ...EMAIL.headers, Bcc: 'someone@else.com', 'Reply-To': 'attacker@evil.com' } },
      'mv-c1-EMAIL_SEND-1'))
    expect(raw).not.toContain('Bcc:')
    expect(raw).not.toContain('Reply-To:')
  })

  it('threads an attachment mail too, not only the plain-text one', () => {
    const raw = decode(buildRawMessage(
      {
        ...EMAIL,
        headers: { ...EMAIL.headers, 'In-Reply-To': PARENT },
        attachments: [{ filename: 'a.txt', mimeType: 'text/plain', contentBase64: 'aGk=' }],
      },
      'mv-c1-EMAIL_SEND-1'))
    expect(raw).toContain(`In-Reply-To: ${PARENT}`)
    expect(raw).toContain('multipart/mixed')
  })
})
