// ZST Slice 2 — Finance domain logic (read-only / local). Invoice registry with
// duplicate detection, read-only bank-reconciliation match SUGGESTIONS, and
// accounting-package assembly. Enforces the spec's finance rules:
//   §16.4 / AT-ZF02: the system may flag a due date and prepare a payment list,
//     but NEVER initiates a bank transaction and NEVER marks an invoice paid
//     without evidence (a bank_transaction_id). The DB CHECK backs this.
//   §18.1 / AT-ZF03: bank processing is READ-ONLY — it suggests matches, it
//     does not verify them autonomously (a human confirms MATCHED_VERIFIED).
//   AT-ZF01: a duplicate invoice is detectable (duplicate_hash + UNIQUE).
//   AT-ZF04: one bank transaction is not matched to two full invoices.
import { createHash } from 'node:crypto';
/** Duplicate fingerprint: supplier + invoice number + gross + issue date. Two
 *  ingests of the same invoice collide on this (with UNIQUE) → dedup. */
export function invoiceDuplicateHash(i) {
    const key = [i.supplierId ?? '', i.invoiceNumber ?? '', i.grossAmount ?? '', i.issueDate ?? ''].join('|');
    return createHash('sha256').update(key).digest('hex').slice(0, 32);
}
/** Register an invoice, idempotently. A second ingest of the same (supplier,
 *  number, hash) returns the existing id with duplicate=true (AT-ZF01) — never a
 *  second row, never a silent overwrite. */
export function upsertZstInvoice(db, input, now) {
    const dupHash = invoiceDuplicateHash(input);
    const existing = db.prepare(`SELECT invoice_id FROM zst_invoices WHERE supplier_id IS ? AND invoice_number IS ? AND duplicate_hash = ?`).get(input.supplierId ?? null, input.invoiceNumber ?? null, dupHash);
    if (existing)
        return { invoiceId: existing.invoice_id, duplicate: true };
    const invoiceId = input.invoiceId ?? `zst-inv-${dupHash.slice(0, 12)}`;
    db.prepare(`INSERT INTO zst_invoices
       (invoice_id, case_id, invoice_type, supplier_id, customer_id, invoice_number, issue_date,
        due_date, currency, net_amount, vat_amount, gross_amount, document_id, product_id,
        contract_id, accounting_period, validation_status, duplicate_hash, created_at, updated_at)
     VALUES (@invoiceId, @caseId, @invoiceType, @supplierId, @customerId, @invoiceNumber, @issueDate,
        @dueDate, @currency, @netAmount, @vatAmount, @grossAmount, @documentId, @productId,
        @contractId, @accountingPeriod, 'UNVALIDATED', @dupHash, @now, @now)`).run({
        invoiceId, caseId: input.caseId ?? null, invoiceType: input.invoiceType ?? 'INCOMING',
        supplierId: input.supplierId ?? null, customerId: input.customerId ?? null,
        invoiceNumber: input.invoiceNumber ?? null, issueDate: input.issueDate ?? null,
        dueDate: input.dueDate ?? null, currency: input.currency ?? 'HUF',
        netAmount: input.netAmount ?? null, vatAmount: input.vatAmount ?? null,
        grossAmount: input.grossAmount ?? null, documentId: input.documentId ?? null,
        productId: input.productId ?? null, contractId: input.contractId ?? null,
        accountingPeriod: input.accountingPeriod ?? null, dupHash, now,
    });
    return { invoiceId, duplicate: false };
}
/** Mark an invoice paid — ONLY with evidence (a bank_transaction_id). The DB
 *  CHECK also enforces this; this helper is the sanctioned path. Throws if no
 *  evidence is given (AT-ZF02). */
export function markInvoicePaid(db, invoiceId, bankTransactionId, now) {
    if (!bankTransactionId)
        throw new Error('markInvoicePaid: a bank_transaction_id (evidence) is required (AT-ZF02)');
    const info = db.prepare(`UPDATE zst_invoices SET payment_status='PAID', bank_transaction_id=@btx, updated_at=@now,
       version=version+1 WHERE invoice_id=@id`).run({ btx: bankTransactionId, now, id: invoiceId });
    if (info.changes === 0)
        throw new Error(`invoice ${invoiceId} not found`);
}
/** READ-ONLY reconciliation: for each UNMATCHED bank transaction, suggest the
 *  best invoice by exact gross-amount match (+ counterparty hint). Sets the
 *  transaction to MATCH_SUGGESTED and records a suggestion row — it NEVER sets
 *  MATCHED_VERIFIED (a human confirms) and never touches a bank system
 *  (§18.1/AT-ZF03). One suggestion per transaction; an invoice already suggested
 *  to another transaction is skipped so one txn ≠ two full invoices (AT-ZF04). */
