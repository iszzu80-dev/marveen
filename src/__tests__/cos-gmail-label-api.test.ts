import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GmailLabelApi } from '../cos/adapters/gmail-label-api.js'
import { TEST_SCHEDULED } from './helpers/w10-identity.js'

// The source-commit write, finally wired: Istvan granted gmail.modify on
// 2026-08-11, so GmailLabelCommitter -- written under F-8 and deliberately never
// instantiated -- can be given a real applyLabel.

function credsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lbl-'))
  const p = join(dir, 'creds.json')
  writeFileSync(p, JSON.stringify({
    client_id: 'cid', client_secret: 'sec', refresh_token: 'rt',
    token_uri: 'https://oauth.example/token',
  }))
  return p
}

interface Call { url: string; init: any }

function fakeFetch(labels: Array<{ id: string; name: string }>, modifyOk = true) {
  const calls: Call[] = []
  const impl = (async (url: string, init: any = {}) => {
    calls.push({ url, init })
    if (url.includes('/token')) {
      return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }), text: async () => '' } as unknown as Response
    }
    if (url.endsWith('/labels')) {
      return { ok: true, json: async () => ({ labels }), text: async () => '' } as unknown as Response
    }
    return {
      ok: modifyOk, status: modifyOk ? 200 : 403,
      json: async () => ({}), text: async () => 'forbidden',
    } as unknown as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('applying COS/Processed', () => {
  it('resolves the label by NAME and modifies the message with its id', async () => {
    const { impl, calls } = fakeFetch([{ id: 'Label_32', name: 'COS/Processed' }])
    const api = new GmailLabelApi({ identity: TEST_SCHEDULED, credsPath: credsFile(), fetchImpl: impl })
    await api.apply('private', 'msg-1')
    const modify = calls.find(c => c.url.includes('/modify'))!
    expect(modify.url).toContain('/messages/msg-1/modify')
    expect(JSON.parse(modify.init.body)).toEqual({ addLabelIds: ['Label_32'] })
  })

  it('does NOT create a missing label — it says the label is absent', async () => {
    // Creating one would hide a misconfiguration behind a label nobody chose,
    // and the whole point of the source-commit is that the mark is the one the
    // system claims to write.
    const { impl, calls } = fakeFetch([{ id: 'Label_1', name: 'Valami mas' }])
    const api = new GmailLabelApi({ identity: TEST_SCHEDULED, credsPath: credsFile(), fetchImpl: impl })
    await expect(api.apply('private', 'msg-1')).rejects.toThrow(/label not found/)
    expect(calls.some(c => c.init?.method === 'POST' && c.url.endsWith('/labels')),
      'no label may be created as a side effect').toBe(false)
  })

  it('surfaces a REFUSED modify with its status, so a revoked scope is visible', async () => {
    // If the scope is later withdrawn, this must fail loudly: the committer then
    // reports FAILED and the batch stays open, which is what F-8 wanted.
    const { impl } = fakeFetch([{ id: 'Label_32', name: 'COS/Processed' }], false)
    const api = new GmailLabelApi({ identity: TEST_SCHEDULED, credsPath: credsFile(), fetchImpl: impl })
    await expect(api.apply('private', 'msg-1')).rejects.toThrow(/403/)
  })

  it('caches the token and the label id — one lookup, not one per message', async () => {
    const { impl, calls } = fakeFetch([{ id: 'Label_32', name: 'COS/Processed' }])
    const api = new GmailLabelApi({ identity: TEST_SCHEDULED, credsPath: credsFile(), fetchImpl: impl })
    await api.apply('private', 'm1')
    await api.apply('private', 'm2')
    await api.apply('private', 'm3')
    expect(calls.filter(c => c.url.endsWith('/labels')).length, 'label list once').toBe(1)
    expect(calls.filter(c => c.url.includes('/token')).length, 'token once').toBe(1)
    expect(calls.filter(c => c.url.includes('/modify')).length).toBe(3)
  })
})
