// Personal Chief of Staff (COS) — daily reconcile (§14 `personal-daily-reconcile`).
//
// The spec asks this job to walk the ledger, the batches, the checkpoints, the
// store, the kanban link and the connector health, and to sort out the
// OUTCOME_UNKNOWN / RECOVERY cases. It was never built, and its absence is why
// the 2026-08-09 failures survived three days: eighteen batches sat OPEN, the
// checkpoint table was empty, and no job existed whose whole purpose was to
// notice exactly that.
//
// Deterministic on purpose. A scheduled task whose body is "look around and
// tell me if something is wrong" is a prompt, and §25/(3) forbids prompt-only
// work — a prompt has no failing state, so it degrades silently into a
// reassuring paragraph. This module returns findings or an empty list, and the
// runner's exit code follows.
//
// Read-only. It diagnoses, it never repairs: an automatic fix here would erase
// the evidence of how the system got into the state, and several of these
// findings (a stuck SENDING row, a cursor that cannot advance) need a human to
// decide before anything is touched.
import { evaluateOutputFloors, breachedFloors } from './output-floor.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const DAY = 86400;
function count(db, sql, ...args) {
    try {
        const r = db.prepare(sql).get(...args);
        return r?.n ?? 0;
    }
    catch {
        return null; // unreadable — the caller reports that, never treats it as zero
    }
}
const stuckLocalApplied = (db, now) => {
    const n = count(db, `SELECT COUNT(*) AS n FROM email_processing WHERE status='LOCAL_APPLIED' AND updated_at < ?`, now - DAY);
    if (n === null)
        return { id: 'email_processing_unreadable', severity: 'CRITICAL', ref: '§8',
            title: 'A feldolgozási tábla nem olvasható', detail: 'email_processing lekérdezés hibára futott',
            action: 'Ellenőrizd a séma-migrációt és a store épségét.' };
    if (n === 0)
        return null;
    return {
        id: 'messages_never_source_committed', severity: 'CRITICAL', ref: '§8, AC-10',
        title: 'Üzenetek ragadtak a lánc közepén',
        detail: `${n} üzenet áll LOCAL_APPLIED állapotban 24 óránál régebben, tehát a forrás-commit nem fut le rájuk.`,
        action: 'A §8 lánc második fele nincs bekötve vagy elakadt. Amíg így van, a rendszer nem tudja, meddig jutott.',
    };
};
const openBatches = (db, now) => {
    const n = count(db, `SELECT COUNT(*) AS n FROM email_processing_batches WHERE status IN ('OPEN','PROCESSING') AND updated_at < ?`, now - DAY);
    if (n === null || n === 0)
        return null;
    return {
        id: 'batches_never_closed', severity: 'CRITICAL', ref: '§8, AC-11',
        title: 'Kötegek maradtak nyitva',
        detail: `${n} köteg egy napnál régebben nyitott. A fiók-cursor csak lezárt kötegen léphet, tehát nem lép.`,
        action: 'Nézd meg, melyik elem nem terminális a kötegben; ha karanténba való, oda kell tenni, explicit policy alapján.',
    };
};
const missingCheckpoint = (db) => {
    let accounts = [];
    let have = new Set();
    try {
        accounts = db.prepare(`SELECT DISTINCT gmail_account_id AS a FROM email_processing`).all().map(r => r.a);
        have = new Set(db.prepare(`SELECT gmail_account_id AS a FROM email_source_checkpoints`).all().map(r => r.a));
    }
    catch {
        return null;
    }
    const missing = accounts.filter(a => !have.has(a));
    if (!missing.length)
        return null;
    return {
        id: 'account_cursor_missing', severity: 'CRITICAL', ref: '§6.4',
        title: 'Van fiók, aminek nincs pozíciója',
        detail: `Cursor nélküli fiók: ${missing.join(', ')}. A rendszer nem tudja, meddig dolgozta fel a postát.`,
        action: 'A batch-lezárás állítja be a cursort; amíg a kötegek nyitva vannak, ez sem jön létre.',
    };
};
const outboundNeedsHuman = (db) => {
    const n = count(db, `SELECT COUNT(*) AS n FROM outbound_ledger WHERE status IN ('RECOVERY_REQUIRED','FAILED_TERMINAL')`);
    if (n === null || n === 0)
        return null;
    return {
        id: 'outbound_needs_human', severity: 'CRITICAL', ref: '§7.3, §19',
        title: 'Kimenő művelet emberre vár',
        detail: `${n} sor RECOVERY_REQUIRED vagy FAILED_TERMINAL állapotban. A végrehajtó ezeket sosem oldja fel magától.`,
        action: 'Nézd meg egyenként, mi történt a küldéssel, és döntsd el: újra, elenged, vagy kompenzáció.',
    };
};
const outcomeUnknown = (db, now) => {
    const n = count(db, `SELECT COUNT(*) AS n FROM outbound_ledger WHERE status IN ('OUTCOME_UNKNOWN','APPLIED_UNVERIFIED') AND updated_at < ?`, now - DAY);
    if (n === null || n === 0)
        return null;
    return {
        id: 'outcome_unknown_aging', severity: 'WARNING', ref: 'v4.2.1 B.1',
        title: 'Bizonytalan kimenetelű küldés áll egy napja',
        detail: `${n} sor OUTCOME_UNKNOWN vagy APPLIED_UNVERIFIED állapotban, 24 óránál régebben.`,
        action: 'Visszaolvasás kell a kereshető jel alapján. Újraküldeni TILOS visszaolvasás nélkül.',
    };
};
const stuckSending = (db, now) => {
    const n = count(db, `SELECT COUNT(*) AS n FROM outbound_ledger WHERE status='SENDING' AND updated_at < ?`, now - 3600);
    if (n === null || n === 0)
        return null;
    return {
        id: 'sending_stuck', severity: 'CRITICAL', ref: '§7.3',
        title: 'Küldés ragadt SENDING állapotban',
        detail: `${n} sor egy óránál régebben SENDING. A folyamat vagy elszállt a hívás közben, vagy a readback nem futott le.`,
        action: 'Visszaolvasás a kereshető jel alapján, MIELŐTT bármit újraküldenél.',
    };
};
const connectorDown = (db) => {
    let rows = [];
    try {
        rows = db.prepare(`SELECT connector_id, status, consecutive_failures FROM connector_health WHERE status IN ('DOWN','DEGRADED')`).all();
    }
    catch {
        return null;
    }
    if (!rows.length)
        return null;
    const down = rows.filter(r => r.status === 'DOWN');
    return {
        id: 'connector_unhealthy', severity: down.length ? 'CRITICAL' : 'WARNING', ref: '§12, §19',
        title: 'Csatlakozó nincs rendben',
        detail: rows.map(r => `${r.connector_id}: ${r.status} (${r.consecutive_failures} hiba egymás után)`).join('; '),
        action: down.length
            ? 'DOWN csatlakozóval nem indul külső művelet. Ha auth-hiba, új hozzájárulás kell.'
            : 'Figyeld; ha nem áll helyre magától, nézd meg a hitelesítést.',
    };
};
const staleClaims = (db, now) => {
    const n = count(db, `SELECT COUNT(*) AS n FROM case_claims WHERE claim_expires_at < ?`, now);
    if (n === null || n === 0)
        return null;
    return {
        id: 'stale_claims', severity: 'WARNING', ref: '§9',
        title: 'Lejárt foglalás maradt a táblában',
        detail: `${n} lejárt claim. Ezek átvehetők, de amíg ott ülnek, egy elszállt futás nyomát jelzik.`,
        action: 'Recovery-check után atomikus upserttel átvehető; nézd meg, mi ölte meg az eredeti futást.',
    };
};
const corporateInPersonal = (db) => {
    let rows = [];
    try {
        // Terminal cases are excluded: a CANCELLED case that names where it moved
        // to is a tombstone, not live contamination. Counting it would keep the
        // alarm ringing after the thing it warned about was fixed, and an alarm
        // that outlives its cause is how people learn to ignore alarms.
        rows = db.prepare(`SELECT case_id, title FROM personal_cases
       WHERE archived_at IS NULL
         AND status NOT IN ('COMPLETED','CANCELLED','ARCHIVED')
         AND (title LIKE '%ZST%' OR description LIKE '%ZST%'
              OR title LIKE '%ONE Magyarorsz%' OR title LIKE '%Product Lab%')`).all();
    }
    catch {
        return null;
    }
    if (!rows.length)
        return null;
    return {
        id: 'corporate_content_in_personal_store', severity: 'CRITICAL', ref: '§19 kritikus, AC-17',
        title: 'Céges tartalom a személyes tárban',
        detail: `${rows.length} ügy: ${rows.slice(0, 4).map(r => r.case_id).join(', ')}`,
        action: 'A spec szerint ez kritikus riasztás. Vagy a Scope Gate hiányzik, vagy a postafiók-szabály engedte át.',
    };
};
const outputFloorBreaches = (db, now) => {
    const breached = breachedFloors(evaluateOutputFloors(db, now));
    if (!breached.length)
        return null;
    const silent = breached.filter(b => b.status === 'SILENT');
    return {
        id: 'output_floor_breached', severity: silent.length ? 'CRITICAL' : 'WARNING', ref: '§19, audit 2026-08-09',
        title: 'Futószalag nem termel',
        detail: breached.map(b => `${b.label}: ${b.observed}/${b.floor} (${b.windowHours}h)`).join('; '),
        action: silent.length
            ? `Nulla termelés itt: ${silent.map(b => b.label).join(', ')}. ${silent[0].meaning}`
            : 'A küszöb alatti futószalagokat nézd meg, mielőtt csendes hétnek könyveled.',
    };
};
const duplicateSendAttempt = (db) => {
    // §19 minimum #1. The UNIQUE constraints make a duplicate physically
    // impossible, so what we look for is the ATTEMPT: two ledger rows for the same
    // campaign+recipient+kind. A silent "the constraint held" is not the same as
    // "nothing tried" — the second means the idempotency key is being derived
    // wrongly somewhere upstream.
    let rows = [];
    try {
        rows = db.prepare(`SELECT COUNT(*) AS n FROM (
         SELECT campaign_id, recipient, action_type, COUNT(*) AS c
         FROM outbound_ledger WHERE campaign_id IS NOT NULL AND recipient IS NOT NULL
         GROUP BY campaign_id, recipient, action_type HAVING c > 1)`).all();
    }
    catch {
        return null;
    }
    const n = rows[0]?.n ?? 0;
    if (!n)
        return null;
    return {
        id: 'duplicate_send_attempt', severity: 'CRITICAL', ref: '§19 kritikus, AC-1',
        title: 'Ugyanannak a címzettnek több küldés indult',
        detail: `${n} kampány+címzett+típus hármas fordul elő többször a ledgerben.`,
        action: 'Az idempotencia-kulcs valahol nem fedi le a küldést. Nézd meg, mielőtt bármit újraindítasz.',
    };
};
const failedReadback = (db) => {
    // §19 minimum #3: a send the provider accepted but we could never verify.
    const n = count(db, `SELECT COUNT(*) AS n FROM outbound_ledger WHERE status='APPLIED_UNVERIFIED'`);
    if (n === null || n === 0)
        return null;
    return {
        id: 'readback_never_succeeded', severity: 'WARNING', ref: '§19, v4.2.1 B.1',
        title: 'Sikertelen visszaolvasás',
        detail: `${n} küldésnél a szolgáltató sikert adott, de a visszaolvasás nem erősítette meg.`,
        action: 'Napi egyeztetés tárgya. Újraküldeni TILOS: a levél nagy eséllyel kiment.',
    };
};
const stalledCampaign = (db, now) => {
    // §19 minimum #4: a campaign that is paused or has not moved.
    let rows = [];
    try {
        rows = db.prepare(`SELECT campaign_id, status FROM campaigns
       WHERE status IN ('PAUSED','DRAFT') AND updated_at < ?`).all(now - 7 * DAY);
    }
    catch {
        return null;
    }
    if (!rows.length)
        return null;
    return {
        id: 'campaign_stalled', severity: 'WARNING', ref: '§19, §15',
        title: 'Kampány áll egy hete',
        detail: rows.map(r => `${r.campaign_id}: ${r.status}`).join('; '),
        action: 'Vagy folytatni kell, vagy lezárni. Egy örökre DRAFT-ban álló kampány elfelejtett szándék.',
    };
};
const expiredApproval = (db, now) => {
    // §19 minimum #5. An approval past its validity is not a bug on its own — it
    // becomes one when the case still expects a send to happen.
    const n = count(db, `SELECT COUNT(*) AS n FROM campaign_approvals WHERE status='APPROVED' AND valid_until IS NOT NULL AND valid_until < ?`, now);
    if (n === null || n === 0)
        return null;
    return {
        id: 'approval_expired', severity: 'WARNING', ref: '§19, §3.2',
        title: 'Lejárt jóváhagyás',
        detail: `${n} jóváhagyás érvényessége lejárt, de még APPROVED státuszban áll.`,
        action: 'Ha a küldés még aktuális, új jóváhagyás kell. A lejárt már úgysem hatalmaz fel semmire.',
    };
};
const repeatedFollowUp = (db) => {
    // §19 minimum #8: the same case chasing the same party again and again.
    let rows = [];
    try {
        rows = db.prepare(`SELECT case_id, COUNT(*) AS c FROM outbound_ledger
       WHERE outbound_kind='FOLLOW_UP' GROUP BY case_id HAVING c >= 3`).all();
    }
    catch {
        return null;
    }
    if (!rows.length)
        return null;
    return {
        id: 'follow_up_repeated', severity: 'WARNING', ref: '§19',
        title: 'Sokadik utánkövetés ugyanabban az ügyben',
        detail: rows.map(r => `${r.case_id}: ${r.c} follow-up`).join('; '),
        action: 'Három sikertelen utánkövetés után nem a negyedik levél a megoldás. Más csatorna vagy Istvan döntése kell.',
    };
};
const radarCheckFailing = (db, now) => {
    // §19 minimum #9: a radar item whose scheduled check is overdue — the price
    // watch is asleep, and a target hit would pass unnoticed.
    const n = count(db, `SELECT COUNT(*) AS n FROM radar_items WHERE status='ACTIVE' AND next_check_at IS NOT NULL AND next_check_at < ?`, now - DAY);
    if (n === null || n === 0)
        return null;
    return {
        id: 'radar_check_overdue', severity: 'WARNING', ref: '§19, §16',
        title: 'Radar-ellenőrzés csúszik',
        detail: `${n} aktív radar-elem esedékes ellenőrzése egy napnál régebben lejárt.`,
        action: 'Az árfigyelés erre az elemre alszik; egy célár-találat észrevétlen maradna.',
    };
};
const cursorBatchMismatch = (db) => {
    // §19 KRITIKUS: the cursor moved past a batch that never terminalised. This is
    // the one that says the system believes it processed mail it did not.
    let n = 0;
    try {
        n = db.prepare(`SELECT COUNT(*) AS n FROM email_source_checkpoints cp
       JOIN email_processing_batches b ON b.gmail_account_id = cp.gmail_account_id
       WHERE b.status IN ('OPEN','PROCESSING') AND b.cursor_after IS NOT NULL
         AND cp.history_cursor IS NOT NULL AND cp.history_cursor >= b.cursor_after`).get().n;
    }
    catch {
        return null;
    }
    if (!n)
        return null;
    return {
        id: 'cursor_past_open_batch', severity: 'CRITICAL', ref: '§19 kritikus, AC-11',
        title: 'A pozíció túllépett egy lezáratlan kötegen',
        detail: `${n} köteg nyitva van, miközben a fiók pozíciója már túl van rajta.`,
        action: 'A rendszer azt hiszi, feldolgozott olyan levelet, amit nem. Ez adatvesztés, nem késés.',
    };
};
const sourceWritePolicyActive = (db) => {
    // A policy exception that nobody can see becomes an assumption. If the cursor
    // is allowed to advance without marking the source, the daily report says so
    // every single day, by design — the cost of the exception has to stay visible
    // for as long as it is in force.
    let policy = {};
    try {
        policy = JSON.parse(readFileSync(join(process.cwd(), 'store', 'cos-source-commit-policy.json'), 'utf8'));
    }
    catch {
        return null;
    }
    if (policy.allowCursorAdvanceWithoutSourceWrite !== true)
        return null;
    const n = count(db, `SELECT COUNT(*) AS n FROM email_processing WHERE last_error LIKE 'source-commit kihagyva%'`);
    return {
        id: 'source_write_policy_active', severity: 'INFO', ref: '§8, A.1 precedens',
        title: 'A pozíció forrás-jelölés NÉLKÜL léphet (érvényes policy)',
        detail: `${n ?? 0} üzenet zárult le így. Ok: ${policy.reason ?? 'nincs megadva'}`,
        action: 'Amint a Gmail-token modify jogot kap, a valódi címkézés bekapcsolható és a kivétel visszavonható.',
    };
};
export const CHECKS = [
    stuckLocalApplied, openBatches, missingCheckpoint,
    outboundNeedsHuman, outcomeUnknown, stuckSending,
    connectorDown, staleClaims, corporateInPersonal, outputFloorBreaches,
    // §19 further minimum + critical alerts
    duplicateSendAttempt, failedReadback, stalledCampaign, expiredApproval,
    repeatedFollowUp, radarCheckFailing, cursorBatchMismatch, sourceWritePolicyActive,
];
/** Run every check. Order of findings: CRITICAL first — a report that buries the
 *  critical line under three warnings gets skimmed. */
