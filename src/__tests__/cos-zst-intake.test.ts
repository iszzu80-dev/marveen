import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { ingestTriagedZstEmail, type ZstTriagedEmail } from '../cos/zst-intake.js'
import { getZstCase } from '../cos/zst-case-store.js'
import { IDEMPOTENCY_HEADER } from '../cos/adapters/gmail-send.js'

// ZST Slice 1 read-only ingest: a triaged ZST-mailbox email becomes a zst_case
// (not a personal_case), idempotently, with ZST sensitivity + workspace routing.

const T0 = 1_700_000_000
const base = (over: Partial<ZstTriagedEmail> = {}): ZstTriagedEmail => ({
  accountId: 'zst', messageId: 'm1', threadId: 't1', subject: 'Bejövő számla',
  from: 'konyvelo@example.com', snippet: 'a havi számla', actionable: true, ...over,
})

describe('ZST email intake (Slice 1, read-only)', () => {
  beforeEach(() => { initDatabase(':memory:') })
  const led = (mid: string) => getDb().prepare(
    `SELECT status, case_id FROM zst_email_processing WHERE gmail_account_id='zst' AND message_id=?`).get(mid) as any

  it('creates a zst_case from an actionable ZST email', () => {
    const r = ingestTriagedZstEmail(getDb(), base({ caseType: 'INVOICE_INCOMING' }), T0)
    expect(r.outcome).toBe('CASE_CREATED')
    const c: any = getZstCase(getDb(), r.caseId!)
    expect(c.case_type).toBe('INVOICE_INCOMING')
    expect(c.source_system).toBe('gmail-zst')
    expect(c.workspace).toBe('OPERATIONS')
    expect(led('m1')).toMatchObject({ status: 'LOCAL_APPLIED', case_id: r.caseId })
  })

  it('is idempotent per (account, message)', () => {
    ingestTriagedZstEmail(getDb(), base(), T0)
    const again = ingestTriagedZstEmail(getDb(), base(), T0 + 5)
    expect(again.outcome).toBe('ALREADY_PROCESSED')
    expect(getDb().prepare(`SELECT COUNT(*) n FROM zst_cases`).get()).toMatchObject({ n: 1 })
  })

  it('excludes a non-actionable email (noise) without a case', () => {
    const r = ingestTriagedZstEmail(getDb(), base({ messageId: 'm2', actionable: false }), T0)
    expect(r.outcome).toBe('EXCLUDED')
    expect(getDb().prepare(`SELECT COUNT(*) n FROM zst_cases`).get()).toMatchObject({ n: 0 })
    expect(led('m2').status).toBe('EXCLUDED')
  })

  it('filters our own sent message (self-event) via the idempotency header', () => {
    const r = ingestTriagedZstEmail(getDb(), base({ messageId: 'm3', headers: { [IDEMPOTENCY_HEADER]: 'x' } }), T0)
    expect(r.outcome).toBe('EXCLUDED_SELF_SEND')
    expect(getDb().prepare(`SELECT COUNT(*) n FROM zst_cases`).get()).toMatchObject({ n: 0 })
  })

  it('links a second message on the same thread to the existing case', () => {
    const first = ingestTriagedZstEmail(getDb(), base(), T0)
    const second = ingestTriagedZstEmail(getDb(), base({ messageId: 'm-dup', threadId: 't1' }), T0 + 10)
    expect(second.outcome).toBe('LINKED_DUPLICATE')
    expect(second.caseId).toBe(first.caseId)
    expect(getDb().prepare(`SELECT COUNT(*) n FROM zst_cases`).get()).toMatchObject({ n: 1 })
  })

  it('escalates sensitivity from content (financial), and honours the workspace tag', () => {
    const r = ingestTriagedZstEmail(getDb(), base({
      messageId: 'm4', threadId: 't4', workspace: 'PRODUCT_LAB',
      snippet: 'utalás IBAN HU42117730161111101800000000 fizetendő',
    }), T0)
    const c: any = getZstCase(getDb(), r.caseId!)
    expect(c.sensitivity).toBe('ZST_FINANCIAL')
    expect(c.workspace).toBe('PRODUCT_LAB')
  })

  it('an OUTBOUND email opens the case in WAITING_EXTERNAL with a follow-up', () => {
    const r = ingestTriagedZstEmail(getDb(), base({ messageId: 'm5', threadId: 't5', direction: 'OUTBOUND', to: 'partner@x.com' }), T0)
    const c: any = getZstCase(getDb(), r.caseId!)
    expect(c.status).toBe('WAITING_EXTERNAL')
    expect(c.follow_up_at).toBeGreaterThan(T0)
  })

  it('creates in the ZST namespace only (no personal_case)', () => {
    const r = ingestTriagedZstEmail(getDb(), base(), T0)
    expect(r.caseId!.startsWith('zst-')).toBe(true)
    expect(getDb().prepare(`SELECT COUNT(*) n FROM personal_cases`).get()).toMatchObject({ n: 0 })
  })
})
