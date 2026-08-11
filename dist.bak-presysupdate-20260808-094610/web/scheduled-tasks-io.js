import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { MAIN_AGENT_ID } from '../config.js';
import { atomicWriteFileSync } from './atomic-write.js';
export const SCHEDULED_TASKS_DIR = join(homedir(), '.claude', 'scheduled-tasks');
// Hard cap on the prompt length for a scheduled task, to stop a malicious
// or accidentally-huge POST body from exhausting the target agent's
// token budget (and wedging the tmux send-keys paste detector). 50,000
// characters is ~12k tokens of English, which is already far beyond any
// legitimate schedule prompt -- real ones are usually <1k chars.
export const MAX_SCHEDULED_TASK_PROMPT_LEN = 50_000;
function readFileOr(path, fallback) {
    try {
        return readFileSync(path, 'utf-8');
    }
    catch {
        return fallback;
    }
}
export function parseSkillMdFrontmatter(content) {
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!fmMatch)
        return { body: content };
    const yaml = fmMatch[1];
    const body = fmMatch[2].trim();
    const nameMatch = yaml.match(/^name:\s*(.+)$/m);
    const descMatch = yaml.match(/^description:\s*(.+)$/m);
    return {
        name: nameMatch?.[1]?.trim(),
        description: descMatch?.[1]?.trim(),
        body,
    };
}
export function readScheduledTask(taskName) {
    const dir = join(SCHEDULED_TASKS_DIR, taskName);
    const skillPath = join(dir, 'SKILL.md');
    const configPath = join(dir, 'task-config.json');
    const hasSkill = existsSync(skillPath);
    // command-type tasks have no SKILL.md; they are defined entirely by
    // task-config.json. Only bail if neither file exists.
    if (!hasSkill && !existsSync(configPath))
        return null;
    const skillContent = hasSkill ? readFileOr(skillPath, '') : '';
    const { name, description, body } = parseSkillMdFrontmatter(skillContent);
    let config = {};
    try {
        config = JSON.parse(readFileOr(configPath, '{}'));
    }
    catch { /* use defaults */ }
    return {
        name: name || taskName,
        description: description || config.description || '',
        prompt: body,
        schedule: config.schedule || '0 9 * * *',
        agent: config.agent || MAIN_AGENT_ID,
        enabled: config.enabled !== false,
        createdAt: config.createdAt || 0,
        type: config.type || 'task',
        skipIfBusy: config.skipIfBusy === true,
        forceSend: config.forceSend === true,
        targetSession: config.targetSession || undefined,
        command: config.command,
        timeoutMs: config.timeoutMs,
        failThreshold: config.failThreshold,
        preCheck: config.preCheck,
        catchUpMaxAgeMinutes: parseCatchUpMaxAge(config.catchUpMaxAgeMinutes),
        stuckAfterMinutes: parseFiniteMinutes(config.stuckAfterMinutes),
        requires: parseRequires(config.requires),
    };
}
// Only a finite number is a policy; anything else (string, null, NaN) is
// treated as absent so a malformed config falls back to the built-in default
// instead of disabling a guard by accident.
export function parseFiniteMinutes(raw) {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}
// Same acceptance rule, kept as a named export because the catch-up call sites
// and tests predate the generic helper (range semantics live downstream in
// catchUpMaxAgeMs / resolveStuckTimeoutMs, not here).
export function parseCatchUpMaxAge(raw) {
    return parseFiniteMinutes(raw);
}
// Accept only a string array for requires.mcp_servers; anything else is
// treated as absent so a malformed config cannot wedge the runner.
export function parseRequires(raw) {
    if (!raw || !Array.isArray(raw.mcp_servers))
        return undefined;
    const servers = raw.mcp_servers.filter((s) => typeof s === 'string' && s.trim().length > 0);
    return servers.length ? { mcp_servers: servers } : undefined;
}
export function listScheduledTasks() {
    if (!existsSync(SCHEDULED_TASKS_DIR))
        return [];
    const dirs = readdirSync(SCHEDULED_TASKS_DIR).filter(f => {
        try {
            return statSync(join(SCHEDULED_TASKS_DIR, f)).isDirectory();
        }
        catch {
            return false;
        }
    });
    const tasks = [];
    for (const d of dirs) {
        const task = readScheduledTask(d);
        if (task)
            tasks.push(task);
    }
    return tasks.sort((a, b) => b.createdAt - a.createdAt);
}
export function writeScheduledTask(taskName, data) {
    const dir = join(SCHEDULED_TASKS_DIR, taskName);
    mkdirSync(dir, { recursive: true });
    const skillPath = join(dir, 'SKILL.md');
    const configPath = join(dir, 'task-config.json');
    // Read existing if updating
    const existing = readScheduledTask(taskName);
    // Write SKILL.md
    const desc = data.description ?? existing?.description ?? '';
    const prompt = data.prompt ?? existing?.prompt ?? '';
    const skillContent = `---\nname: ${taskName}\ndescription: ${desc}\n---\n\n${prompt}\n`;
    atomicWriteFileSync(skillPath, skillContent);
    // Write/update config
    let config = {};
    try {
        config = JSON.parse(readFileOr(configPath, '{}'));
    }
    catch { /* use empty */ }
    if (data.schedule !== undefined)
        config.schedule = data.schedule;
    if (data.agent !== undefined)
        config.agent = data.agent;
    if (data.enabled !== undefined)
        config.enabled = data.enabled;
    if (data.type !== undefined)
        config.type = data.type;
    if (data.skipIfBusy !== undefined)
        config.skipIfBusy = data.skipIfBusy;
    if (data.forceSend !== undefined)
        config.forceSend = data.forceSend;
    if (data.targetSession !== undefined)
        config.targetSession = data.targetSession;
    if (data.command !== undefined)
        config.command = data.command;
    if (data.timeoutMs !== undefined)
        config.timeoutMs = data.timeoutMs;
    if (data.failThreshold !== undefined)
        config.failThreshold = data.failThreshold;
    if (data.preCheck !== undefined)
        config.preCheck = data.preCheck;
    if (data.catchUpMaxAgeMinutes !== undefined)
        config.catchUpMaxAgeMinutes = data.catchUpMaxAgeMinutes;
    if (data.stuckAfterMinutes !== undefined)
        config.stuckAfterMinutes = data.stuckAfterMinutes;
    if (data.description !== undefined)
        config.description = data.description;
    if (!config.createdAt)
        config.createdAt = Math.floor(Date.now() / 1000);
    atomicWriteFileSync(configPath, JSON.stringify(config, null, 2));
}
