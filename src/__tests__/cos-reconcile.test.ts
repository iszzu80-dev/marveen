import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { openBatch, localApply, sourceCommit } from '../cos/email-ingest.js'
import { registerConnector, recordFailure, DOWN_THRESHOLD } from '../cos/connector-health.js'
import { runDailyReconcile, formatReconcileReport, CHECKS, type Finding } from '../cos/reconcile.js'

// The daily reconcile (§14). Its job is to notice the states nobody else looks
// at, so every test here drives ONE state into existence and asserts the report
// names it. A reconcile that cannot be made to complain about a specific broken
// state is a reconcile that will stay quiet on the real one.

const NOW = 1_800_000_000
const DAY = 86400
const ACC = 'private'

function ids(f: Finding[]): string[] { return f.map((x) => x.id) }

describe('COS daily reconcile', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a clean-ish system produces no CRITICAL from the ledger checks', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, NOW - 100)
    openBatch(db, { batchId: 'b1', accountId: ACC, cursorBefore: null, cursorAfter: 'x', messages: [{ messageId: 'm1' }] }, NOW - 100)
    localApply(db, ACC, 'm1', 'c1', NOW - 100)
    sourceCommit(db, ACC, 'm1', NOW - 90)
    const r = runDailyReconcile(db, NOW)
    expect(ids(r.findings)).not.toContain('messages_never_source_committed')
    expect(ids(r.findings)).not.toContain('outbound_needs_human')
  })

  it('reproduces 2026-08-09: applied locally, never committed, batch left open, no cursor', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, NOW - 3 * DAY)
    openBatch(db, { batchId: 'b1', accountId: ACC, cursorBefore: null, cursorAfter: 'x', messages: [{ messageId: 'm1' }] }, NOW - 3 * DAY)
    localApply(db, ACC, 'm1', 'c1', NOW - 3 * DAY)

    const r = runDailyReconcile(db, NOW)
    expect(ids(r.findings)).toContain('messages_never_source_committed')
    expect(ids(r.findings)).toContain('batches_never_closed')
    expect(ids(r.findings)).toContain('account_cursor_missing')
    expect(r.counts.CRITICAL).toBeGreaterThanOrEqual(3)
    expect(r.clean).toBe(false)

    // and the same state, once the chain completes, stops being reported
    sourceCommit(db, ACC, 'm1', NOW - 100)
    const after = runDailyReconcile(db, NOW)
    expect(ids(after.findings)).not.toContain('messages_never_source_committed')
  })

  it('names corporate content sitting in the personal store (AC-17)', () => {
    const db = getDb()
    createCase(db, { caseId: 'z1', title: 'ZST Radio üzletrész', caseType: 'ADMIN' }, NOW - 100)
    const r = runDailyReconcile(db, NOW)
    const f = r.findings.find((x) => x.id === 'corporate_content_in_personal_store')
    expect(f?.severity).toBe('CRITICAL')
    expect(f?.detail).toContain('z1')
  })

  it('flags a send stuck in SENDING, and does not flag a fresh one', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, NOW - 100)
    const ins = (id: string, status: string, at: number) => db.prepare(
      `INSERT INTO outbound_ledger (ledger_id, case_id, action_type, sequence_number,
         internal_idempotency_key, status, created_at, updated_at)
       VALUES (?, 'c1', 'EMAIL_SEND', ?, ?, ?, ?, ?)`
    ).run(id, id.charCodeAt(1), `k-${id}`, status, at, at)

    ins('l1', 'SENDING', NOW - 60)                 // fresh, in flight
    expect(ids(runDailyReconcile(db, NOW).findings)).not.toContain('sending_stuck')
    ins('l2', 'SENDING', NOW - 4 * 3600)           // an hour+ old
    expect(ids(runDailyReconcile(db, NOW).findings)).toContain('sending_stuck')
  })

  it('flags an aging OUTCOME_UNKNOWN as a warning, and tells you not to resend', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, NOW - 100)
    db.prepare(
      `INSERT INTO outbound_ledger (ledger_id, case_id, action_type, sequence_number,
         internal_idempotency_key, status, created_at, updated_at)
       VALUES ('l1','c1','EMAIL_SEND',1,'k1','OUTCOME_UNKNOWN', ?, ?)`
    ).run(NOW - 3 * DAY, NOW - 3 * DAY)
    const f = runDailyReconcile(db, NOW).findings.find((x) => x.id === 'outcome_unknown_aging')
    expect(f?.severity).toBe('WARNING')
    expect(f?.action).toMatch(/TILOS/)
  })

  it('flags a DOWN connector as critical', () => {
    const db = getDb()
    registerConnector(db, 'gmail', 'email', 'READ_WRITE', NOW - 1000)
    for (let i = 0; i < DOWN_THRESHOLD; i++) recordFailure(db, 'gmail', 'auth', NOW - 900 + i)
    const f = runDailyReconcile(db, NOW).findings.find((x) => x.id === 'connector_unhealthy')
    expect(f?.severity).toBe('CRITICAL')
    expect(f?.detail).toContain('gmail')
  })

  it('a check that throws becomes a CRITICAL finding instead of narrowing the report', () => {
    const boom = () => { throw new Error('szándékos hiba') }
    const r = runDailyReconcile(getDb(), NOW, [boom as never])
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].id).toBe('check_threw')
    expect(r.findings[0].severity).toBe('CRITICAL')
  })

  it('CRITICAL findings sort above WARNING', () => {
    const mk = (id: string, severity: Finding['severity']): Finding =>
      ({ id, severity, ref: 'x', title: id, detail: 'd', action: 'a' })
    const r = runDailyReconcile(getDb(), NOW, [
      () => mk('w', 'WARNING'), () => mk('c', 'CRITICAL'), () => mk('i', 'INFO'),
    ])
    expect(ids(r.findings)).toEqual(['c', 'w', 'i'])
  })

  it('every finding carries an action — a report nobody can act on trains people to skip it', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'ZST valami', caseType: 'ADMIN' }, NOW - 3 * DAY)
    openBatch(db, { batchId: 'b1', accountId: ACC, cursorBefore: null, cursorAfter: 'x', messages: [{ messageId: 'm1' }] }, NOW - 3 * DAY)
    localApply(db, ACC, 'm1', 'c1', NOW - 3 * DAY)
    const r = runDailyReconcile(db, NOW)
    expect(r.findings.length).toBeGreaterThan(0)
    for (const f of r.findings) {
      expect(f.action.length, `${f.id} needs an action`).toBeGreaterThan(15)
      expect(f.ref, `${f.id} needs a spec reference`).toBeTruthy()
    }
  })

  it('is SILENT on a clean day — the report is empty text, not a reassuring paragraph', () => {
    const r = runDailyReconcile(getDb(), NOW, [])
    expect(r.clean).toBe(true)
    expect(formatReconcileReport(r)).toBe('')
  })

  it('the formatted report leads with the counts and names each finding', () => {
    const db = getDb()
    createCase(db, { caseId: 'z1', title: 'ZST Radio', caseType: 'ADMIN' }, NOW - 100)
    const text = formatReconcileReport(runDailyReconcile(db, NOW))
    expect(text).toMatch(/^COS napi egyeztetés: \d+ kritikus/)
    expect(text).toContain('Céges tartalom a személyes tárban')
    expect(text).toContain('Teendő:')
  })

  describe('the further §19 alerts', () => {
    const ledger = (id: string, over: Record<string, unknown> = {}) => {
      const d = { case_id: 'c1', action_type: 'EMAIL_SEND', status: 'VERIFIED',
        campaign_id: null, outbound_kind: null, recipient: null, at: NOW - 100, ...over }
      getDb().prepare(
        `INSERT INTO outbound_ledger (ledger_id, case_id, action_type, sequence_number,
           internal_idempotency_key, status, campaign_id, outbound_kind, recipient, created_at, updated_at)
         VALUES (@id, @case_id, @action_type, @seq, @key, @status, @campaign_id, @outbound_kind, @recipient, @at, @at)`
      ).run({ ...d, id, seq: id.charCodeAt(1) * 7 + id.length, key: `k-${id}` })
    }
    beforeEach(() => { createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, NOW - 1000) })

    it('spots two sends aimed at the same recipient in the same campaign', () => {
      expect(ids(runDailyReconcile(getDb(), NOW).findings)).not.toContain('duplicate_send_attempt')
      ledger('d1', { campaign_id: 'k1', recipient: 'a@b.hu' })
      ledger('d2', { campaign_id: 'k1', recipient: 'a@b.hu' })
      expect(ids(runDailyReconcile(getDb(), NOW).findings)).toContain('duplicate_send_attempt')
    })

    it('spots a send the provider accepted but readback never confirmed', () => {
      ledger('r1', { status: 'APPLIED_UNVERIFIED' })
      const f = runDailyReconcile(getDb(), NOW).findings.find((x) => x.id === 'readback_never_succeeded')
      expect(f?.action).toMatch(/TILOS/)
    })

    it('spots a campaign that has not moved in a week, but not a fresh one', () => {
      const db = getDb()
      const camp = (id: string, status: string, at: number) => db.prepare(
        `INSERT INTO campaigns (campaign_id, case_id, campaign_type, status, version,
           allows_free_text, autonomous_spend_limit, created_at, updated_at)
         VALUES (?, 'c1', 'EMAIL_SEND', ?, 1, 0, 0, ?, ?)`).run(id, status, at, at)
      camp('k-fresh', 'DRAFT', NOW - 3600)
      expect(ids(runDailyReconcile(db, NOW).findings)).not.toContain('campaign_stalled')
      camp('k-old', 'PAUSED', NOW - 30 * DAY)
      expect(ids(runDailyReconcile(db, NOW).findings)).toContain('campaign_stalled')
    })

    it('spots an approval still APPROVED past its validity', () => {
      const db = getDb()
      db.prepare(
        `INSERT INTO campaigns (campaign_id, case_id, campaign_type, status, version,
           allows_free_text, autonomous_spend_limit, created_at, updated_at)
         VALUES ('k1','c1','EMAIL_SEND','APPROVED',1,0,0,?,?)`).run(NOW - 1000, NOW - 1000)
      db.prepare(
        `INSERT INTO campaign_approvals (approval_id, campaign_id, campaign_version, approved_by,
           template_hash, rendered_payload_hash, status, valid_until, created_at, updated_at)
         VALUES ('a1','k1',1,'i','T','R','APPROVED', ?, ?, ?)`).run(NOW - DAY, NOW - 1000, NOW - 1000)
      expect(ids(runDailyReconcile(db, NOW).findings)).toContain('approval_expired')
    })

    it('spots a case chased three times', () => {
      ledger('f1', { outbound_kind: 'FOLLOW_UP' })
      ledger('f2', { outbound_kind: 'FOLLOW_UP' })
      expect(ids(runDailyReconcile(getDb(), NOW).findings)).not.toContain('follow_up_repeated')
      ledger('f3', { outbound_kind: 'FOLLOW_UP' })
      expect(ids(runDailyReconcile(getDb(), NOW).findings)).toContain('follow_up_repeated')
    })

    it('spots a radar item whose check is a day overdue', () => {
      const db = getDb()
      db.prepare(
        `INSERT INTO radar_items (radar_id, case_id, kind, label, status, next_check_at, created_at, updated_at)
         VALUES ('r1','c1','PRODUCT','Garmin','ACTIVE', ?, ?, ?)`).run(NOW - 3 * DAY, NOW - 5 * DAY, NOW - 5 * DAY)
      expect(ids(runDailyReconcile(db, NOW).findings)).toContain('radar_check_overdue')
    })

    it('spots the cursor having moved past a batch that never closed — data loss, not delay', () => {
      const db = getDb()
      openBatch(db, { batchId: 'b1', accountId: ACC, cursorBefore: '100', cursorAfter: '150', messages: [{ messageId: 'm1' }] }, NOW - 2 * DAY)
      localApply(db, ACC, 'm1', 'c1', NOW - 2 * DAY)
      db.prepare(`INSERT INTO email_source_checkpoints (gmail_account_id, history_cursor, updated_at) VALUES (?, '900', ?)`)
        .run(ACC, NOW - DAY)
      const f = runDailyReconcile(db, NOW).findings.find((x) => x.id === 'cursor_past_open_batch')
      expect(f?.severity).toBe('CRITICAL')
      expect(f?.action).toMatch(/adatveszt/i)
    })
  })

  it('ships more than a token number of checks', () => {
    expect(CHECKS.length).toBeGreaterThanOrEqual(17)
  })
})
