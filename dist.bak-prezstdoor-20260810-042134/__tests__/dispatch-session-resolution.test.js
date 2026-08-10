// P2-A follow-on: live session_id population for dispatch attribution.
//
// The gap this closes: every tmux-driven origin created dispatch rows with
// session_id = NULL, so correlateTokenUsageToDispatches() -- which deliberately
// SKIPS null-session dispatches instead of guessing -- never fired for real
// traffic. The rule, the column and the join were all built and tested; only the
// live population was missing. The end-to-end test at the bottom is the one that
// would have caught that: it fails if resolution yields null.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, utimesSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, getDb } from '../db.js';
import { createDispatch, correlateTokenUsageToDispatches, } from '../costops/dispatch.js';
import { resolveCurrentSessionId, resolveSessionIdForCwd, discoverAgentSources, encodeProjectPath, } from '../web/transcript-sources.js';
// A fixture PROJECT_ROOT that is deliberately NOT this checkout, so the mapping
// under test can never accidentally resolve against the real ~/.claude/projects.
const FIXTURE_PROJECT_ROOT = '/home/fixture/marveen';
const MAIN_AGENT = 'fixture-main';
let sandbox;
let projectsDir;
/** roots injected into every call -- no monkey-patching of homedir needed. */
function roots() {
    return { projectsDir, projectRoot: FIXTURE_PROJECT_ROOT, mainAgentId: MAIN_AGENT };
}
/**
 * Write a transcript whose FIRST line carries `sessionId` (exactly like a real
 * Claude Code transcript) and stamp a deterministic mtime.
 */
