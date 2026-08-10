// ZST Slice 3 — contract / renewal extractor (v1, heuristic). Turns a ZST
// contract- or subscription-renewal email into a structured zst_contracts row.
// This is the SECOND data extractor (after the invoice one): it fills the
// contract table the renewal-watch (zst-watch.dueZstItems) reads from, so a
// renewal notice that lands in the mailbox actually surfaces on the due-item
// runner instead of sitting unread in Gmail.
//
// Deliberately conservative, same contract as the invoice extractor:
//   - extracts only high-confidence fields (title, counterparty, key dates,
//     notice period, renewal type, financial commitment) and leaves the rest null,
//   - NEVER fabricates a date or an amount it cannot parse,
//   - NEVER moves a contract into SIGNED/ACTIVE — status stays UNDER_REVIEW; the
//     legal/owner review is what activates a contract, not an inbound email,
//   - is idempotent per (counterparty, title, expiry) so re-ingesting the same
//     notice does not create a second row.
// Coverage expands per real contract-email format; unparseable fields stay null
// (honest partial extraction) rather than guessed.
import { createHash } from 'node:crypto';
// "1 234 567 Ft", "1.234.567 Ft", "15 484 HUF" → 1234567 (forint int).
const HUF_AMOUNT = /(\d{1,3}(?:[ .]\d{3})+|\d{3,})\s?(?:Ft|HUF|forint)\b/gi;
function parseHufAmounts(text) {
    const out = [];
    for (const m of text.matchAll(HUF_AMOUNT)) {
        const n = parseInt(m[1].replace(/[ .]/g, ''), 10);
        if (!Number.isNaN(n))
            out.push(n);
    }
    return out;
}
// ISO or hu date "2026-07-22", "2026.07.22", "2026. 07. 22." → ISO.
const DATE_RE = /\b(20\d{2})[.\-/ ]\s?(\d{1,2})[.\-/ ]\s?(\d{1,2})\b/g;
function parseDates(text) {
    const out = [];
    for (const m of text.matchAll(DATE_RE)) {
        out.push(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
    }
    return out;
}
// A date appearing within ~40 chars AFTER a renewal/expiry cue, e.g.
// "a szerződés lejár: 2026-09-30" or "renews on 2026/09/30". Used to pick the
// KEY date out of an email that may mention several. Returns ISO or null.
const EXPIRY_NEAR = /(?:lejár\w*|megújul\w*|megújít\w*|hosszabb\w*|expir\w*|renew\w*|valid\s+until|érvényes\w*)\D{0,40}?(20\d{2})[.\-/ ]\s?(\d{1,2})[.\-/ ]\s?(\d{1,2})/i;
function parseExpiryNear(text) {
    const m = EXPIRY_NEAR.exec(text);
    return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}
// "30 nap felmondási idő", "felmondási idő: 60 nap", "notice period of 90 days".
const NOTICE_RE = /(?:(\d{1,3})\s?(?:nap\w*|days?)[^.\n]{0,25}(?:felmond\w*|notice|terminat\w*)|(?:felmond\w*|notice\s*period|terminat\w*)[^.\n]{0,25}?(\d{1,3})\s?(?:nap\w*|days?))/i;
function parseNoticeDays(text) {
    const m = NOTICE_RE.exec(text);
    if (!m)
        return undefined;
    const n = parseInt(m[1] ?? m[2], 10);
    return Number.isNaN(n) ? undefined : n;
}
// Counterparty: the sender's display name, else the domain.
function counterpartyFromSender(from) {
    const disp = /"?([^"<]+?)"?\s*</.exec(from);
    if (disp && disp[1].trim())
        return disp[1].trim();
    const dom = /@([\w.-]+)/.exec(from);
    return dom ? dom[1] : null;
}
const CONTRACT_CUE = /\b(szerződés\w*|megújít\w*|megújul\w*|előfizetés\w*|felmond\w*|hosszabbít\w*|contract\w*|agreement\w*|renew\w*|subscription\w*|auto-?renew\w*|terminat\w*|licen[cs]\w*)\b/i;
const AUTO_CUE = /\b(automatikusan\s+megújul\w*|auto-?renew\w*|magától\s+megújul\w*|önműköd\w*\s+megújul\w*)\b/i;
const MANUAL_CUE = /\b(kézi\s+megújít\w*|manual\s+renew\w*|felmond\w*\s+szükséges|meg\s+kell\s+újít\w*|explicit\s+renew\w*)\b/i;
/** Extract contract fields from an email. Returns null if it does not look like a
 *  contract/renewal notice at all (no contract cue). */
