import { describe, it, expect, vi, afterEach } from 'vitest'
import { GmailApiTransport } from '../cos/adapters/gmail-api-transport.js'
import { IDEMPOTENCY_HEADER, type OutboundEmail } from '../cos/adapters/gmail-send.js'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// THREADING ON SEND.
//
// Found by sending a real one on 2026-09-04: the reply carried correct
// In-Reply-To and References headers and Gmail STILL filed our copy in a new
// thread, because the API threads on the request's `threadId` field. The
// recipient saw a proper reply; we got a second conversation, so their answer
// would have returned on a thread the case did not know.
//
// These tests assert what goes ON THE WIRE, because that is the thing that was
// wrong — the headers were already right and proved nothing.

const IN_REPLY_TO = '<GV1P193MB2407ABC@GV1P193MB2407.EURP193.PROD.OUTLOOK.COM>'

function credsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-thread-'))
  const p = join(dir, 'creds.json')
  writeFileSync(p, JSON.stringify({ client_id: 'cid', client_secret: 'cs', refresh_token: 'rt' }))
  return p
}

/** Captures every request the transport makes, and answers them plausibly. */
function harness(opts: { searchThreadId?: string | null; searchOk?: boolean } = {}) {
  const calls: Array<{ url: string; body?: unknown }> = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    // The OAuth call is form-encoded; only the API calls carry JSON.
    let body: unknown
    if (init?.body) { try { body = JSON.parse(String(init.body)) } catch { body = String(init.body) } }
    calls.push({ url: u, body })
    if (u.includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
    }
    if (u.includes('/messages?q=')) {
      if (opts.searchOk === false) return new Response('nope', { status: 500 })
      const messages = opts.searchThreadId ? [{ id: 'm1', threadId: opts.searchThreadId }] : []
      return new Response(JSON.stringify({ messages }), { status: 200 })
    }
    if (u.includes('/messages/send')) {
      return new Response(JSON.stringify({ id: 'sent1', threadId: 'landed-thread' }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, sendBody: () => calls.find(c => c.url.includes('/messages/send'))?.body as Record<string, unknown> | undefined }
}

const mail = (over: Partial<OutboundEmail> = {}): OutboundEmail => ({
  to: 'vendor@example.com', subject: 'Re: alkatresz', body: 'Ket C elem kell.',
  headers: { [IDEMPOTENCY_HEADER]: 'mv-1' }, ...over,
})

const transport = () => new GmailApiTransport({ credsPath: credsFile(), from: 'me@gmail.com', embedBodyMarker: false })

afterEach(() => { vi.unstubAllGlobals() })

describe('a reply is filed in the conversation it answers', () => {
  it('derives the thread from In-Reply-To when the caller did not pass one', async () => {
    const h = harness({ searchThreadId: 'thread-abc' })
    await transport().send(mail({ headers: { [IDEMPOTENCY_HEADER]: 'mv-1', 'In-Reply-To': IN_REPLY_TO } }))
    expect(h.sendBody()?.threadId).toBe('thread-abc')
    // and it asked the right question: the bare id, no angle brackets
    const q = h.calls.find(c => c.url.includes('/messages?q='))!.url
    expect(decodeURIComponent(q)).toContain('rfc822msgid:GV1P193MB2407ABC@')
    expect(decodeURIComponent(q)).not.toContain('<')
  })

  it('an explicit threadId wins over the header — the caller knows best', async () => {
    const h = harness({ searchThreadId: 'thread-from-search' })
    await transport().send(mail({
      threadId: 'thread-explicit',
      headers: { [IDEMPOTENCY_HEADER]: 'mv-1', 'In-Reply-To': IN_REPLY_TO },
    }))
    expect(h.sendBody()?.threadId).toBe('thread-explicit')
    // no lookup needed when the caller already told us
    expect(h.calls.some(c => c.url.includes('/messages?q='))).toBe(false)
  })

  it('a first contact starts a new conversation — no threadId on the wire', async () => {
    const h = harness()
    await transport().send(mail())
    expect(h.sendBody()).toHaveProperty('raw')
    expect(h.sendBody()).not.toHaveProperty('threadId')
  })
})

describe('the lookup never costs the send', () => {
  it('an unfindable message id sends anyway, on a new thread', async () => {
    const h = harness({ searchThreadId: null })
    const r = await transport().send(mail({ headers: { [IDEMPOTENCY_HEADER]: 'mv-1', 'In-Reply-To': IN_REPLY_TO } }))
    expect(h.sendBody()).not.toHaveProperty('threadId')
    expect(r.messageId).toBe('sent1')   // the owner-approved reply still went
  })

  it('a search failure sends anyway — not sending is the bigger harm', async () => {
    const h = harness({ searchOk: false })
    const r = await transport().send(mail({ headers: { [IDEMPOTENCY_HEADER]: 'mv-1', 'In-Reply-To': IN_REPLY_TO } }))
    expect(h.sendBody()).not.toHaveProperty('threadId')
    expect(r.messageId).toBe('sent1')
  })
})