export function runDailyReconcile(db, now = Math.floor(Date.now() / 1000), checks = CHECKS) {
    const findings = [];
    for (const c of checks) {
        let f = null;
        try {
            f = c(db, now);
        }
        catch (e) {
            // A check that throws is itself a finding. Swallowing it would make the
            // reconcile quietly narrower every time something breaks underneath it.
            f = {
                id: 'check_threw', severity: 'CRITICAL', ref: '§14',
                title: 'Egy egyeztető ellenőrzés hibára futott',
                detail: String(e.message).slice(0, 200),
                action: 'Az egyeztetés ettől kezdve vak erre a területre. Javítsd, mielőtt a jelentést elhiszed.',
            };
        }
        if (f)
            findings.push(f);
    }
    const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 };
    findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
    const counts = { CRITICAL: 0, WARNING: 0, INFO: 0 };
    for (const f of findings)
        counts[f.severity] += 1;
    return { at: now, findings, counts, clean: findings.length === 0 };
}
/** Plain-text report for the scheduled task / Telegram. Empty string when clean:
 *  the daily job must be silent on a good day, or it becomes wallpaper. */
export function formatReconcileReport(r) {
    if (r.clean)
        return '';
    const lines = [`COS napi egyeztetés: ${r.counts.CRITICAL} kritikus, ${r.counts.WARNING} figyelmeztetés`];
    for (const f of r.findings) {
        lines.push('');
        lines.push(`[${f.severity}] ${f.title} (${f.ref})`);
        lines.push(f.detail);
        lines.push(`Teendő: ${f.action}`);
    }
    return lines.join('\n');
}
