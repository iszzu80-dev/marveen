// Personal Chief of Staff (COS) — output floors.
//
// Every other monitoring surface in this system answers "did something go
// wrong?". None of them answers "did anything happen at all?", and that is the
// gap that hid the 2026-08-09 failures for three days: the email intake produced
// 5 cases in 4 days, every batch stayed open, the progression engine proposed
// zero external actions — and nothing alarmed, because a pipeline that yields
// almost nothing looks exactly like a quiet week.
//
// So each pipeline declares, up front, the minimum it must produce over a
// window. Zero is an ALARM, not silence. The `meaning` field exists because a
// bare "0" reads as calm to a human scanning a dashboard; the row has to say
// what the zero implies about the world.
//
// Read-only, pure DB. No side effects, no alerting here — the caller (Mission
// Control monitoring view, the daily reconcile task) decides what to do with a
// breach.
const DAY = 86400;
/** Count helper: a single-column COUNT(*) query, defensive about a missing table
 *  (a floor over a table that has not been deployed yet reports 0, which is the
 *  honest answer — the pipeline is indeed producing nothing). */
function count(db, sql, since) {
    try {
        const row = db.prepare(sql).get(since);
        return row?.n ?? 0;
    }
    catch {
        return 0;
    }
}
/** The declared floors. Adding a pipeline without a floor is how this class of
 *  failure comes back — if you build a producer, declare what it must produce. */
export const OUTPUT_FLOORS = [
    {
        id: 'email_to_case',
        label: 'Emailből ügy',
        windowSec: 2 * DAY,
        floor: 1,
        ref: '§8 / audit 2026-08-09',
        meaning: 'Nulla azt jelenti, hogy két napja egyetlen levélből sem lett ügy. Ez nem csendes hét, hanem vak levélfigyelés.',
        measure: (db, since) => count(db, `SELECT COUNT(*) AS n FROM email_processing WHERE case_id IS NOT NULL AND created_at >= ?`, since),
    },
    {
        id: 'message_terminal',
        label: 'Üzenet a végállapotig',
        windowSec: 2 * DAY,
        floor: 1,
        ref: '§8, AC-10',
        meaning: 'Nulla azt jelenti, hogy a bejövő lánc második fele nem fut: a forrás-commit soha nem történik meg.',
        measure: (db, since) => count(db, `SELECT COUNT(*) AS n FROM email_processing WHERE status = 'SOURCE_COMMITTED' AND updated_at >= ?`, since),
    },
    {
        id: 'batch_closed',
        label: 'Lezárt köteg',
        windowSec: 2 * DAY,
        floor: 1,
        ref: '§8, AC-11',
        meaning: 'Nulla azt jelenti, hogy a kötegek nyitva maradnak, tehát a fiók-cursor soha nem léphet.',
        measure: (db, since) => count(db, `SELECT COUNT(*) AS n FROM email_processing_batches WHERE status = 'TERMINAL' AND updated_at >= ?`, since),
    },
    {
        id: 'case_movement',
        label: 'Ügy-mozgás',
        windowSec: 2 * DAY,
        floor: 1,
        ref: '§6.1',
        meaning: 'Nulla azt jelenti, hogy egyetlen ügy sem váltott állapotot két napja. Az ügyek állnak, nem haladnak.',
        measure: (db, since) => count(db, `SELECT COUNT(*) AS n FROM personal_case_events WHERE new_status IS NOT NULL AND created_at >= ?`, since),
    },
    {
        id: 'progression_action',
        label: 'Javasolt külső művelet',
        windowSec: DAY,
        floor: 1,
        ref: '§25/(3)',
        meaning: 'Nulla azt jelenti, hogy a haladás-motor árnyék módban jár: dönt, de a döntést eldobja. Sok futás nulla művelettel nem működés, hanem szimuláció.',
        measure: (db, since) => count(db, `SELECT COUNT(*) AS n FROM case_progression_runs
       WHERE started_at >= ? AND action_ids_json IS NOT NULL
         AND action_ids_json NOT IN ('', '[]', 'null')`, since),
    },
    {
        id: 'radar_check',
        label: 'Radar-megfigyelés',
        windowSec: DAY,
        floor: 1,
        ref: '§16',
        meaning: 'Nulla azt jelenti, hogy az árfigyelés nem fut, tehát egy célár-találat észrevétlen maradna.',
        measure: (db, since) => count(db, `SELECT COUNT(*) AS n FROM radar_observations WHERE observed_at >= ?`, since),
    },
];
/** Evaluate every declared floor against the store.
 *
 *  SILENT is deliberately separate from BELOW_FLOOR: "produced less than
 *  expected" and "produced nothing at all" are different failures, and the
 *  second is the one that masquerades as calm. */
export function evaluateOutputFloors(db, now = Math.floor(Date.now() / 1000), specs = OUTPUT_FLOORS) {
    return specs.map((s) => {
        const observed = s.measure(db, now - s.windowSec);
        const status = observed === 0 ? 'SILENT' : observed < s.floor ? 'BELOW_FLOOR' : 'OK';
        return {
            id: s.id, label: s.label, ref: s.ref, observed, floor: s.floor,
            windowHours: Math.round(s.windowSec / 3600), status, meaning: s.meaning,
        };
    });
}
/** The floors that are not OK, worst first (SILENT before BELOW_FLOOR). */
export function breachedFloors(results) {
    const rank = { SILENT: 0, BELOW_FLOOR: 1, OK: 2 };
    return results.filter((r) => r.status !== 'OK').sort((a, b) => rank[a.status] - rank[b.status]);
}
