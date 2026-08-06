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

  it('From is omitted when not provided (Gmail fills the account address)', () => {
    const raw = decode(buildRawMessage(EMAIL, 'mv-x-1'))
    expect(raw).not.toContain('From:')
  })

  it('base64url has no +/=/ padding chars', () => {
    const out = base64url(Buffer.from('\xff\xff\xff\xfe', 'binary'))
    expect(out).not.toMatch(/[+/=]/)
  })
})
