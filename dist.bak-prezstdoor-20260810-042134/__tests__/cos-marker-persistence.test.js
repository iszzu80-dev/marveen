import { describe, it, expect } from 'vitest';
import { GmailSendAdapter, DryRunTransport } from '../cos/adapters/gmail-send.js';
import { verifyMarkerPersistence, markerPersistenceGate, probeAction } from '../cos/marker-persistence.js';
// AC-26: the Gmail adapter must PROVE its idempotency marker round-trips (send →
// read back from Sent by the marker) before it is granted EXECUTE. If it cannot,
// it stays PREPARE. This is the gate that keeps a blind-readback adapter from
// ever being allowed to send autonomously.
const SAMPLE = probeAction('mv-probe-1', { to: 'self@example.com', subject: 'marker probe', body: 'x' });
describe('marker persistence gate (AC-26)', () => {
    it('GmailSendAdapter over a working transport: marker round-trips → EXECUTE', async () => {
        const adapter = new GmailSendAdapter(new DryRunTransport());
        const report = await verifyMarkerPersistence(adapter, SAMPLE);
        expect(report.passed).toBe(true);
        expect(report.sent).toBe(true);
        expect(report.readbackFound).toBe(true);
        expect(report.refMatches).toBe(true); // the read-back message id == the sent id
        expect(markerPersistenceGate(report)).toBe('EXECUTE');
    });
    it('a transport whose Sent search is unreachable → not available → PREPARE', async () => {
        const t = new DryRunTransport();
        t.readbackUnavailable = true;
        const report = await verifyMarkerPersistence(new GmailSendAdapter(t), SAMPLE);
        expect(report.passed).toBe(false);
        expect(report.readbackAvailable).toBe(false);
        expect(markerPersistenceGate(report)).toBe('PREPARE');
    });
    it('an adapter whose marker cannot be found on readback → PREPARE (blind readback rejected)', async () => {
        // send "succeeds" but readback never finds the marker → unproven → not EXECUTE
        const blind = {
            actionType: 'EMAIL_SEND',
            async send() { return { externalRef: 'id-1' }; },
            async readback() { return { found: false }; },
        };
        const report = await verifyMarkerPersistence(blind, SAMPLE);
        expect(report.passed).toBe(false);
        expect(report.readbackFound).toBe(false);
        expect(markerPersistenceGate(report)).toBe('PREPARE');
    });
    it('an adapter whose send throws → PREPARE', async () => {
        const broken = {
            actionType: 'EMAIL_SEND',
            async send() { throw new Error('no transport'); },
            async readback() { return { found: false }; },
        };
        const report = await verifyMarkerPersistence(broken, SAMPLE);
        expect(report.passed).toBe(false);
        expect(report.sent).toBe(false);
        expect(markerPersistenceGate(report)).toBe('PREPARE');
    });
});