function writeTranscript(dir, fileBase, opts) {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${fileBase}.jsonl`);
    const first = opts.sessionId === null
        ? JSON.stringify({ type: 'mode', mode: 'normal' }) // no sessionId field
        : JSON.stringify({ type: 'last-prompt', sessionId: opts.sessionId ?? fileBase });
    writeFileSync(path, first + '\n' + JSON.stringify({ type: 'user' }) + '\n');
    utimesSync(path, opts.mtimeSec, opts.mtimeSec);
    return path;
}
const AGENT_DIR = (agent) => join(projectsDir, `${encodeProjectPath(FIXTURE_PROJECT_ROOT)}-agents-${agent}`);
beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'p2a-session-resolve-'));
    projectsDir = join(sandbox, 'projects');
    mkdirSync(projectsDir, { recursive: true });
});
afterEach(() => {
    try {
        chmodSync(projectsDir, 0o755);
    }
    catch { /* may not exist */ }
    rmSync(sandbox, { recursive: true, force: true });
});
describe('resolveCurrentSessionId (deterministic newest-transcript rule)', () => {
    it('picks the MOST RECENTLY MODIFIED transcript for that agent', () => {
        const dir = AGENT_DIR('codeworker');
        writeTranscript(dir, 'sess-old', { mtimeSec: 1_700_000_000 });
        writeTranscript(dir, 'sess-newest', { mtimeSec: 1_700_009_999 });
        writeTranscript(dir, 'sess-middle', { mtimeSec: 1_700_005_000 });
        expect(resolveCurrentSessionId('codeworker', roots())).toBe('sess-newest');
    });
    it('prefers the first line sessionId field over the filename', () => {
        const dir = AGENT_DIR('devops');
        // Filename and sessionId deliberately disagree: the field wins.
        writeTranscript(dir, 'filename-not-the-id', { sessionId: 'real-session-uuid', mtimeSec: 1_700_000_500 });
        expect(resolveCurrentSessionId('devops', roots())).toBe('real-session-uuid');
    });
    it('falls back to the basename when the first line carries no sessionId', () => {
        const dir = AGENT_DIR('devops');
        writeTranscript(dir, 'basename-is-the-id', { sessionId: null, mtimeSec: 1_700_000_500 });
        expect(resolveCurrentSessionId('devops', roots())).toBe('basename-is-the-id');
    });
    it('resolves the MAIN agent from the encoded PROJECT_ROOT dir (same rule, no second regex)', () => {
        writeTranscript(join(projectsDir, encodeProjectPath(FIXTURE_PROJECT_ROOT)), 'main-sess', { mtimeSec: 1_700_000_100 });
        expect(resolveCurrentSessionId(MAIN_AGENT, roots())).toBe('main-sess');
    });
    it('resolves agents whose name contains digits and hyphens', () => {
        writeTranscript(AGENT_DIR('frontendfejleszto2'), 'fe2-sess', { mtimeSec: 1_700_000_100 });
        writeTranscript(AGENT_DIR('davinci-ocura'), 'dav-sess', { mtimeSec: 1_700_000_100 });
        expect(resolveCurrentSessionId('frontendfejleszto2', roots())).toBe('fe2-sess');
        expect(resolveCurrentSessionId('davinci-ocura', roots())).toBe('dav-sess');
    });
    it('IGNORES nested sub-agent transcripts even when they are newer', () => {
        const dir = AGENT_DIR('codeworker');
        writeTranscript(dir, 'current-session', { mtimeSec: 1_700_050_000 });
        // Claude Code puts sub-agent transcripts under <parent-session-id>/subagents/
        // and they carry the PARENT's sessionId. A sub-agent of an OLD session that
        // is still writing must not out-mtime the CURRENT session's own transcript.
        writeTranscript(dir, 'previous-session', { mtimeSec: 1_700_000_000 });
        writeTranscript(join(dir, 'previous-session', 'subagents'), 'agent-abc', {
            sessionId: 'previous-session', mtimeSec: 1_700_099_999,
        });
        expect(resolveCurrentSessionId('codeworker', roots())).toBe('current-session');
    });
    it('returns null for an unknown agent, an agent dir with no transcript, and a missing projects dir', () => {
        writeTranscript(AGENT_DIR('codeworker'), 'sess-a', { mtimeSec: 1_700_000_000 });
        expect(resolveCurrentSessionId('no-such-agent', roots())).toBeNull();
        mkdirSync(AGENT_DIR('empty-agent'), { recursive: true });
        expect(resolveCurrentSessionId('empty-agent', roots())).toBeNull();
        expect(resolveCurrentSessionId('codeworker', { ...roots(), projectsDir: join(sandbox, 'does-not-exist') })).toBeNull();
        expect(resolveCurrentSessionId('', roots())).toBeNull();
    });
    it('does NOT throw when the projects path is not a directory (ENOTDIR)', () => {
        const asFile = join(sandbox, 'projects-is-a-file');
        writeFileSync(asFile, 'not a directory');
        expect(() => resolveCurrentSessionId('codeworker', { ...roots(), projectsDir: asFile })).not.toThrow();
        expect(resolveCurrentSessionId('codeworker', { ...roots(), projectsDir: asFile })).toBeNull();
    });
    it('does NOT throw when the agent transcript dir is unreadable (EACCES)', () => {
        const dir = AGENT_DIR('codeworker');
        writeTranscript(dir, 'sess-a', { mtimeSec: 1_700_000_000 });
        // root ignores mode bits, so this assertion is only meaningful unprivileged.
        if (typeof process.getuid === 'function' && process.getuid() === 0)
            return;
        chmodSync(dir, 0o000);
        try {
            expect(() => resolveCurrentSessionId('codeworker', roots())).not.toThrow();
            expect(resolveCurrentSessionId('codeworker', roots())).toBeNull();
        }
        finally {
            chmodSync(dir, 0o755);
        }
    });
    it('does NOT throw when a transcript is unreadable -- it degrades to the basename', () => {
        const dir = AGENT_DIR('codeworker');
        const p = writeTranscript(dir, 'unreadable-sess', { sessionId: 'field-id', mtimeSec: 1_700_000_000 });
        if (typeof process.getuid === 'function' && process.getuid() === 0)
            return;
        chmodSync(p, 0o000);
        try {
            // Head read fails -> basename fallback, never a throw and never invented.
            expect(resolveCurrentSessionId('codeworker', roots())).toBe('unreadable-sess');
        }
        finally {
            chmodSync(p, 0o644);
        }
    });
});
describe('resolveSessionIdForCwd (agent-worker: session outside the agent mapping)', () => {
    it('encodes the cwd into the project dir name and picks the newest transcript', () => {
        const workerHome = '/home/fixture/.marveen-worker';
        const dir = join(projectsDir, encodeProjectPath(workerHome));
        writeTranscript(dir, 'worker-old', { mtimeSec: 1_700_000_000 });
        writeTranscript(dir, 'worker-new', { mtimeSec: 1_700_000_900 });
        expect(resolveSessionIdForCwd(workerHome, { projectsDir })).toBe('worker-new');
    });
    it('returns null for a cwd with no transcript dir, and for an empty cwd', () => {
        expect(resolveSessionIdForCwd('/home/fixture/.nope-worker', { projectsDir })).toBeNull();
        expect(resolveSessionIdForCwd('', { projectsDir })).toBeNull();
    });
});
describe('one copy of the transcript->agent rule', () => {
    it('discoverAgentSources and resolveCurrentSessionId agree on the mapping', () => {
        writeTranscript(AGENT_DIR('ba'), 'ba-sess', { mtimeSec: 1_700_000_000 });
        writeTranscript(join(projectsDir, encodeProjectPath(FIXTURE_PROJECT_ROOT)), 'main-sess', { mtimeSec: 1_700_000_000 });
        // A worktree-style dir belongs to no agent under either consumer.
        mkdirSync(join(projectsDir, '-home-fixture-marveen--claude-worktrees-x'), { recursive: true });
        const agents = discoverAgentSources(roots()).map(s => s.agent).sort();
        expect(agents).toEqual(['ba', MAIN_AGENT].sort());
        for (const a of agents)
            expect(resolveCurrentSessionId(a, roots())).not.toBeNull();
    });
    it('token-usage.ts imports the shared helper instead of keeping a second regex', () => {
        const src = readFileSync(new URL('../web/token-usage.ts', import.meta.url), 'utf-8');
        expect(src).toContain("from './transcript-sources.js'");
        expect(src).not.toMatch(/-agents-\(\[a-z0-9-\]\+\)\$/);
    });
});
// ---------------------------------------------------------------------------
// END-TO-END: the proof the follow-on is actually closed.
//
// Before this change, an origin created the dispatch with session_id = NULL and
// correlateTokenUsageToDispatches() returned 0 -- the token rows stayed
// unattributed forever. Now the origin resolves the live session id, so the
// window join lands. Mutating resolveCurrentSessionId to return null makes this
// test go RED (verified), which is exactly the gap it discriminates.
// ---------------------------------------------------------------------------
describe('END-TO-END: resolved session_id makes token rows attributable', () => {
    const T0 = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000);
    beforeEach(() => { initDatabase(':memory:'); });
    function insertTokenUsage(agent, sessionId, ts) {
        getDb().prepare(`
      INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens)
      VALUES (?, ?, ?, 1000, 200, 0, 0)
    `).run(agent, sessionId, ts);
    }
    it('origin-resolved session_id -> correlateTokenUsageToDispatches attributes the rows', () => {
        const db = getDb();
        // 1. The agent's live transcript, as Claude Code would have written it.
        writeTranscript(AGENT_DIR('codeworker'), 'stale-earlier-session', { mtimeSec: 1_700_000_000 });
        writeTranscript(AGENT_DIR('codeworker'), 'file-name-differs', { sessionId: 'live-session-uuid', mtimeSec: 1_700_050_000 });
        // 2. What an origin now does at dispatch time (kanban/router/scheduler).
        const resolved = resolveCurrentSessionId('codeworker', roots());
        expect(resolved).toBe('live-session-uuid');
        const dispatchId = createDispatch(db, { source: 'kanban', agent: 'codeworker', cardId: 'card-1', sessionId: resolved }, T0 * 1000);
        expect(db.prepare('SELECT session_id FROM dispatches WHERE dispatch_id = ?').get(dispatchId).session_id)
            .toBe('live-session-uuid');
        // 3. Token rows the agent then burns in that session, inside the window.
        insertTokenUsage('codeworker', 'live-session-uuid', T0 + 30);
        insertTokenUsage('codeworker', 'live-session-uuid', T0 + 600);
        // Control rows that must NOT be swept in: wrong session, wrong agent,
        // and a row BEFORE the dispatch window opened.
        insertTokenUsage('codeworker', 'stale-earlier-session', T0 + 30);
        insertTokenUsage('devops', 'live-session-uuid', T0 + 30);
        insertTokenUsage('codeworker', 'live-session-uuid', T0 - 30);
        // 4. The correlation now fires for real traffic (it returned 0 before).
        const linked = correlateTokenUsageToDispatches(db);
        expect(linked).toBe(2);
        const attributed = db.prepare('SELECT agent, session_id, timestamp FROM token_usage WHERE dispatch_id = ? ORDER BY timestamp').all(dispatchId);
        expect(attributed).toEqual([
            { agent: 'codeworker', session_id: 'live-session-uuid', timestamp: T0 + 30 },
            { agent: 'codeworker', session_id: 'live-session-uuid', timestamp: T0 + 600 },
        ]);
        // Nothing else got attributed to this dispatch.
        const unattributed = db.prepare('SELECT COUNT(*) AS n FROM token_usage WHERE dispatch_id IS NULL').get();
        expect(unattributed.n).toBe(3);
    });
    it('unresolvable agent keeps session_id NULL and the correlation still skips it (no guessing)', () => {
        const db = getDb();
        // No transcript dir for this agent at all -> null, never invented.
        const resolved = resolveCurrentSessionId('ghost-agent', roots());
        expect(resolved).toBeNull();
        createDispatch(db, { source: 'kanban', agent: 'ghost-agent', sessionId: resolved }, T0 * 1000);
        insertTokenUsage('ghost-agent', 'some-session', T0 + 30);
        expect(correlateTokenUsageToDispatches(db)).toBe(0);
    });
});
