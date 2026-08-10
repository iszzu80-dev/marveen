// Personal Chief of Staff (COS) — outbound RECOVERY_REQUIRED alert.
//
// An outbound action lands in RECOVERY_REQUIRED when the provider reported
// success but the idempotency marker is provably absent on readback (executor
// P1.1). That is an anomaly a human must resolve — the executor will NEVER
// auto-resend it (the provider claimed success, resending risks a double-send).
// Left unsurfaced it would sit silently; this posts it to the bus (marveen relays
// to Telegram) + the daily log so it actually gets seen.
import { createAgentMessage, appendDailyLog } from '../db.js';
/** Build the human-facing text for the current RECOVERY_REQUIRED rows. Returns
 *  null if there are none. Pure over the DB → testable. */
export function buildOutboundRecoveryAlert(db, limit = 20) {
    const rows = db.prepare(`SELECT ledger_id, case_id, action_type, last_error FROM outbound_ledger
     WHERE status='RECOVERY_REQUIRED' ORDER BY created_at ASC LIMIT ?`).all(limit);
    if (rows.length === 0)
        return null;
    const lines = rows.map(r => `- ${r.action_type} (${r.ledger_id}${r.case_id ? `, case ${r.case_id}` : ''}): ${r.last_error ?? 'marker absent after provider success'}`);
    return `⚠️ COS outbound RECOVERY_REQUIRED (${rows.length}): a provider sikert jelzett, de a marker nem talalhato vissza. NEM kuldjuk ujra (dupla-kuldes kockazat) - emberi ellenorzes kell.\n${lines.join('\n')}`;
}
/** Surface RECOVERY_REQUIRED outbound rows: bus message (marveen relays to
 *  Telegram) + daily log. No-op if there are none. */
export function alertOutboundRecovery(db) {
    const content = buildOutboundRecoveryAlert(db);
    if (!content)
        return false;
    createAgentMessage('cos-outbound', 'marveen', content, 'cos-autonomous-recovery');
    appendDailyLog('marveen', `## COS OUTBOUND RECOVERY_REQUIRED\n${content}`);
    return true;
}
