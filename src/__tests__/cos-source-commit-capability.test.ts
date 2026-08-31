import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { openBatch, localApply, getCheckpoint } from '../cos/email-ingest.js'
import { closeBatch, type SourceCommitter } from '../cos/source-commit.js'
import { probeSourceWriteCapability, GMAIL_MODIFY_SCOPE } from '../cos/source-commit-capability.js'
import { POISON_ATTEMPT_THRESHOLD } from '../cos/poison-quarantine.js'
import type { QuarantineDeps } from '../cos/poison-quarantine.js'

// The 2026-08-31 pipeline jam, as executable statements.
//
// Root cause was one sentence of code: the committer was chosen from the creds
// FILE's presence rather than from the token's granted SCOPE. The file outlived
// the scope by two weeks, so the writer was chosen, every call 403'd, and the
// FAILED branch wrote nothing at all -- no attempt, no error, no state. Fifteen
// messages and fifteen batches sat still while every surface said "a koteg nem
// minden eleme terminalis", which is true of every open batch and therefore
// says nothing.
//
// Each test below is one of those three defects, and each one FAILS against the
// code as it stood that morning.

const NOW = 1_800_000_000
const ACC = 'private'

let dir: string
function credsFile(body: unknown): string {
  const p = join(dir, 'creds.json')
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
  return p
}
const REAL_CREDS = { client_id: 'cid', client_secret: 'sec', refresh_token: 'rt', token_uri: 'https://oauth.test/token' }

function tokenResponse(scope: string | undefined, ok = true, status = 200): typeof fetch {
  return (async () => ({
    ok, status,
    json: async () => (scope === undefined ? {} : { scope, access_token: 'a', expires_in: 3600 }),
    text: async () => '',
  })) as unknown as typeof fetch
}

function seed(batchId: string, messages: string[], cursorAfter = '200') {
  const db = getDb()
  createCase(db, { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, NOW - 1000)
  openBatch(db, {
    batchId, accountId: ACC, cursorBefore: '100', cursorAfter,
    messages: messages.map((m) => ({ messageId: m })),
  }, NOW - 1000)
  for (const m of messages) localApply(db, ACC, m, 'c1', NOW - 900)
  return db
}
const rowOf = (m: string) => getDb().prepare(
  `SELECT status, attempt, last_error FROM email_processing WHERE message_id = ?`,
).get(m) as { status: string; attempt: number; last_error: string | null }

/** A committer that always fails, the way a 403 does. */
const failing: SourceCommitter = {
  id: 'failing',
  commit: async () => ({ outcome: 'FAILED', reason: '403 insufficient authentication scopes' }),
}

function recordingQuarantine(): QuarantineDeps & { alerts: string[]; tasks: string[] } {
  const alerts: string[] = []; const tasks: string[] = []
  return {
    alerts, tasks,
    raiseAlert: (_a, m, reason) => { alerts.push(`${m}:${reason}`); return true },
    createReviewTask: (_a, m, reason) => { tasks.push(`${m}:${reason}`); return true },
    policyAllowsCursorAdvance: () => true,
  }
}

describe('source-write capability is MEASURED, not assumed', () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cos-cap-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('CAPABLE only when the provider actually granted gmail.modify', async () => {
    const cap = await probeSourceWriteCapability(credsFile(REAL_CREDS), {
      fetchImpl: tokenResponse(`${GMAIL_MODIFY_SCOPE} https://www.googleapis.com/auth/drive.readonly`),
    })
    expect(cap.verdict).toBe('CAPABLE')
    expect(cap.scopes).toContain(GMAIL_MODIFY_SCOPE)
  })

  it('INCAPABLE when the scope is absent -- and the reason NAMES the measured scopes', async () => {
    // This is the exact grant the 08-25 re-auth left behind.
    const cap = await probeSourceWriteCapability(credsFile(REAL_CREDS), {
      fetchImpl: tokenResponse([
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/drive.readonly',
      ].join(' ')),
    })
    expect(cap.verdict).toBe('INCAPABLE')
    expect(cap.scopes).not.toContain(GMAIL_MODIFY_SCOPE)
    // The failure has to be legible from the reason alone, without a second
    // lookup. A generic "cannot label" is what cost two weeks.
    expect(cap.reason).toContain('gmail.readonly')
    expect(cap.reason).toContain('gmail.modify')
  })

  it('UNKNOWN, never INCAPABLE, when the grant cannot be measured', async () => {
    const httpFail = await probeSourceWriteCapability(credsFile(REAL_CREDS), { fetchImpl: tokenResponse('x', false, 400) })
    expect(httpFail.verdict).toBe('UNKNOWN')

    const noScopeField = await probeSourceWriteCapability(credsFile(REAL_CREDS), { fetchImpl: tokenResponse(undefined) })
    expect(noScopeField.verdict).toBe('UNKNOWN')

    const unreadable = await probeSourceWriteCapability(join(dir, 'missing.json'), { fetchImpl: tokenResponse('x') })
    expect(unreadable.verdict).toBe('UNKNOWN')

    const throwing = await probeSourceWriteCapability(credsFile(REAL_CREDS), {
      fetchImpl: (async () => { throw new Error('ENETDOWN') }) as unknown as typeof fetch,
    })
    expect(throwing.verdict).toBe('UNKNOWN')

    // Every one of them explains itself.
    for (const c of [httpFail, noScopeField, unreadable, throwing]) expect(c.reason.length).toBeGreaterThan(10)
  })
})

