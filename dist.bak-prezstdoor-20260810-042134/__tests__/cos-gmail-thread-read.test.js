import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { createCase } from '../cos/case-store.js';
import { decodeMessage, renderThread, storeCaseThread, casesMissingThreadText, recordThreadFetchFailure, abandonedThreadFetches, THREAD_FETCH_MAX_ATTEMPTS, } from '../cos/gmail-thread-read.js';
// Reading the whole thread (§8).
//
// The intake decides case type, title and sensitivity from a 300-character
// preview. On 2026-08-09 the GLS notice carried the parcel number in its body;
// the case got the preview, and the number had to be fetched by hand later.
//
// The tests that matter are the failure ones: fetching the thread must never be
// able to damage the case it belongs to. A case with no thread text is a
// smaller problem than a case that broke while trying to get it.
const NOW = 1_800_000_000;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const MSG = (id, body) => ({
    id,
    payload: {
        headers: [
            { name: 'From', value: 'noreply@gls-hungary.com' },
            { name: 'To', value: 'iszzu80@gmail.com' },
            { name: 'Date', value: '9 Aug 2026 14:22:45 +0200' },
            { name: 'Subject', value: 'Csomagfelvétel' },
        ],
        mimeType: 'multipart/alternative',
        parts: [
            { mimeType: 'text/plain', body: { data: b64(body) } },
            { mimeType: 'text/html', body: { data: b64('<p>ignored</p>') } },
        ],
    },
});
const reader = (messages) => ({ fetchThread: async () => messages });
const failing = (msg) => ({ fetchThread: async () => { throw new Error(msg); } });
describe('full thread read', () => {
    beforeEach(() => { initDatabase(':memory:'); });
    describe('decoding', () => {
        it('prefers text/plain over the HTML twin', () => {
            const m = decodeMessage(MSG('m1', 'A csomagszám: 3017482551'));
            expect(m.body).toContain('3017482551');
            expect(m.body).not.toContain('ignored');
        });
        it('keeps the headers a human needs to judge the message', () => {
            const m = decodeMessage(MSG('m1', 'x'));
            expect(m.from).toContain('gls-hungary');
            expect(m.subject).toBe('Csomagfelvétel');
            expect(m.date).toContain('2026');
        });
        it('survives a message with no decodable body rather than throwing', () => {
            expect(() => decodeMessage({ id: 'm', payload: { headers: [] } })).not.toThrow();
            expect(decodeMessage({ id: 'm', payload: { headers: [] } }).body).toBe('');
        });
    });
    it('renders the thread in reading order with its headers', () => {
        const text = renderThread([
            { id: 'a', from: 'x@y', to: 'me', date: 'd1', subject: 's1', body: 'első' },
            { id: 'b', from: 'me', to: 'x@y', date: 'd2', subject: 's2', body: 'második' },
        ]);
        expect(text.indexOf('első')).toBeLessThan(text.indexOf('második'));
        expect(text).toContain('1/2');
        expect(text).toContain('Feladó: x@y');
    });
    describe('storing it on the case', () => {
        function seed() {
            const db = getDb();
            createCase(db, { caseId: 'c1', title: 'GLS', caseType: 'SHOPPING' }, NOW - 100);
            return db;
        }
        it('stores the thread and reports how many messages it held', async () => {
            const db = seed();
            const r = await storeCaseThread(db, reader([
                { id: 'm1', from: 'a', to: 'b', date: 'd', subject: 's', body: 'A csomagszám: 3017482551' },
            ]), 'c1', 't1', 'personal', NOW);
            expect(r.stored).toBe(true);
            expect(r.messages).toBe(1);
            const docs = db.prepare(`SELECT doc_kind, source_ref FROM cos_documents WHERE case_id='c1'`).all();
            expect(docs).toHaveLength(1);
            expect(docs[0].doc_kind).toBe('email_thread');
        });
        it('a failed fetch does NOT damage the case', async () => {
            const db = seed();
            const before = db.prepare(`SELECT version, status FROM personal_cases WHERE case_id='c1'`).get();
            const r = await storeCaseThread(db, failing('HTTP 503'), 'c1', 't1', 'personal', NOW);
            expect(r.stored).toBe(false);
            expect(r.reason).toContain('503');
            const after = db.prepare(`SELECT version, status FROM personal_cases WHERE case_id='c1'`).get();
            expect(after).toEqual(before); // untouched
            expect(db.prepare(`SELECT COUNT(*) AS n FROM cos_documents`).get()).toMatchObject({ n: 0 });
        });
        it('an empty thread stores nothing and says so', async () => {
            const db = seed();
            const r = await storeCaseThread(db, reader([]), 'c1', 't1', 'personal', NOW);
            expect(r.stored).toBe(false);
            expect(r.reason).toMatch(/üres/);
        });
    });
    describe('finding what still needs it', () => {
        it('lists a case with a thread id but no stored thread', () => {
            const db = getDb();
            createCase(db, { caseId: 'c1', title: 'A', caseType: 'ADMIN' }, NOW);
            db.prepare(`UPDATE personal_cases SET gmail_thread_ids='["t1"]' WHERE case_id='c1'`).run();
            const rows = casesMissingThreadText(db);
            expect(rows.map((r) => r.case_id)).toContain('c1');
            expect(rows[0].thread_id).toBe('t1');
        });
        it('stops listing it once the thread is stored — no re-fetch loop', async () => {
            const db = getDb();
            createCase(db, { caseId: 'c1', title: 'A', caseType: 'ADMIN' }, NOW);
            db.prepare(`UPDATE personal_cases SET gmail_thread_ids='["t1"]' WHERE case_id='c1'`).run();
            await storeCaseThread(db, reader([
                { id: 'm', from: 'a', to: 'b', date: 'd', subject: 's', body: 'x' },
            ]), 'c1', 't1', 'personal', NOW);
            expect(casesMissingThreadText(db).map((r) => r.case_id)).not.toContain('c1');
        });
        it('ignores cases with no thread id at all', () => {
            const db = getDb();
            createCase(db, { caseId: 'c2', title: 'B', caseType: 'ADMIN' }, NOW);
            expect(casesMissingThreadText(db).map((r) => r.case_id)).not.toContain('c2');
        });
    });
    describe('giving up on a broken thread', () => {
        it('stops offering a thread after the attempt limit', () => {
            // A runner that retries a permanently-broken id every ten minutes emits a
            // failure line every ten minutes, and a line that always appears stops
            // being read — which is how the real failure gets missed.
            const db = getDb();
            createCase(db, { caseId: 'c1', title: 'A', caseType: 'ADMIN' }, NOW);
            db.prepare(`UPDATE personal_cases SET gmail_thread_ids='["thr-broken"]' WHERE case_id='c1'`).run();
            expect(casesMissingThreadText(db).map((r) => r.case_id)).toContain('c1');
            for (let i = 0; i < THREAD_FETCH_MAX_ATTEMPTS; i++) {
                recordThreadFetchFailure(db, 'c1', 'thr-broken', 'thread fetch failed: 400', NOW + i);
            }
            expect(casesMissingThreadText(db).map((r) => r.case_id)).not.toContain('c1');
        });
        it('one failure is not enough to give up', () => {
            const db = getDb();
            createCase(db, { caseId: 'c1', title: 'A', caseType: 'ADMIN' }, NOW);
            db.prepare(`UPDATE personal_cases SET gmail_thread_ids='["t"]' WHERE case_id='c1'`).run();
            recordThreadFetchFailure(db, 'c1', 't', 'timeout', NOW);
            expect(casesMissingThreadText(db).map((r) => r.case_id)).toContain('c1');
        });
        it('what we gave up on stays listable — an absence is not a report', () => {
            const db = getDb();
            createCase(db, { caseId: 'c1', title: 'A', caseType: 'ADMIN' }, NOW);
            for (let i = 0; i < THREAD_FETCH_MAX_ATTEMPTS; i++) {
                recordThreadFetchFailure(db, 'c1', 'thr-broken', 'HTTP 400', NOW + i);
            }
            const a = abandonedThreadFetches(db);
            expect(a).toHaveLength(1);
            expect(a[0].attempts).toBeGreaterThanOrEqual(THREAD_FETCH_MAX_ATTEMPTS);
            expect(a[0].last_error).toContain('400');
        });
    });
});
