// Personal Chief of Staff (COS) — the quote-request campaign (§13.1).
//
// The spec's first pilot: ask several providers for a quote on the same job,
// collect the answers, compare them, and hand Istvan a decision. None of it
// existed — its four states had zero occurrences in the codebase.
//
// This is the state machine and its guards, not a sender. The actual sending
// goes through the approval door and the executor like everything else; a
// campaign that could send by itself would sit outside the gate that took all
// night to build.
//
// The hard gates §13.1 names are enforced as transitions that REFUSE, because
// each one protects against a different way this workflow goes wrong:
//   - nothing is sent before the owner approved the shortlist (otherwise the
//     campaign picks who hears about his house);
//   - no quote is compared that arrived from outside the approved list (a
//     stranger's price is not a quote, it is an unsolicited offer);
//   - the final choice is always his, and booking or deposit is never automatic.
export const QUOTE_STATES = [
    'DRAFT', 'SHORTLIST_READY', 'REQUESTS_SENDING', 'WAITING_EXTERNAL',
    'FOLLOW_UP_DUE', 'QUOTES_COLLECTED', 'COMPARISON_READY', 'AWAITING_FINAL_GATE',
    'BOOKING', 'COMPLETED', 'CANCELLED',
];
/** Which states may follow which. Written as data so the machine can be read in
 *  one glance rather than reconstructed from scattered ifs. */