export function extractContract(src) {
    const text = `${src.subject}\n${src.body}`;
    if (!CONTRACT_CUE.test(text))
        return null;
    const extracted = [];
    const counterpartyId = counterpartyFromSender(src.from) ?? undefined;
    if (counterpartyId)
        extracted.push('counterparty_id');
    const expiryNear = parseExpiryNear(text);
    const allDates = parseDates(text);
    // Prefer a date anchored to an expiry/renewal cue; else the last date in the
    // text (renewal notices usually put the key date at the end). Effective date is
    // the first date only when it is clearly distinct from the expiry.
    const expiryDate = expiryNear ?? (allDates.length ? allDates[allDates.length - 1] : undefined);
    if (expiryDate)
        extracted.push('expiry_date');
    const effectiveDate = allDates.length > 1 && allDates[0] !== expiryDate ? allDates[0] : undefined;
    if (effectiveDate)
        extracted.push('effective_date');
    const noticePeriodDays = parseNoticeDays(text);
    if (noticePeriodDays != null)
        extracted.push('notice_period_days');
    const renewalType = AUTO_CUE.test(text) ? 'AUTOMATIC' : MANUAL_CUE.test(text) ? 'MANUAL' : undefined;
    if (renewalType)
        extracted.push('renewal_type');
    const amounts = parseHufAmounts(text);
    const financialCommitment = amounts.length ? Math.max(...amounts) : undefined;
    if (financialCommitment != null)
        extracted.push('financial_commitment');
    // Termination deadline = expiry minus notice period, only when BOTH are known.
    // Never invented from one alone.
    let terminationDeadline;
    if (expiryDate && noticePeriodDays != null) {
        const d = new Date(`${expiryDate}T00:00:00Z`);
        if (!Number.isNaN(d.getTime())) {
            d.setUTCDate(d.getUTCDate() - noticePeriodDays);
            terminationDeadline = d.toISOString().slice(0, 10);
            extracted.push('termination_deadline');
        }
    }
    const contractType = /\b(licen[cs]\w*|előfizetés\w*|subscription\w*)\b/i.test(text) ? 'SUBSCRIPTION' : 'SERVICE';
    const confidence = expiryDate && counterpartyId ? 'HIGH' : expiryDate || counterpartyId ? 'PARTIAL' : 'LOW';
    return {
        caseId: src.caseId, title: src.subject.trim() || 'Szerződés', contractType, counterpartyId,
        effectiveDate, expiryDate, renewalType, noticePeriodDays, terminationDeadline,
        financialCommitment, currency: amounts.length ? 'HUF' : undefined, confidence, extracted,
    };
}
/** Duplicate fingerprint: counterparty + title + expiry. Two ingests of the same
 *  renewal notice collide here → dedup, no second row. */
export function contractDuplicateHash(i) {
    const key = [i.counterpartyId ?? '', i.title, i.expiryDate ?? ''].join('|');
    return createHash('sha256').update(key).digest('hex').slice(0, 32);
}
/** Register a contract, idempotently. A second ingest of the same (counterparty,
 *  title, expiry) returns the existing id with duplicate=true — never a second
 *  row, never a silent overwrite. Status is UNDER_REVIEW: an inbound email is a
 *  signal to review, NOT an executed/signed contract. */
export function upsertZstContract(db, input, now) {
    const dupHash = contractDuplicateHash(input);
    const existing = db.prepare(`SELECT contract_id FROM zst_contracts WHERE counterparty_id IS ? AND title = ? AND expiry_date IS ?`).get(input.counterpartyId ?? null, input.title, input.expiryDate ?? null);
    if (existing)
        return { contractId: existing.contract_id, duplicate: true };
    const contractId = input.contractId ?? `zst-ctr-${dupHash.slice(0, 12)}`;
    db.prepare(`INSERT INTO zst_contracts
       (contract_id, case_id, title, contract_type, counterparty_id, status, effective_date,
        expiry_date, renewal_type, notice_period_days, termination_deadline, financial_commitment,
        currency, document_id, created_at, updated_at)
     VALUES (@contractId, @caseId, @title, @contractType, @counterpartyId, 'UNDER_REVIEW', @effectiveDate,
        @expiryDate, @renewalType, @noticePeriodDays, @terminationDeadline, @financialCommitment,
        @currency, @documentId, @now, @now)`).run({
        contractId, caseId: input.caseId ?? null, title: input.title,
        contractType: input.contractType ?? null, counterpartyId: input.counterpartyId ?? null,
        effectiveDate: input.effectiveDate ?? null, expiryDate: input.expiryDate ?? null,
        renewalType: input.renewalType ?? null, noticePeriodDays: input.noticePeriodDays ?? null,
        terminationDeadline: input.terminationDeadline ?? null,
        financialCommitment: input.financialCommitment ?? null, currency: input.currency ?? null,
        documentId: input.documentId ?? null, now,
    });
    return { contractId, duplicate: false };
}
/** Extract + register a contract from an email, if it is one. Idempotent via the
 *  contract dedup. Returns the contract id + confidence, or null if the email is
 *  not a contract/renewal notice. Never signs/activates a contract. */
export function ingestZstContractEmail(db, src, now) {
    const ex = extractContract(src);
    if (!ex)
        return null;
    const { contractId, duplicate } = upsertZstContract(db, ex, now);
    return { contractId, duplicate, confidence: ex.confidence, extracted: ex.extracted };
}
