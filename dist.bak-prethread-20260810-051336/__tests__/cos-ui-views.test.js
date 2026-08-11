import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { createCase } from '../cos/case-store.js';
import { planAction } from '../cos/executor.js';
import { createCampaign, approveCampaign, recordApproval } from '../cos/campaigns.js';
import { createRadarItem, recordObservation } from '../cos/radar.js';
import { listOutbound, listCampaignsSummary, listRadarSummary } from '../web/routes/cos.js';
// Mission Control read-only view queries (outbound / campaigns / radar). Exercises
// the exact SQL the routes run, against a seeded DB, so a column typo fails here.
const NOW = 1_000_000;
describe('COS Mission Control view queries', () => {
    beforeEach(() => {
        initDatabase(':memory:');
        createCase(getDb(), { caseId: 'c1', title: 'Spain', caseType: 'TRAVEL' }, NOW);
    });
    it('listOutbound returns ledger rows', () => {
        const db = getDb();
        planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 1, payload: { to: 'a@b.c' } }, NOW);
        const rows = listOutbound(db);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ action_type: 'EMAIL_SEND', status: 'PLANNED', case_id: 'c1' });
    });
    it('listCampaignsSummary counts only current-version approvals', () => {
        const db = getDb();
        createCampaign(db, { campaignId: 'k1', caseId: 'c1', campaignType: 'QUOTE_REQUEST', templateHash: 'T' }, NOW);
        approveCampaign(db, 'k1', NOW);
        recordApproval(db, { approvalId: 'a1', campaignId: 'k1', approvedBy: 'i', templateHash: 'T', renderedPayloadHash: 'R', allowedRecipients: ['teszt@pelda.hu'], allowedChannels: ['EMAIL'] }, NOW);
        const rows = listCampaignsSummary(db);
        expect(rows[0]).toMatchObject({ campaign_type: 'QUOTE_REQUEST', status: 'APPROVED', approved_current: 1 });
    });
    it('listRadarSummary includes the latest observation price', () => {
        const db = getDb();
        createRadarItem(db, { radarId: 'r1', caseId: 'c1', kind: 'RENTAL', label: 'VLC→AGP', targetPrice: 80000, currency: 'HUF', checkIntervalSec: 3600 }, NOW);
        recordObservation(db, 'r1', { bestPrice: 87900, offerCount: 10 }, NOW + 3600); // above target → stays ACTIVE
        const rows = listRadarSummary(db);
        expect(rows[0]).toMatchObject({ label: 'VLC→AGP', status: 'ACTIVE', target_price: 80000, latest_price: 87900 });
    });
});