export const QUOTE_TRANSITIONS = {
    DRAFT: ['SHORTLIST_READY', 'CANCELLED'],
    SHORTLIST_READY: ['REQUESTS_SENDING', 'CANCELLED'],
    REQUESTS_SENDING: ['WAITING_EXTERNAL', 'CANCELLED'],
    WAITING_EXTERNAL: ['FOLLOW_UP_DUE', 'QUOTES_COLLECTED', 'CANCELLED'],
    FOLLOW_UP_DUE: ['WAITING_EXTERNAL', 'QUOTES_COLLECTED', 'CANCELLED'],
    QUOTES_COLLECTED: ['COMPARISON_READY', 'CANCELLED'],
    COMPARISON_READY: ['AWAITING_FINAL_GATE', 'CANCELLED'],
    AWAITING_FINAL_GATE: ['BOOKING', 'CANCELLED'],
    BOOKING: ['COMPLETED', 'CANCELLED'],
    COMPLETED: [],
    CANCELLED: [],
};
export function ensureQuoteSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS quote_campaigns (
      campaign_id            TEXT PRIMARY KEY,
      case_id                TEXT NOT NULL,
      state                  TEXT NOT NULL DEFAULT 'DRAFT',
      shortlist              TEXT,          -- JSON array of provider addresses
      shortlist_approved_by  TEXT,
      quotes                 TEXT,          -- JSON array
      chosen_provider        TEXT,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL,
      CHECK (state IN ('DRAFT','SHORTLIST_READY','REQUESTS_SENDING','WAITING_EXTERNAL',
        'FOLLOW_UP_DUE','QUOTES_COLLECTED','COMPARISON_READY','AWAITING_FINAL_GATE',
        'BOOKING','COMPLETED','CANCELLED'))
    )
  `);
}
const parse = (raw, fallback) => {
    if (!raw)
        return fallback;
    try {
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
};
export function getQuoteCampaign(db, campaignId) {
    const r = db.prepare(`SELECT * FROM quote_campaigns WHERE campaign_id = ?`).get(campaignId);
    if (!r)
        return undefined;
    return {
        campaignId: r.campaign_id, caseId: r.case_id,
        state: r.state,
        shortlist: parse(r.shortlist ?? null, []),
        shortlistApprovedBy: r.shortlist_approved_by ?? undefined,
        quotes: parse(r.quotes ?? null, []),
        chosenProvider: r.chosen_provider ?? undefined,
    };
}
export function createQuoteCampaign(db, campaignId, caseId, now) {
    db.prepare(`INSERT INTO quote_campaigns (campaign_id, case_id, state, created_at, updated_at)
     VALUES (?, ?, 'DRAFT', ?, ?)`).run(campaignId, caseId, now, now);
    return getQuoteCampaign(db, campaignId);
}
function write(db, c, now) {
    db.prepare(`UPDATE quote_campaigns SET state=@s, shortlist=@sl, shortlist_approved_by=@by,
       quotes=@q, chosen_provider=@cp, updated_at=@now WHERE campaign_id=@id`).run({
        s: c.state, sl: JSON.stringify(c.shortlist), by: c.shortlistApprovedBy ?? null,
        q: JSON.stringify(c.quotes), cp: c.chosenProvider ?? null, now, id: c.campaignId,
    });
}
/** The owner names who may be asked. Until this happens nothing can be sent. */
export function approveShortlist(db, campaignId, providers, approvedBy, now) {
    const c = getQuoteCampaign(db, campaignId);
    if (!c)
        return { ok: false, state: 'DRAFT', reason: `nincs ilyen kampány: ${campaignId}` };
    if (c.state !== 'DRAFT')
        return { ok: false, state: c.state, reason: `a shortlist csak DRAFT állapotban hagyható jóvá (most: ${c.state})` };
    if (!providers.length)
        return { ok: false, state: c.state, reason: 'üres shortlist senkit nem hatalmaz fel' };
    c.shortlist = providers;
    c.shortlistApprovedBy = approvedBy;
    c.state = 'SHORTLIST_READY';
    write(db, c, now);
    return { ok: true, state: c.state, reason: `${providers.length} szolgáltató jóváhagyva` };
}
/** Move the campaign along. Refuses any hop the machine does not allow. */
export function transitionQuote(db, campaignId, to, now) {
    const c = getQuoteCampaign(db, campaignId);
    if (!c)
        return { ok: false, state: 'DRAFT', reason: `nincs ilyen kampány: ${campaignId}` };
    if (!QUOTE_TRANSITIONS[c.state].includes(to)) {
        return { ok: false, state: c.state, reason: `${c.state} → ${to} nem megengedett lépés` };
    }
    // §13.1 hard gate: nothing goes out before the owner named the recipients.
    if (to === 'REQUESTS_SENDING' && !c.shortlistApprovedBy) {
        return { ok: false, state: c.state, reason: 'a shortlist nincs jóváhagyva — kiküldés nem indulhat' };
    }
    if (to === 'COMPARISON_READY' && c.quotes.length < 2) {
        // One quote is not a comparison. Presenting it as one invites a decision
        // that looks informed and is not.
        return { ok: false, state: c.state, reason: `összehasonlításhoz legalább 2 ajánlat kell (most: ${c.quotes.length})` };
    }
    c.state = to;
    write(db, c, now);
    return { ok: true, state: to, reason: 'ok' };
}
/** Record an arrived quote. Refuses anything from outside the approved list. */
export function recordQuote(db, campaignId, quote, now) {
    const c = getQuoteCampaign(db, campaignId);
    if (!c)
        return { ok: false, state: 'DRAFT', reason: `nincs ilyen kampány: ${campaignId}` };
    if (!['WAITING_EXTERNAL', 'FOLLOW_UP_DUE', 'REQUESTS_SENDING'].includes(c.state)) {
        return { ok: false, state: c.state, reason: `${c.state} állapotban nem érkezhet ajánlat` };
    }
    const norm = (a) => (a.match(/<([^>]+)>/)?.[1] ?? a).trim().toLowerCase();
    if (!c.shortlist.some((p) => norm(p) === norm(quote.fromAddress))) {
        // An unsolicited price is not a quote in this campaign. Accepting it would
        // quietly widen the set of people whose numbers reach the comparison.
        return { ok: false, state: c.state, reason: `${quote.fromAddress} nincs a jóváhagyott listán` };
    }
    if (!(quote.amount > 0))
        return { ok: false, state: c.state, reason: 'az ajánlat összege nem értelmes' };
    c.quotes = [...c.quotes.filter((q) => norm(q.fromAddress) !== norm(quote.fromAddress)), quote];
    write(db, c, now);
    return { ok: true, state: c.state, reason: `${c.quotes.length} ajánlat` };
}
/** Rank the quotes. Deliberately no "recommended" flag: the cheapest is a fact,
 *  the best is a judgement, and the spec keeps judgements with the owner. */
export function compareQuotes(db, campaignId) {
    const c = getQuoteCampaign(db, campaignId);
    if (!c || c.quotes.length < 2)
        return undefined;
    const sorted = [...c.quotes].sort((a, b) => a.amount - b.amount);
    const min = sorted[0].amount;
    return {
        quotes: sorted.map((q, i) => ({ ...q, rank: i + 1, deltaFromCheapest: q.amount - min })),
        cheapest: sorted[0].provider,
        spread: sorted[sorted.length - 1].amount - min,
        note: 'A legolcsóbb tény, a legjobb döntés. A választás Istváné.',
    };
}
/** The owner picks. Booking and any deposit stay manual (§13.1, AC-8). */
export function chooseProvider(db, campaignId, provider, now) {
    const c = getQuoteCampaign(db, campaignId);
    if (!c)
        return { ok: false, state: 'DRAFT', reason: `nincs ilyen kampány: ${campaignId}` };
    if (c.state !== 'AWAITING_FINAL_GATE') {
        return { ok: false, state: c.state, reason: `választani csak a végkapunál lehet (most: ${c.state})` };
    }
    if (!c.quotes.some((q) => q.provider === provider)) {
        return { ok: false, state: c.state, reason: `${provider} nem adott ajánlatot ebben a kampányban` };
    }
    c.chosenProvider = provider;
    c.state = 'BOOKING';
    write(db, c, now);
    return { ok: true, state: c.state, reason: `választott: ${provider} — a foglalás és bármely előleg kézi` };
}