export function suggestBankMatches(db, now) {
    const txns = db.prepare(`SELECT bank_transaction_id, amount, counterparty FROM zst_bank_transactions
     WHERE reconciliation_status = 'UNMATCHED' AND amount IS NOT NULL`).all();
    const out = [];
    const usedInvoices = new Set(db.prepare(`SELECT invoice_id FROM zst_reconciliation_items WHERE status IN ('SUGGESTED','CONFIRMED')`)
        .all().map(r => r.invoice_id));
    for (const t of txns) {
        // Candidate invoices: same gross (absolute), not already spoken for, not paid.
        const cands = db.prepare(`SELECT invoice_id, supplier_id FROM zst_invoices
       WHERE gross_amount = ? AND payment_status <> 'PAID'`).all(Math.abs(t.amount));
        const pick = cands.find(c => !usedInvoices.has(c.invoice_id));
        if (!pick)
            continue;
        // Confidence: amount match = 0.7; +0.3 if counterparty text contains supplier id.
        let confidence = 0.7;
        if (t.counterparty && pick.supplier_id && t.counterparty.toLowerCase().includes(pick.supplier_id.toLowerCase()))
            confidence = 1.0;
        usedInvoices.add(pick.invoice_id);
        const tx = db.transaction(() => {
            db.prepare(`UPDATE zst_bank_transactions SET reconciliation_status='MATCH_SUGGESTED',
        matched_invoice_id=@inv, match_confidence=@conf, updated_at=@now WHERE bank_transaction_id=@txn`)
                .run({ inv: pick.invoice_id, conf: confidence, now, txn: t.bank_transaction_id });
            db.prepare(`INSERT INTO zst_reconciliation_items (recon_id, bank_transaction_id, invoice_id, status, confidence, created_at)
        VALUES (@rid, @txn, @inv, 'SUGGESTED', @conf, @now)`)
                .run({ rid: `rec-${t.bank_transaction_id}-${pick.invoice_id}`, txn: t.bank_transaction_id, inv: pick.invoice_id, conf: confidence, now });
        });
        tx();
        out.push({ bankTransactionId: t.bank_transaction_id, invoiceId: pick.invoice_id, confidence });
    }
    return out;
}
/** Open (or fetch) the accounting package for a period and recompute its roll-up
 *  counts from the invoice/bank tables. Read-only assembly — no send (the SEND is
 *  the write-executor half, §17). */
export function ensureAccountingPackage(db, period, now) {
    const packageId = `zst-acc-${period}`;
    db.prepare(`INSERT INTO zst_accounting_packages (package_id, period, status, created_at)
     VALUES (@id, @period, 'COLLECTING', @now) ON CONFLICT(period) DO NOTHING`).run({ id: packageId, period, now });
    const incoming = db.prepare(`SELECT COUNT(*) n FROM zst_invoices WHERE accounting_period=? AND invoice_type='INCOMING'`).get(period).n;
    const outgoing = db.prepare(`SELECT COUNT(*) n FROM zst_invoices WHERE accounting_period=? AND invoice_type='OUTGOING'`).get(period).n;
    const missingDocs = db.prepare(`SELECT COUNT(*) n FROM zst_invoices WHERE accounting_period=? AND document_id IS NULL`).get(period).n;
    const unmatched = db.prepare(`SELECT COUNT(*) n FROM zst_bank_transactions WHERE reconciliation_status='UNMATCHED'`).get().n;
    db.prepare(`UPDATE zst_accounting_packages SET incoming_invoice_count=@in, outgoing_invoice_count=@out,
       missing_document_count=@miss, unmatched_transaction_count=@unm WHERE package_id=@id`).run({ in: incoming, out: outgoing, miss: missingDocs, unm: unmatched, id: packageId });
    return { packageId };
}