describe('a failed source-commit leaves a trace', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('records the attempt and the error instead of writing nothing', async () => {
    const db = seed('b1', ['aa11bb'])
    const before = rowOf('aa11bb')
    expect(before.attempt).toBe(0)
    expect(before.last_error).toBeNull()

    const r = await closeBatch(db, 'b1', failing, NOW)

    expect(r.failed).toBe(1)
    expect(r.batchClosed).toBe(false)
    const after = rowOf('aa11bb')
    // Still LOCAL_APPLIED: the local work stands and must not be redone.
    expect(after.status).toBe('LOCAL_APPLIED')
    // But the failure is now visible on the row. Before the fix both of these
    // were 0 and null, forever, which is what made the jam unreadable.
    expect(after.attempt).toBe(1)
    expect(after.last_error).toContain('403')
  })

  it('a persistent failure is let past ONLY on the owner policy, with the measured reason', async () => {
    const db = seed('b1', ['aa11bb'])
    const q = recordingQuarantine()

    // Two failures: below the threshold, the batch stays open. A transient
    // failure must retry, not be spent as a skip.
    for (let i = 0; i < POISON_ATTEMPT_THRESHOLD - 1; i++) {
      const r = await closeBatch(db, 'b1', failing, NOW, { allowCursorAdvanceWithoutSourceWrite: true, quarantine: q })
      expect(r.batchClosed).toBe(false)
      expect(rowOf('aa11bb').status).toBe('LOCAL_APPLIED')
    }

    const r = await closeBatch(db, 'b1', failing, NOW, { allowCursorAdvanceWithoutSourceWrite: true, quarantine: q })
    expect(r.batchClosed).toBe(true)
    const row = rowOf('aa11bb')
    // NOT SOURCE_COMMITTED. Nothing was marked at the source and the state must
    // not claim otherwise.
    expect(row.status).toBe('SOURCE_COMMIT_SKIPPED')
    expect(row.last_error).toContain('403')
    expect(row.last_error).toContain(String(POISON_ATTEMPT_THRESHOLD))
    // A.1: somebody is certainly told.
    expect(q.alerts).toHaveLength(1)
    expect(q.tasks).toHaveLength(1)
    // And the cursor moved, because this batch carries a real position.
    expect(getCheckpoint(db, ACC)).toBe('200')
  })

  it('WITHOUT the policy it jams forever rather than passing silently', async () => {
    const db = seed('b1', ['aa11bb'])
    for (let i = 0; i < POISON_ATTEMPT_THRESHOLD + 2; i++) {
      const r = await closeBatch(db, 'b1', failing, NOW)
      expect(r.batchClosed).toBe(false)
    }
    expect(rowOf('aa11bb').status).toBe('LOCAL_APPLIED')
    expect(rowOf('aa11bb').attempt).toBe(POISON_ATTEMPT_THRESHOLD + 2)
    // The cursor has NOT moved. A stuck cursor is a visible problem; a cursor
    // that steps over unprocessed mail is an invisible one.
    expect(getCheckpoint(db, ACC)).toBeNull()
  })

  it('is deterministic across a restart: re-running a closed batch changes nothing', async () => {
    const db = seed('b1', ['aa11bb'])
    const ok: SourceCommitter = { id: 'ok', commit: async () => ({ outcome: 'COMMITTED', reason: 'labelled' }) }
    await closeBatch(db, 'b1', ok, NOW)
    const first = rowOf('aa11bb')
    const cursorAfterFirst = getCheckpoint(db, ACC)

    // A second pass, as the next cycle (or a restart) would do it.
    const again = await closeBatch(db, 'b1', ok, NOW + 60)
    expect(again.attempted).toBe(0)
    expect(rowOf('aa11bb')).toEqual(first)
    expect(getCheckpoint(db, ACC)).toBe(cursorAfterFirst)
  })
})
