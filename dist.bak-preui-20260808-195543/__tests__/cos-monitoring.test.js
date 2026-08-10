import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { createCase } from '../cos/case-store.js';
import { planAction } from '../cos/executor.js';
import { listMonitoring } from '../web/routes/cos.js';
// #5b Monitoring view data: connector health, outbound status roll-up with the
// rows that need a human, and send-quota usage.
const NOW = 1_000_000;
describe('COS monitoring view (listMonitoring)', () => {
    beforeEach(() => {
        initDatabase(':memory:');
        createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'X' }, NOW);
    });
    it('rolls up connector health, outbound statuses, needs-attention rows, and quotas', () => {
        const db = getDb();
        db.prepare(`INSERT INTO connector_health (connector_id, kind, mode, status, consecutive_failures, last_ok_at, updated_at) VALUES ('gmail','email','READ_ONLY','OK',0,${NOW},${NOW})`).run();
        db.prepare(`INSERT INTO connector_health (connector_id, kind, mode, status, consecutive_failures, last_error, last_error_at, updated_at) VALUES ('rental','shopping','READ_ONLY','DOWN',3,'timeout',${NOW},${NOW})`).run();
        // outbound rows across statuses (one needs a human)
        const a = planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 1, payload: {} }, NOW); // PLANNED
        const b = planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 2, payload: {} }, NOW);
        db.prepare(`UPDATE outbound_ledger SET status='VERIFIED' WHERE ledger_id=?`).run(a.ledgerId);
        db.prepare(`UPDATE outbound_ledger SET status='RECOVERY_REQUIRED', last_error='marker absent' WHERE ledger_id=?`).run(b.ledgerId);
        db.prepare(`INSERT INTO send_quotas (quota_key, window_start, window_sec, max_count, used_count, updated_at) VALUES ('EMAIL_SEND:daily',${NOW},86400,10,4,${NOW})`).run();
        const mon = listMonitoring(db);
        // connectors
        expect(mon.connectors).toHaveLength(2);
        expect(mon.connectors.find((c) => c.connector_id === 'rental').status).toBe('DOWN');
        // outbound roll-up
        expect(mon.outboundHealth.byStatus.VERIFIED).toBe(1);
        expect(mon.outboundHealth.byStatus.RECOVERY_REQUIRED).toBe(1);
        // needs-attention includes the RECOVERY_REQUIRED row with its error
        expect(mon.outboundHealth.needsAttention).toHaveLength(1);
        expect(mon.outboundHealth.needsAttention[0].status).toBe('RECOVERY_REQUIRED');
        expect(mon.outboundHealth.needsAttention[0].last_error).toBe('marker absent');
        // quotas
        expect(mon.quotas[0]).toMatchObject({ quota_key: 'EMAIL_SEND:daily', used_count: 4, max_count: 10 });
    });
    it('is empty-safe on a fresh store', () => {
        const mon = listMonitoring(getDb());
        expect(mon.connectors).toEqual([]);
        expect(mon.outboundHealth.needsAttention).toEqual([]);
        expect(mon.outboundHealth.byStatus).toEqual({});
        expect(mon.quotas).toEqual([]);
    });
});
