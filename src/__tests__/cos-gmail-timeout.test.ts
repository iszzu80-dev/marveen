import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GmailApiTransport } from '../cos/adapters/gmail-api-transport.js'
import { IDEMPOTENCY_HEADER, type OutboundEmail } from '../cos/adapters/gmail-send.js'
import { TOOL_TIMEOUTS } from '../tool-timeouts.js'

// gap-matrix #8: the Gmail send path must have a per-call deadline, so a stalled
// Gmail API call aborts instead of wedging the tick. A timeout during send
// surfaces as an error the executor recovers from (OUTCOME_UNKNOWN → readback).

function tempCreds(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cos-creds-'))
  const p = join(dir, 'creds.json')
  writeFileSync(p, JSON.stringify({ client_id: 'x', client_secret: 'y', refresh_token: 'z', token_uri: 'https://example.invalid/token' }))
  return p
}

const EMAIL: OutboundEmail = {
  to: 'v@x.com', subject: 'S', body: 'B', headers: { [IDEMPOTENCY_HEADER]: 'mv-x-1' },
}

describe('Gmail send per-tool timeout (#8)', () => {
  const origFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = origFetch })

  it('the deadline is registered in TOOL_TIMEOUTS', () => {
    expect(TOOL_TIMEOUTS['gmail-send']).toBeGreaterThan(0)
    expect(TOOL_TIMEOUTS['gmail-readback']).toBeGreaterThan(0)
  })

  it('a hung Gmail call aborts at the configured deadline instead of hanging forever', async () => {
    // fetch that never resolves on its own — only the abort signal ends it.
    globalThis.fetch = ((_url: string, opts: any) => new Promise((_res, rej) => {
      opts?.signal?.addEventListener('abort', () => rej(opts.signal.reason ?? new Error('aborted')))
    })) as unknown as typeof fetch

    const t = new GmailApiTransport({ credsPath: tempCreds(), sendTimeoutMs: 120, readbackTimeoutMs: 120 })
    const started = Date.now()
    await expect(t.send(EMAIL)).rejects.toThrow() // times out (token refresh fetch aborts)
    expect(Date.now() - started).toBeLessThan(3000) // aborted quickly, not hung
  })

  it('readback treats a timed-out search as UNAVAILABLE, not absent (no false RECOVERY)', async () => {
    globalThis.fetch = ((_url: string, opts: any) => new Promise((_res, rej) => {
      opts?.signal?.addEventListener('abort', () => rej(opts.signal.reason ?? new Error('aborted')))
    })) as unknown as typeof fetch
    const t = new GmailApiTransport({ credsPath: tempCreds(), sendTimeoutMs: 120, readbackTimeoutMs: 120 })
    const r = await t.findSentByHeader(IDEMPOTENCY_HEADER, 'mv-x-1')
    expect(r).toEqual({ found: false, available: false }) // unavailable, not "absent"
  })
})
