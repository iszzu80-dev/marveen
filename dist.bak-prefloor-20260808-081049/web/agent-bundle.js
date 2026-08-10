import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync, readdirSync, statSync, } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { agentDir } from './agent-config.js';
import { sanitizeAgentName } from './sanitize.js';
import { atomicWriteFileSync } from './atomic-write.js';
// Portable per-agent export/import bundle.
//
// An "agent" on disk is the directory `agents/<name>/`. This module packs that
// directory into a single self-describing `.tar.gz` so one (or a few) chosen
// agents can be moved to another machine WITHOUT dragging the whole fleet or
// the global SQLite DB (that is what scripts/backup.sh is for). The bundle is
// the unit a user downloads from the dashboard on machine A and uploads on
// machine B.
//
// Two trust levels, selected at export time:
//   - secrets EXCLUDED (default): identity + behaviour only, safe to share.
//   - secrets INCLUDED: also the channel bot tokens (.env) + pairing state, for
//     a confidential move between the operator's own machines.
//
// We shell out to the system `tar` (same choice as scripts/backup.sh) rather
// than add a tar dependency: it is present on every macOS/Linux host the fleet
// runs on, and a staging dir keeps the archive layout identical across bsdtar
// and GNU tar (see the staging note in backup.sh).
export const BUNDLE_SCHEMA_VERSION = 1;
// Files/dirs that make up a portable agent, RELATIVE to agents/<name>/.
// Identity + behaviour, no machine-specific runtime state. These are copied
// regardless of the secrets flag.
const PORTABLE_ENTRIES = [
    'agent-config.json',
    'CLAUDE.md',
    'SOUL.md',
    '.mcp.json',
    'avatar.png',
    'avatar.jpg',
    'avatar.jpeg',
    'avatar.webp',
    '.claude/settings.json',
    '.claude/skills',
    '.claude/hooks',
    'memory',
];
// Channel secret files, relative to agents/<name>/. Only copied when the
// operator explicitly opts into a secrets-bearing export. The provider subdir
// (telegram/slack/discord) is discovered at pack time.
const CHANNEL_STATE_ROOT = join('.claude', 'channels');
const CHANNEL_SECRET_FILES = ['.env', 'access.json', 'invites.json'];
const CHANNEL_SECRET_DIRS = ['approved'];
// agent-config.json keys that are machine-specific and must NOT survive a move
// to another host: a remote agent's ssh host/workdir and a per-agent
// CLAUDE_CONFIG_DIR point at paths/credentials that only exist on the source
// machine. Stripped on import so an imported agent starts as a clean local
// agent the operator can re-point if needed.
const MACHINE_SPECIFIC_CONFIG_KEYS = ['remoteHost', 'remoteWorkdir', 'claudeConfigDir'];
function makeTempDir(prefix) {
    return mkdtempSync(join(tmpdir(), prefix));
}
// Recursively copy a relative entry from <srcRoot> into <dstRoot>, preserving
// its relative path. No-op when the source does not exist (a fresh agent may
// lack SOUL.md, an avatar, skills, etc. -- absence is normal, not an error).
function copyEntryInto(srcRoot, dstRoot, rel) {
    const src = join(srcRoot, rel);
    if (!existsSync(src))
        return;
    const dst = join(dstRoot, rel);
    mkdirSync(join(dst, '..'), { recursive: true });
    cpSync(src, dst, { recursive: true });
}
// Stage the portable subset of an agent's source dir into <stageAgentDir>,
// optionally including channel secrets. Returns the list of relative entries
// actually staged. Pure-ish: reads <srcRoot>, writes only the staging dir, and
// never touches AGENTS_BASE_DIR -- so it is hermetically testable against an
// arbitrary source tree. The agentDir() resolution lives in the thin wrappers.
export function stageAgentDirForExport(srcRoot, stageAgentDir, includeSecrets) {
    if (!existsSync(srcRoot))
        throw new Error(`Agent source not found: ${srcRoot}`);
    mkdirSync(stageAgentDir, { recursive: true });
    const staged = [];
    for (const rel of PORTABLE_ENTRIES) {
        if (existsSync(join(srcRoot, rel))) {
            copyEntryInto(srcRoot, stageAgentDir, rel);
            staged.push(rel);
        }
    }
    if (includeSecrets) {
        const channelsRoot = join(srcRoot, CHANNEL_STATE_ROOT);
        if (existsSync(channelsRoot)) {
            for (const provider of readdirSync(channelsRoot)) {
                const providerDir = join(channelsRoot, provider);
                try {
                    if (!statSync(providerDir).isDirectory())
                        continue;
                }
                catch {
                    continue;
                }
                for (const f of CHANNEL_SECRET_FILES) {
                    const rel = join(CHANNEL_STATE_ROOT, provider, f);
                    if (existsSync(join(srcRoot, rel))) {
                        copyEntryInto(srcRoot, stageAgentDir, rel);
                        staged.push(rel);
                    }
                }
                for (const d of CHANNEL_SECRET_DIRS) {
                    const rel = join(CHANNEL_STATE_ROOT, provider, d);
                    if (existsSync(join(srcRoot, rel))) {
                        copyEntryInto(srcRoot, stageAgentDir, rel);
                        staged.push(rel);
                    }
                }
            }
        }
    }
    return staged;
}
// Thin wrapper: resolve the named agent's dir under AGENTS_BASE_DIR, then stage.
export function stageAgentForExport(name, stageAgentDir, includeSecrets) {
    return stageAgentDirForExport(agentDir(name), stageAgentDir, includeSecrets);
}
// Build a .tar.gz bundle of agent <name> at <outPath>. Returns the manifest
// that was embedded. The archive layout is:
//   manifest.json
//   agent/<portable files...>
export function exportAgentBundle(name, outPath, opts = {}) {
    const includeSecrets = opts.includeSecrets === true;
    const stage = makeTempDir('marveen-agent-export-');
    try {
        const stageAgentDir = join(stage, 'agent');
        stageAgentForExport(name, stageAgentDir, includeSecrets);
        const manifest = {
            schemaVersion: BUNDLE_SCHEMA_VERSION,
            agentName: name,
            includesSecrets: includeSecrets,
            ...(opts.exportedBy ? { exportedBy: opts.exportedBy } : {}),
            ...(opts.exportedAt ? { exportedAt: opts.exportedAt } : {}),
        };
        writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
        // Single plain tar over the staging dir -- identical output on bsdtar and
        // GNU tar (see backup.sh). `-C stage .` keeps names clean (no temp prefix).
        mkdirSync(join(outPath, '..'), { recursive: true });
        execFileSync('tar', ['-czf', outPath, '-C', stage, 'manifest.json', 'agent']);
        return manifest;
    }
    finally {
        rmSync(stage, { recursive: true, force: true });
    }
}
// Parse + validate a bundle's manifest without unpacking the whole thing.
// Throws with an operator-facing message on anything malformed.
export function readBundleManifest(extractedRoot) {
    const manifestPath = join(extractedRoot, 'manifest.json');
    if (!existsSync(manifestPath)) {
        throw new Error('Invalid bundle: manifest.json missing (not a Marveen agent bundle?)');
    }
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    }
    catch {
        throw new Error('Invalid bundle: manifest.json is not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object')
        throw new Error('Invalid bundle: manifest.json malformed');
    const m = parsed;
    const schemaVersion = typeof m.schemaVersion === 'number' ? m.schemaVersion : 0;
    if (schemaVersion > BUNDLE_SCHEMA_VERSION) {
        throw new Error(`Bundle schema version ${schemaVersion} is newer than this install supports ` +
            `(max ${BUNDLE_SCHEMA_VERSION}). Update Marveen on this machine first.`);
    }
    const agentName = typeof m.agentName === 'string' ? m.agentName : '';
    if (!agentName)
        throw new Error('Invalid bundle: manifest.json has no agentName');
    return {
        schemaVersion,
        agentName,
        includesSecrets: m.includesSecrets === true,
        ...(typeof m.exportedBy === 'string' ? { exportedBy: m.exportedBy } : {}),
        ...(typeof m.exportedAt === 'string' ? { exportedAt: m.exportedAt } : {}),
    };
}
// Strip machine-specific fields from a staged agent-config.json in place, so an
// imported agent never inherits the source host's ssh/remote/config-dir paths.
export function sanitizeImportedConfig(stagedAgentDir) {
    const cfgPath = join(stagedAgentDir, 'agent-config.json');
    if (!existsSync(cfgPath))
        return;
    let cfg;
    try {
        cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    }
    catch {
        return;
    }
    let changed = false;
    for (const key of MACHINE_SPECIFIC_CONFIG_KEYS) {
        if (key in cfg) {
            delete cfg[key];
            changed = true;
        }
    }
    if (changed)
        atomicWriteFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}
