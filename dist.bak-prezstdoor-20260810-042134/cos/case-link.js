// Personal Chief of Staff (COS) — linking cases across threads.
//
// The intake links a message to a case by Gmail thread id. That covers a reply
// arriving on a conversation we already know, and nothing else. On 2026-08-09 a
// GLS pickup notice opened its own case beside the open eCipő/Modivo claim it
// belonged to, because a courier writes from its own address on its own thread —
// so the step that actually advanced the claim landed next to it instead of in
// it. The claim's next action still read "pack the shoe" hours after the parcel
// had been collected.
//
// What links them is neither the thread nor the sender: it is a shared entity —
// an order number, a parcel number, a merchant. This module extracts those and
// proposes links.
//
// PROPOSES. Nothing here writes a link on its own. Two cases that mention "GLS"
// are not the same matter, and an automatic link on a weak signal produces a
// case graph nobody trusts, which is worse than no graph. Strong evidence (a
// shared long identifier) is offered as a confident suggestion; weak evidence
// (a merchant name alone) is offered as a question. linkCases() is the explicit
// write, and it records WHY, so a wrong link can be traced back and undone.
/** Merchants worth matching on. Couriers are deliberately EXCLUDED: half the
 *  shopping cases in the store mention GLS or Foxpost, so matching on a carrier
 *  would connect unrelated purchases to each other. A carrier tells you how a
 *  parcel moved, never whose it was. */
export const MERCHANTS = [
    'modivo', 'ecipo', 'ecipő', 'emag', 'alza', 'ikea', 'decathlon', 'temu',
    'zalando', 'notino', 'euronics', 'mediamarkt', 'hervis', 'intersport',
    'discovercars', 'centauro', 'hertz', 'booking.com', 'wizz', 'ryanair',
];
/** Carriers and other words that look like merchants but identify a channel. */
export const CARRIERS = ['gls', 'foxpost', 'dpd', 'ups', 'fedex', 'mpl', 'posta', 'packeta'];
const ID_RE = /\b\d{6,}\b/g;
const ACCENTS = 'áéíóöőúüűÁÉÍÓÖŐÚÜŰ';
const PLAIN = 'aeiooouuuAEIOOOUUU';
function fold(s) {
    let out = '';
    for (const ch of s) {
        const i = ACCENTS.indexOf(ch);
        out += i >= 0 ? PLAIN[i] : ch;
    }
    return out.toLowerCase();
}
/** Pull the linkable entities out of free text (subject + body + description). */
export function extractEntities(text) {
    const raw = text ?? '';
    const folded = fold(raw);
    const identifiers = Array.from(new Set(raw.match(ID_RE) ?? []));
    const merchants = MERCHANTS.filter((m) => folded.includes(fold(m)));
    // De-duplicate the ecipo/ecipő spellings into one merchant.
    const normalised = Array.from(new Set(merchants.map((m) => fold(m))));
    return { identifiers, merchants: normalised };
}
/** Propose links for `text` against the OPEN cases, excluding `excludeCaseId`.
 *
 *  Ordering is deliberate: STRONG first. A caller that takes only the first
 *  candidate should get the identifier match, never the brand coincidence. */
export function suggestLinks(db, text, excludeCaseId, table = 'personal_cases') {
    const want = extractEntities(text);
    if (!want.identifiers.length && !want.merchants.length)
        return [];
    let rows = [];
    try {
        rows = db.prepare(`SELECT case_id, title, description, source_references FROM ${table}
       WHERE archived_at IS NULL AND status NOT IN ('COMPLETED','CANCELLED','ARCHIVED')`).all();
    }
    catch {
        return [];
    }
    const out = [];
    for (const r of rows) {
        if (r.case_id === excludeCaseId)
            continue;
        const blob = `${r.title}\n${r.description ?? ''}\n${r.source_references ?? ''}`;
        const have = extractEntities(blob);
        const sharedId = want.identifiers.find((i) => have.identifiers.includes(i));
        if (sharedId) {
            out.push({ caseId: r.case_id, title: r.title, strength: 'STRONG', evidence: `azonosító: ${sharedId}` });
            continue;
        }
        const sharedMerchant = want.merchants.find((m) => have.merchants.includes(m));
        if (sharedMerchant) {
            out.push({ caseId: r.case_id, title: r.title, strength: 'WEAK', evidence: `kereskedő: ${sharedMerchant}` });
        }
    }
    const rank = { STRONG: 0, WEAK: 1 };
    return out.sort((a, b) => rank[a.strength] - rank[b.strength]);
}
function parseIds(raw) {
    if (!raw)
        return [];
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v.map(String) : [];
    }
    catch {
        return [];
    }
}
/** Link two cases, both directions, recording WHY on each side.
 *
 *  Symmetric on purpose: a one-way link is invisible from the case you happen to
 *  open, which is the same as no link. Idempotent — re-linking an existing pair
 *  is a no-op rather than a duplicate entry. */
export function linkCases(db, caseA, caseB, reason, now, table = 'personal_cases', eventsTable = 'personal_case_events') {
    if (caseA === caseB)
        return { linked: false, reason: 'egy ügyet nem lehet önmagához kötni' };
    const get = (id) => db.prepare(`SELECT case_id, related_case_ids, version FROM ${table} WHERE case_id = ?`).get(id);
    const a = get(caseA), b = get(caseB);
    if (!a)
        return { linked: false, reason: `nincs ilyen ügy: ${caseA}` };
    if (!b)
        return { linked: false, reason: `nincs ilyen ügy: ${caseB}` };
    const aIds = parseIds(a.related_case_ids), bIds = parseIds(b.related_case_ids);
    if (aIds.includes(caseB) && bIds.includes(caseA))
        return { linked: false, reason: 'már össze van kötve' };
    const tx = db.transaction(() => {
        const write = (id, ids, other, version) => {
            if (!ids.includes(other))
                ids.push(other);
            db.prepare(`UPDATE ${table} SET related_case_ids = @ids, version = version + 1, updated_at = @now
         WHERE case_id = @id AND version = @version`).run({ ids: JSON.stringify(ids), now, id, version });
            db.prepare(`INSERT INTO ${eventsTable} (case_id, case_version, actor, event_type, reason, created_at)
         VALUES (@id, @v, 'marveen', 'CASE_LINKED', @reason, @now)`).run({ id, v: version + 1, reason: `${other}: ${reason}`, now });
        };
        write(caseA, aIds, caseB, a.version);
        write(caseB, bIds, caseA, b.version);
    });
    tx();
    return { linked: true, reason };
}
/** The cases linked to this one. */
export function linkedCases(db, caseId, table = 'personal_cases') {
    const r = db.prepare(`SELECT related_case_ids FROM ${table} WHERE case_id = ?`).get(caseId);
    return parseIds(r?.related_case_ids ?? null);
}
