import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { createCase } from '../cos/case-store.js';
import { openBatch, localApply, getCheckpoint, excludeMessage } from '../cos/email-ingest.js';
import { closeBatch, closeOpenBatches, openBatchIds, NoSourceWriteCommitter, GmailLabelCommitter, } from '../cos/source-commit.js';
// Closing the inbound chain.
//
// The tests are built around the distinction that was lost for three days:
// "marked at the source" and "we could not mark it" must not collapse into the
// same outcome. A committer that cannot write must leave the chain visibly
// open, unless an explicit policy says otherwise — and then the reason has to be
// on the row.
const NOW = 1_800_000_000;
const ACC = 'private';
function seed(batchId = 'b1', messages = ['m1']) {
    const db = getDb();
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, NOW - 1000);
    openBatch(db, {
        batchId, accountId: ACC, cursorBefore: '100', cursorAfter: '200',
        messages: messages.map((m) => ({ messageId: m })),
    }, NOW - 1000);
    for (const m of messages)
        localApply(db, ACC, m, 'c1', NOW - 900);
    return db;
}
const statusOf = (m) => getDb().prepare(`SELECT status FROM email_processing WHERE message_id = ?`).get(m).status;
describe('COS source commit + batch closure', () => {
    beforeEach(() => { initDatabase(':memory:'); });
    it('a working committer closes the chain and moves the cursor', async () => {
        const db = seed();
        const labeled = [];
        const committer = new GmailLabelCommitter(async (_a, m) => { labeled.push(m); });
        const r = await closeBatch(db, 'b1', committer, NOW);
        expect(r.committed).toBe(1);
        expect(r.batchClosed).toBe(true);
        expect(r.cursor).toBe('200');
        expect(statusOf('m1')).toBe('SOURCE_COMMITTED');
        expect(getCheckpoint(db, ACC)).toBe('200');
        expect(labeled).toEqual(['m1']);
    });
    it('without source-write capability the chain stays OPEN — visibly, not silently', async () => {
        const db = seed();
        const r = await closeBatch(db, 'b1', new NoSourceWriteCommitter(), NOW);
        expect(r.skipped).toBe(1);
        expect(r.committed).toBe(0);
        expect(r.batchClosed).toBe(false);
        expect(statusOf('m1')).toBe('LOCAL_APPLIED');
        expect(getCheckpoint(db, ACC)).toBeNull();
        // and the reason names the missing capability rather than shrugging
        expect(r.reason).toMatch(/modify scope/);
    });
    it('with the explicit policy the chain closes AND the row carries the reason', async () => {
        const db = seed();
        const r = await closeBatch(db, 'b1', new NoSourceWriteCommitter(), NOW, { allowCursorAdvanceWithoutSourceWrite: true });
        expect(r.batchClosed).toBe(true);
        expect(statusOf('m1')).toBe('SOURCE_COMMITTED');
        const row = db.prepare(`SELECT last_error FROM email_processing WHERE message_id='m1'`)
            .get();
        expect(row.last_error).toMatch(/source-commit kihagyva/);
        expect(row.last_error).toMatch(/modify scope/);
    });
    it('a failing committer does NOT close the batch and does not move the cursor', async () => {
        const db = seed();
        const boom = {
            id: 'boom',
            commit: async () => ({ outcome: 'FAILED', reason: 'HTTP 500' }),
        };
        const r = await closeBatch(db, 'b1', boom, NOW, { allowCursorAdvanceWithoutSourceWrite: true });
        expect(r.failed).toBe(1);
        expect(r.batchClosed).toBe(false);
        expect(getCheckpoint(db, ACC)).toBeNull();
        // the policy exception must not rescue a genuine failure
        expect(statusOf('m1')).toBe('LOCAL_APPLIED');
    });
    it('one unfinished message holds the whole batch — the cursor never steps over it', async () => {
        const db = seed('b1', ['m1', 'm2']);
        let calls = 0;
        const flaky = {
            id: 'flaky',
            commit: async () => (++calls === 1
                ? { outcome: 'COMMITTED', reason: 'ok' }
                : { outcome: 'FAILED', reason: 'timeout' }),
        };
        const r = await closeBatch(db, 'b1', flaky, NOW);
        expect(r.committed).toBe(1);
        expect(r.failed).toBe(1);
        expect(r.batchClosed).toBe(false);
        expect(getCheckpoint(db, ACC)).toBeNull();
    });
    it('EXCLUDED messages are already terminal and do not block closure', async () => {
        const db = seed('b1', ['m1', 'm2']);
        excludeMessage(db, ACC, 'm2', NOW - 800);
        const r = await closeBatch(db, 'b1', new GmailLabelCommitter(async () => { }), NOW);
        expect(r.attempted).toBe(1); // only the LOCAL_APPLIED one needed work
        expect(r.batchClosed).toBe(true);
    });
    it('is idempotent: a second close is a no-op, not a second cursor step', async () => {
        const db = seed();
        const c = new GmailLabelCommitter(async () => { });
        await closeBatch(db, 'b1', c, NOW);
        const again = await closeBatch(db, 'b1', c, NOW + 10);
        expect(again.attempted).toBe(0);
        expect(getCheckpoint(db, ACC)).toBe('200');
    });
    it('closeOpenBatches walks every open batch, oldest first', async () => {
        const db = getDb();
        createCase(db, { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, NOW - 2000);
        openBatch(db, { batchId: 'old', accountId: ACC, cursorBefore: '1', cursorAfter: '2', messages: [{ messageId: 'a' }] }, NOW - 2000);
        localApply(db, ACC, 'a', 'c1', NOW - 1900);
        openBatch(db, { batchId: 'new', accountId: ACC, cursorBefore: '2', cursorAfter: '3', messages: [{ messageId: 'b' }] }, NOW - 1000);
        localApply(db, ACC, 'b', 'c1', NOW - 900);
        expect(openBatchIds(db)).toEqual(['old', 'new']);
        const r = await closeOpenBatches(db, new GmailLabelCommitter(async () => { }), NOW);
        expect(r.batches).toBe(2);
        expect(r.closed).toBe(2);
        expect(getCheckpoint(db, ACC)).toBe('3');
    });
    it('reproduces 2026-08-09 and fixes it: eighteen-style backlog, all stuck, then closed', async () => {
        const db = seed('b1', ['m1', 'm2', 'm3']);
        expect(['m1', 'm2', 'm3'].every((m) => statusOf(m) === 'LOCAL_APPLIED')).toBe(true);
        expect(getCheckpoint(db, ACC)).toBeNull();
        const r = await closeBatch(db, 'b1', new NoSourceWriteCommitter(), NOW, { allowCursorAdvanceWithoutSourceWrite: true });
        expect(r.committed).toBe(3);
        expect(r.batchClosed).toBe(true);
        expect(getCheckpoint(db, ACC)).toBe('200');
    });
});
