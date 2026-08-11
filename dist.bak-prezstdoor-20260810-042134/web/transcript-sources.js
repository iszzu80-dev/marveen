// Shared transcript <-> agent mapping (ONE copy of the rule).
//
// Claude Code writes every session's transcript as `<session-id>.jsonl` inside
// ~/.claude/projects/<encoded-cwd>/. Two consumers need the SAME mapping:
//
//   1. token-usage.ts    -- reverse-maps a transcript dir to the agent whose
//                           token rows it produces (collectTokenUsage).
//   2. dispatch origins   -- P2-A needs the agent's CURRENTLY-LIVE session id so
//                           the dispatch row can carry session_id, which is what
//                           correlateTokenUsageToDispatches() joins on.
//
// The mapping rule (dir suffix `-agents-<name>` => that agent; the encoded
// PROJECT_ROOT dir => the main agent) lives here ONLY. token-usage.ts imports
// it rather than keeping a second copy of the regex.
//
// DATA SENSITIVITY: nothing here reads prompt/response content. The only bytes
// ever read from a transcript are the FIRST line's `sessionId` field (an opaque
// uuid); no message text, no PII, no credential is touched or logged.
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js';
export const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
// Claude Code encodes a project's absolute path into a directory name by
// replacing every non-alphanumeric/non-dash character with `-`. The main
// agent's transcripts live under that exact directory, regardless of what
// the agent calls itself.
export function encodeProjectPath(p) {
    return p.replace(/[^a-zA-Z0-9-]/g, '-');
}
/** Map every ~/.claude/projects subdir to the agent that owns it. */
export function discoverAgentSources(roots = {}) {
    const projectsDir = roots.projectsDir ?? PROJECTS_DIR;
    const projectRoot = roots.projectRoot ?? PROJECT_ROOT;
    const mainAgentId = roots.mainAgentId ?? MAIN_AGENT_ID;
    const sources = [];
    if (!existsSync(projectsDir))
        return sources;
    const mainDirName = encodeProjectPath(projectRoot);
    for (const entry of readdirSync(projectsDir)) {
        const full = join(projectsDir, entry);
        let stat;
        try {
            stat = statSync(full);
        }
        catch {
            continue;
        }
        if (!stat.isDirectory())
            continue;
        // sanitizeAgentName() allows [a-z0-9-], so the old /([a-z]+)$/ silently
        // skipped every agent with a digit or a hyphen in its name -- the whole
        // per-project worker fleet (davinci-ocura, vermeer-fressa, ...) never
        // appeared in the token monitor at all. Not zero usage: no rows.
        const agentMatch = entry.match(/-agents-([a-z0-9-]+)$/);
        if (agentMatch) {
            sources.push({ agent: agentMatch[1], projectDir: full });
        }
        else if (entry === mainDirName) {
            sources.push({ agent: mainAgentId, projectDir: full });
        }
    }
    return sources;
}
// Only the first line is read; a transcript's opening line carries sessionId.
const HEAD_BYTES = 4096;
/**
 * Read `sessionId` out of a transcript's FIRST line. Returns null on anything
 * unexpected (empty file, truncated/invalid first line, unreadable fd) so the
 * caller falls back to the file's basename, which Claude Code sets to the same
 * session id. Never throws.
 */
function readSessionIdFromHead(filePath) {
    let fd = null;
    try {
        fd = openSync(filePath, 'r');
        const buf = Buffer.alloc(HEAD_BYTES);
        const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
        if (n <= 0)
            return null;
        const text = buf.subarray(0, n).toString('utf-8');
        const nl = text.indexOf('\n');
        if (nl < 0 && n === HEAD_BYTES)
            return null; // first line longer than the peek
        const line = (nl >= 0 ? text.slice(0, nl) : text).trim();
        if (!line)
            return null;
        const sid = JSON.parse(line).sessionId;
        return typeof sid === 'string' && sid ? sid : null;
    }
    catch {
        return null;
    }
    finally {
        if (fd !== null) {
            try {
                closeSync(fd);
            }
            catch { /* already closed */ }
        }
    }
}
/**
 * Newest (highest mtime) top-level `*.jsonl` across `dirs` -> its session id.
 *
 * Top-level ONLY, deliberately. Nested `<session-id>/subagents/*.jsonl` files
 * carry their PARENT session's sessionId (verified against live transcripts), so
 * including them would add nothing -- but a sub-agent of an OLD session that is
 * still writing could out-mtime the CURRENT session's top-level file and resolve
 * the dispatch to the wrong (previous) session. Ties on mtime resolve to the
 * lexicographically greatest path, so the result is deterministic rather than
 * readdir-order dependent.
 */
function newestSessionId(dirs) {
    let best = null;
    for (const dir of dirs) {
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.endsWith('.jsonl'))
                continue;
            const full = join(dir, entry);
            let stat;
            try {
                stat = statSync(full);
            }
            catch {
                continue;
            }
            if (!stat.isFile())
                continue;
            if (!best || stat.mtimeMs > best.mtimeMs || (stat.mtimeMs === best.mtimeMs && full > best.path)) {
                best = { path: full, mtimeMs: stat.mtimeMs };
            }
        }
    }
    if (!best)
        return null;
    return readSessionIdFromHead(best.path) ?? basename(best.path, '.jsonl');
}
/**
 * The agent's currently-live Claude Code session id, or null when it cannot be
 * determined. Deterministic and rule-based (newest-mtime transcript in the
 * agent's project dir(s)); NO LLM, no guessing -- an agent with no transcript
 * dir, or a dir with no .jsonl, yields null so the dispatch row keeps
 * session_id NULL instead of inventing one.
 *
 * P2-A calls this on the hot dispatch path, so it NEVER throws (program
 * principle 20: a measurement fault must not block a send) and never reads more
 * than one 4 KB head per candidate.
 *
 * Scope: LOCAL transcripts only. A remote-host agent's transcripts live on that
 * host, so callers pass null for a remote target rather than resolving a stale
 * local dir.
 */
export function resolveCurrentSessionId(agent, roots = {}) {
    try {
        if (!agent)
            return null;
        const dirs = discoverAgentSources(roots)
            .filter(s => s.agent === agent)
            .map(s => s.projectDir);
        if (dirs.length === 0)
            return null;
        return newestSessionId(dirs);
    }
    catch {
        return null;
    }
}
/**
 * Same rule keyed by a session's CWD instead of an agent id, for a Claude Code
 * session whose project dir is not part of the agent mapping (the interactive
 * agent-worker runs in ~/.<id>-worker, outside PROJECT_ROOT/agents). Never
 * throws; returns null when the encoded dir or a transcript is missing.
 */
export function resolveSessionIdForCwd(cwd, roots = {}) {
    try {
        if (!cwd)
            return null;
        const dir = join(roots.projectsDir ?? PROJECTS_DIR, encodeProjectPath(cwd));
        return newestSessionId([dir]);
    }
    catch {
        return null;
    }
}
