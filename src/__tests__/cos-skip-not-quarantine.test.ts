import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { openBatch, claimMessage, localApply } from '../cos/email-ingest.js'
import { closeOpenBatches, NoSourceWriteCommitter } from '../cos/source-commit.js'
import type { QuarantineDeps, CursorPassKind } from '../cos/poison-quarantine.js'

// FIXTURE IDS CHANGED 2026-08-31 (Recovery Gate), disclosed rather than quietly
// fixed. These tests used 'm1'/'m2'/'m3'/'m-probe' as message ids. Gmail message
// ids are lowercase hex, and closeBatch now refuses to hand a non-Gmail id to the
// committer at all -- so with the old fixtures these tests stopped reaching the
// branches they are about (the committer, the F-8 policy path) and asserted
// EXCLUDED instead. The ids are now Gmail-shaped; every assertion is unchanged.

// A poison message and a source-commit skip are both "the cursor passed
// something", and there the similarity ends. On 2026-08-11 they shared the
// alert and card wording, so a GLS pickup notice that had been processed
// completely — case opened, owner notified — produced a high-priority card
// reading "unprocessable message, check it by hand", and a CRITICAL alert.
//
// The second half matters more than the wording: the skip condition is
// permanent (no Gmail modify scope), so per-message alerting would have put one
// urgent card and one critical alert on EVERY email from that morning on.

const ACC = 'private'
const NOW = 1_700_000_000

interface Call { acct: string; mid: string; reason: string; kind: CursorPassKind }

function spyDeps(): { deps: QuarantineDeps; alerts: Call[]; tasks: Call[] } {
  const alerts: Call[] = []
  const tasks: Call[] = []
  return {
    alerts, tasks,
    deps: {
      raiseAlert: (acct, mid, reason, kind) => { alerts.push({ acct, mid, reason, kind }); return true },
      createReviewTask: (acct, mid, reason, kind) => { tasks.push({ acct, mid, reason, kind }); return true },
      policyAllowsCursorAdvance: () => true,
    },
  }
}

/** One message, carried to the point where the closer will try to source-commit. */
function seedMessage(batchId: string, mid: string, at: number) {
  const db = getDb()
  openBatch(db, { batchId, accountId: ACC, cursorBefore: null, cursorAfter: `c-${mid}`,
    messages: [{ messageId: mid, threadId: `t-${mid}` }] }, at)
  claimMessage(db, ACC, mid, at)
  localApply(db, ACC, mid, 'c1', at)
}

describe('a source-commit skip is not a quarantine', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'GLS', caseType: 'ADMIN' }, NOW)
  })

  it('reports the skip under its OWN kind, never as a quarantine', async () => {
    const { deps, alerts, tasks } = spyDeps()
    seedMessage('b1', '1a00000000000001', NOW)
    await closeOpenBatches(getDb(), new NoSourceWriteCommitter('nincs modify scope'), NOW + 10, {
      quarantine: deps, allowCursorAdvanceWithoutSourceWrite: true,
    })
    expect(alerts).toHaveLength(1)
    expect(tasks).toHaveLength(1)
    expect(alerts[0].kind,
      'calling a fully processed message a quarantine is the defect').toBe('SOURCE_COMMIT_SKIPPED')
    expect(tasks[0].kind).toBe('SOURCE_COMMIT_SKIPPED')
  })

  it('the message still reaches a terminal state and the cursor still advances', async () => {
    // The point of the exception is that the chain closes. Getting the wording
    // right must not cost that.
    const { deps } = spyDeps()
    seedMessage('b1', '1a00000000000001', NOW)
    const r = await closeOpenBatches(getDb(), new NoSourceWriteCommitter('nincs modify scope'), NOW + 10, {
      quarantine: deps, allowCursorAdvanceWithoutSourceWrite: true,
    })
    expect(r.closed, 'the exception exists so the chain can close').toBe(1)
    const row = getDb().prepare(
      `SELECT status, last_error FROM email_processing WHERE message_id='1a00000000000001'`,
    ).get() as { status: string; last_error: string | null }
    expect(row.status).toBe('SOURCE_COMMIT_SKIPPED')
    expect(row.last_error, 'the durable record of WHY lives on the row').toContain('modify scope')
  })
})

describe('a permanent condition is reported once, not once per message', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'GLS', caseType: 'ADMIN' }, NOW)
  })

  it('every message hits the skip branch — which is why deduping is the whole point', async () => {
    // This test states the SCALE of the problem rather than the fix: with no
    // modify scope, three messages produce three skips. The dedup lives in the
    // dep implementation (scripts/cos-close-batches.ts), which owns the card and
    // alert surfaces; here we prove the domain layer really does fire per
    // message, so a non-deduping implementation would spam once per email.
    const { deps, alerts } = spyDeps()
    for (const mid of ['1a00000000000001', '1a00000000000002', '1a00000000000003']) seedMessage(`b-${mid}`, mid, NOW)
    await closeOpenBatches(getDb(), new NoSourceWriteCommitter('nincs modify scope'), NOW + 10, {
      quarantine: deps, allowCursorAdvanceWithoutSourceWrite: true,
    })
    expect(alerts.map(a => a.mid).sort()).toEqual(['1a00000000000001', '1a00000000000002', '1a00000000000003'])
    expect(alerts.every(a => a.kind === 'SOURCE_COMMIT_SKIPPED')).toBe(true)
  })
})
