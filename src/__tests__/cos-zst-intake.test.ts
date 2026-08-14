import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { ingestTriagedZstEmail, type ZstTriagedEmail } from '../cos/zst-intake.js'
import { getZstCase, createZstCase } from '../cos/zst-case-store.js'
import { draftZstSend } from '../cos/zst-send.js'
import { SNIPPET_EXTRACTION_NOTE } from '../cos/zst-invoice-extract.js'
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

  // ── The feeder does not send headers ─────────────────────────────────────
  //
  // scripts/email-triage-fetch.py queries BOTH accounts' `in:sent` and posts the
  // hits with no `headers` at all, so the marker check above never fires for
  // them. Everything a corporate send does on a NEW thread therefore came back
  // as an ordinary OUTBOUND candidate within the feeder's 4-day window, matched
  // no case, and opened a second zst_case in WAITING_EXTERNAL — with a follow-up
  // watching for a reply to our own letter.
  //
  // Both checks below are what the personal intake has had since 2026-08-10.
  /** A corporate letter that actually went out: a case, its ledger row, the
   *  provider id it came back with and the thread it landed in. */
  function sentLetter(caseId: string, messageId: string, threadId: string): void {
    const db = getDb()
    createZstCase(db, { caseId, title: 'Kimenő levél', caseType: 'CONTRACT' }, T0)
    const d = draftZstSend(db, { origin: 'owner',
      caseId, templateId: 'zst-freeform-v1',
      email: { to: 'partner@x.com', subject: 'Ajánlat', body: 'Csatolva.' },
    }, T0)
    db.prepare(
      `UPDATE zst_outbound_ledger SET status='VERIFIED', external_ref=?, thread_ref=? WHERE ledger_id=?`,
    ).run(messageId, threadId, d.ledgerId)
  }

  it('a headerless candidate that is OUR OWN send links to its case instead of opening one', () => {
    sentLetter('ZST-OUT-1', 'gmail-msg-99', 'thr-99')
    const r = ingestTriagedZstEmail(getDb(), base({
      messageId: 'gmail-msg-99', threadId: 'thr-99', direction: 'OUTBOUND',
      to: 'partner@x.com', subject: 'Ajánlat',
    }), T0 + 100)
    expect(r.outcome).toBe('LINKED_DUPLICATE')
    expect(r.caseId).toBe('ZST-OUT-1')
    // One case: the one that sent the letter. No WAITING_EXTERNAL twin.
    expect(getDb().prepare(`SELECT COUNT(*) n FROM zst_cases`).get()).toMatchObject({ n: 1 })
    expect(led('gmail-msg-99')).toMatchObject({ status: 'DUPLICATE', case_id: 'ZST-OUT-1' })
  })

  it('the reply to our own letter finds its case through the ledger thread, not the case column', () => {
    // gmail_thread_ids is written only at case creation. A case whose thread
    // exists because WE started it has nothing in that column, so this reply
    // used to match nothing and open a second case for a live matter.
    sentLetter('ZST-OUT-2', 'gmail-msg-100', 'thr-100')
    const r = ingestTriagedZstEmail(getDb(), base({
      messageId: 'reply-1', threadId: 'thr-100', from: 'partner@x.com', subject: 'Re: Ajánlat',
    }), T0 + 200)
    expect(r.outcome).toBe('LINKED_DUPLICATE')
    expect(r.caseId).toBe('ZST-OUT-2')
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

describe('ZST intake — the extractors see the whole letter, or say they did not', () => {
  beforeEach(() => { initDatabase(':memory:') })

  // A real invoice mail: the amount and the invoice number are well past the
  // 300 characters a Gmail snippet carries.
  const LEAD = 'Tisztelt Ügyfelünk! '.repeat(20) // ~400 chars of pleasantries
  const BODY = `${LEAD}\nSzámlaszám: SZ-2026/0042\nKelt: 2026-07-22\nFizetendő: 1 234 567 Ft`

  it('extracts from the full body when the caller supplies one', () => {
    const db = getDb()
    ingestTriagedZstEmail(db, base({
      messageId: 'm-full', threadId: 't-full', caseType: 'INVOICE_INCOMING',
      snippet: BODY.slice(0, 300), body: BODY,
    }), T0)
    const inv = db.prepare(
      `SELECT gross_amount, invoice_number, notes FROM zst_invoices LIMIT 1`,
    ).get() as { gross_amount: number | null; invoice_number: string | null; notes: string | null }
    expect(inv.gross_amount).toBe(1234567)
    expect(inv.invoice_number).toBe('SZ-2026/0042')
    expect(inv.notes).toBeNull() // nothing to warn about: we saw the whole mail
  })

  it('still seeds progression state after the seeding block moved to a shared helper', () => {
    const db = getDb()
    const r = ingestTriagedZstEmail(db, base({ messageId: 'm-prog', threadId: 't-prog' }), T0)
    const row = db.prepare(
      `SELECT domain, progression_enabled, progression_mode FROM case_progression_state WHERE case_id = ?`,
    ).get(r.caseId) as { domain: string; progression_enabled: number; progression_mode: string } | undefined
    expect(row).toMatchObject({ domain: 'zst', progression_enabled: 1, progression_mode: 'internal' })
  })

  it('marks a snippet-only extraction as partial instead of passing it off as complete', () => {
    // The modules advertise "re-extracted later" and nothing re-extracts, so a
    // row built from 300 characters has to be distinguishable from one built
    // from the letter.
    const db = getDb()
    ingestTriagedZstEmail(db, base({
      messageId: 'm-snip', threadId: 't-snip', caseType: 'INVOICE_INCOMING',
      snippet: BODY.slice(0, 300),
    }), T0)
    const inv = db.prepare(`SELECT notes FROM zst_invoices LIMIT 1`).get() as { notes: string | null }
    expect(inv.notes).toBe(SNIPPET_EXTRACTION_NOTE)
  })
})