// Import an agent bundle (a .tar.gz buffer or file) into agents/<name>/.
//   - overrideName: install under this name instead of the manifest's
//     (rename-on-import / collision resolution). Re-sanitized.
//   - overwrite: replace an existing agent dir of the same name; without it a
//     name collision throws so the caller can surface a 409.
//   - resolveDest: maps a sanitized name to its install path. Defaults to
//     agentDir() (the real AGENTS_BASE_DIR); overridden in tests to install
//     into a temp tree. safeJoin in agentDir() rejects traversal.
// Returns the final installed name + the bundle manifest.
export function importAgentBundle(bundle, opts = {}) {
    const resolveDest = opts.resolveDest ?? agentDir;
    const work = makeTempDir('marveen-agent-import-');
    try {
        const bundlePath = join(work, 'bundle.tar.gz');
        writeFileSync(bundlePath, bundle);
        const extractRoot = join(work, 'extracted');
        mkdirSync(extractRoot, { recursive: true });
        // Extract into an isolated dir. tar's own path-traversal guard plus our
        // staged layout (manifest.json + agent/) mean nothing escapes extractRoot.
        try {
            execFileSync('tar', ['-xzf', bundlePath, '-C', extractRoot]);
        }
        catch {
            throw new Error('Invalid bundle: could not extract (not a gzip tar archive?)');
        }
        const manifest = readBundleManifest(extractRoot);
        const stagedAgentDir = join(extractRoot, 'agent');
        if (!existsSync(stagedAgentDir) || !statSync(stagedAgentDir).isDirectory()) {
            throw new Error('Invalid bundle: agent/ directory missing');
        }
        const rawName = (opts.overrideName ?? manifest.agentName).trim();
        const name = sanitizeAgentName(rawName);
        if (!name)
            throw new Error('Invalid agent name (empty after sanitization)');
        sanitizeImportedConfig(stagedAgentDir);
        const dest = resolveDest(name); // agentDir: safeJoin rejects traversal
        const exists = existsSync(dest);
        if (exists && !opts.overwrite) {
            throw new Error(`Agent "${name}" already exists on this machine`);
        }
        if (exists)
            rmSync(dest, { recursive: true, force: true });
        mkdirSync(join(dest, '..'), { recursive: true });
        cpSync(stagedAgentDir, dest, { recursive: true });
        return { name, manifest, overwritten: exists };
    }
    finally {
        rmSync(work, { recursive: true, force: true });
    }
}
// Suggested download filename for a bundle. basename() defends against any odd
// characters in the name (it is already sanitized upstream, but the filename
// goes into a Content-Disposition header).
export function bundleFilename(name) {
    const safe = basename(name).replace(/[^A-Za-z0-9_-]/g, '') || 'agent';
    return `marveen-agent-${safe}.tar.gz`;
}
// Build a .tar.gz bundle of every named agent at <outPath>. Names that resolve
// to no source dir are silently skipped (a stale registry entry should not fail
// the whole export). Returns the embedded manifest.
export function exportAllAgentsBundle(outPath, names, opts = {}) {
    const includeSecrets = opts.includeSecrets === true;
    const stage = makeTempDir('marveen-fleet-export-');
    try {
        const agentsRoot = join(stage, 'agents');
        mkdirSync(agentsRoot, { recursive: true });
        const staged = [];
        for (const name of names) {
            const safe = sanitizeAgentName(name);
            if (!safe || !existsSync(agentDir(name)))
                continue;
            stageAgentForExport(name, join(agentsRoot, safe), includeSecrets);
            staged.push(safe);
        }
        if (staged.length === 0)
            throw new Error('No exportable agents found');
        const manifest = {
            schemaVersion: BUNDLE_SCHEMA_VERSION,
            kind: 'fleet',
            agents: staged,
            includesSecrets: includeSecrets,
            ...(opts.exportedBy ? { exportedBy: opts.exportedBy } : {}),
            ...(opts.exportedAt ? { exportedAt: opts.exportedAt } : {}),
        };
        writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
        mkdirSync(join(outPath, '..'), { recursive: true });
        execFileSync('tar', ['-czf', outPath, '-C', stage, 'manifest.json', 'agents']);
        return manifest;
    }
    finally {
        rmSync(stage, { recursive: true, force: true });
    }
}
// Validate + parse a fleet manifest. Throws with an operator-facing message.
export function readFleetManifest(extractedRoot) {
    const manifestPath = join(extractedRoot, 'manifest.json');
    if (!existsSync(manifestPath)) {
        throw new Error('Invalid bundle: manifest.json missing (not a Marveen bundle?)');
    }
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    }
    catch {
        throw new Error('Invalid bundle: manifest.json is not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object')
        throw new Error('Invalid bundle: manifest.json malformed');
    const m = parsed;
    const schemaVersion = typeof m.schemaVersion === 'number' ? m.schemaVersion : 0;
    if (schemaVersion > BUNDLE_SCHEMA_VERSION) {
        throw new Error(`Bundle schema version ${schemaVersion} is newer than this install supports ` +
            `(max ${BUNDLE_SCHEMA_VERSION}). Update Marveen on this machine first.`);
    }
    if (m.kind !== 'fleet')
        throw new Error('Invalid bundle: not a fleet bundle');
    const agents = Array.isArray(m.agents) ? m.agents.filter((a) => typeof a === 'string') : [];
    return {
        schemaVersion,
        kind: 'fleet',
        agents,
        includesSecrets: m.includesSecrets === true,
        ...(typeof m.exportedBy === 'string' ? { exportedBy: m.exportedBy } : {}),
        ...(typeof m.exportedAt === 'string' ? { exportedAt: m.exportedAt } : {}),
    };
}
// Cheaply read just manifest.json out of a bundle to tell a single-agent bundle
// (kind absent/'agent') from a fleet bundle (kind 'fleet'). Lets one import
// endpoint accept either format. Throws on a non-extractable / manifest-less
// archive (same operator-facing wording as the full importers).
export function peekBundleKind(bundle) {
    const work = makeTempDir('marveen-bundle-peek-');
    try {
        const bundlePath = join(work, 'bundle.tar.gz');
        writeFileSync(bundlePath, bundle);
        try {
            execFileSync('tar', ['-xzf', bundlePath, '-C', work, 'manifest.json']);
        }
        catch {
            throw new Error('Invalid bundle: could not extract (not a gzip tar archive?)');
        }
        const manifestPath = join(work, 'manifest.json');
        if (!existsSync(manifestPath)) {
            throw new Error('Invalid bundle: manifest.json missing (not a Marveen bundle?)');
        }
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        }
        catch {
            throw new Error('Invalid bundle: manifest.json is not valid JSON');
        }
        return parsed && typeof parsed === 'object' && parsed.kind === 'fleet'
            ? 'fleet'
            : 'agent';
    }
    finally {
        rmSync(work, { recursive: true, force: true });
    }
}
// Import every agent from a fleet bundle. Per-agent collisions are NOT fatal:
//   - overwrite=false -> existing agents are skipped (reason 'already exists'),
//     fresh ones imported. The caller can re-POST with overwrite=1.
//   - overwrite=true  -> existing agents are replaced.
// A malformed bundle (bad archive / wrong kind) throws as a whole.
export function importAllAgentsBundle(bundle, opts = {}) {
    const resolveDest = opts.resolveDest ?? agentDir;
    const work = makeTempDir('marveen-fleet-import-');
    try {
        const bundlePath = join(work, 'bundle.tar.gz');
        writeFileSync(bundlePath, bundle);
        const extractRoot = join(work, 'extracted');
        mkdirSync(extractRoot, { recursive: true });
        try {
            execFileSync('tar', ['-xzf', bundlePath, '-C', extractRoot]);
        }
        catch {
            throw new Error('Invalid bundle: could not extract (not a gzip tar archive?)');
        }
        const manifest = readFleetManifest(extractRoot);
        const agentsRoot = join(extractRoot, 'agents');
        if (!existsSync(agentsRoot) || !statSync(agentsRoot).isDirectory()) {
            throw new Error('Invalid bundle: agents/ directory missing');
        }
        const imported = [];
        const skipped = [];
        for (const entry of readdirSync(agentsRoot)) {
            const stagedAgentDir = join(agentsRoot, entry);
            try {
                if (!statSync(stagedAgentDir).isDirectory())
                    continue;
            }
            catch {
                continue;
            }
            const name = sanitizeAgentName(entry);
            if (!name) {
                skipped.push({ name: entry, reason: 'invalid name' });
                continue;
            }
            sanitizeImportedConfig(stagedAgentDir);
            const dest = resolveDest(name); // agentDir: safeJoin rejects traversal
            const exists = existsSync(dest);
            if (exists && !opts.overwrite) {
                skipped.push({ name, reason: 'already exists' });
                continue;
            }
            if (exists)
                rmSync(dest, { recursive: true, force: true });
            mkdirSync(join(dest, '..'), { recursive: true });
            cpSync(stagedAgentDir, dest, { recursive: true });
            imported.push({ name, overwritten: exists });
        }
        return { imported, skipped, includesSecrets: manifest.includesSecrets };
    }
    finally {
        rmSync(work, { recursive: true, force: true });
    }
}
export function fleetBundleFilename() {
    return 'marveen-fleet.tar.gz';
}
