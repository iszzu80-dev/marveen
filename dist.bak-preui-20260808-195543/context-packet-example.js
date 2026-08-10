// Lean Optimization Phase 2 / P2-B -- the committed Context Packet example.
//
// This is the reference instance of the format. It lives in code (not only in
// markdown) so the committed rendering can be asserted byte-identical against
// renderContextPacket(): if the renderer changes and nobody regenerates
// docs/optimization/context-packet-example.md, the test goes RED instead of the
// example quietly going stale.
//
// HONEST NOTE ON THE HASHES: the contentHash values below are DETERMINISTIC
// FIXTURE hashes -- sha256 of the short literal strings in EXAMPLE_SOURCES, not
// of the current contents of the referenced repo files. A committed example that
// pinned live file hashes would go red on every unrelated edit to those files,
// turning the example test into a tripwire rather than a format guard. In a REAL
// packet the hash is of the real artifact, and artifactRefFromContent() derives
// it from the content the caller actually read.
import { artifactRefFromContent, buildContextPacket, renderContextPacket, } from './context-packet.js';
/** Stand-in contents used to derive the fixture hashes (see the note above). */
const EXAMPLE_SOURCES = {
    audit: 'fixture stand-in for the lean-optimization audit document',
    guard: 'fixture stand-in for src/context-guard.ts',
};
/**
 * A normal-sized packet for a realistic fleet task: it references a long audit
 * and a live source file by path + commit + hash + a short excerpt, and inlines
 * neither.
 */
export const EXAMPLE_PACKET = buildContextPacket({
    cardId: 'a1b2c3d4',
    goal: 'Raise the dashboard token-usage page from per-agent totals to per-agent, per-model totals, ' +
        'reading from the existing token_usage rows. Measurement only: no new collector, no schema change.',
    taskSize: 'normal',
    contextBudgetClass: 'standard',
    references: [
        artifactRefFromContent('docs/optimization/marveen-lean-optimization-audit-2026-07-17.md', '9dd1c27', EXAMPLE_SOURCES.audit, {
            note: 'Section "Token accounting" states the requirement. Read that section only; the rest is out of scope.',
            excerpt: 'Per-agent totals hide which model burned the budget: two agents on the same profile can differ 10x.',
        }),
        artifactRefFromContent('src/context-guard.ts', '9dd1c27', EXAMPLE_SOURCES.guard, {
            note: 'Live thresholds are actPct 0.90 / hardPct 0.97 at :54-55 -- do not "restore" the older 85/90/92/97 numbers.',
            excerpt: 'actPct: 0.90,\nhardPct: 0.97,',
        }),
    ],
    constraints: [
        'Additive only: no change to how token_usage rows are written or ingested.',
        'CostOps stays the single measurement system -- no second usage ledger.',
        'Unpriced models must render as unknown, never as a fabricated 0.',
        'No LLM on the aggregation path; deterministic SQL only.',
    ],
    dataSensitivity: 'internal',
    dataSensitivityNotes: [
        'Aggregates only. No prompt text, no transcript content, no account identifiers in the output.',
        'Referenced artifacts are carried by path + commit + hash; open them locally rather than quoting them.',
    ],
    doneWhen: [
        'The page shows one row per (agent, model) with input/output/cache tokens and estimated cost.',
        'A model with no pricing row renders "unknown", proven by a test.',
        'npx tsc --noEmit exits 0 and the full vitest suite stays green.',
    ],
});
/** Repo-relative path of the committed rendering of EXAMPLE_PACKET. */
export const EXAMPLE_PACKET_DOC_PATH = 'docs/optimization/context-packet-example.md';
/**
 * The committed example document: a fixed provenance header plus the rendered
 * packet. A test asserts the file on disk equals this string exactly, so the
 * example can never drift from the renderer.
 */
export function renderExamplePacketDoc() {
    return ('<!-- GENERATED from src/context-packet-example.ts (EXAMPLE_PACKET) via renderExamplePacketDoc().\n' +
        '     Do not hand-edit: src/__tests__/context-packet.test.ts asserts byte equality.\n' +
        '     Regenerate with: npx tsx scripts/render-context-packet-example.ts -->\n\n' +
        renderContextPacket(EXAMPLE_PACKET));
}
