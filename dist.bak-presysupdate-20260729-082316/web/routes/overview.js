import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PROJECT_ROOT, MAIN_AGENT_ID, BOT_NAME } from '../../config.js';
import { getDb, countTaskRunsBetween } from '../../db.js';
import { agentDir, listAgentNames, readAgentDisplayName, } from '../agent-config.js';
import { readAgentTeam } from '../agent-team.js';
import { isAgentRunning } from '../agent-process.js';
import { json } from '../http-helpers.js';
// Count "real" user turns (operator prompts, Telegram messages) in every
// Claude Code session JSONL under ~/.claude/projects/. Filters out
// tool_result, local-command, and synthetic system events so a task-heavy
// hour doesn't inflate the counter.
function countUserTurns(fromMs, toMs = Number.POSITIVE_INFINITY) {
    const root = join(homedir(), '.claude', 'projects');
    if (!existsSync(root))
        return 0;
    let total = 0;
    try {
        for (const projectDir of readdirSync(root)) {
            const absDir = join(root, projectDir);
            let stat;
            try {
                stat = statSync(absDir);
            }
            catch {
                continue;
            }
            if (!stat.isDirectory())
                continue;
            for (const fname of readdirSync(absDir)) {
                if (!fname.endsWith('.jsonl'))
                    continue;
                const absFile = join(absDir, fname);
                let fstat;
                try {
                    fstat = statSync(absFile);
                }
                catch {
                    continue;
                }
                if (fstat.mtimeMs < fromMs)
                    continue;
                try {
                    const data = readFileSync(absFile, 'utf-8');
                    for (const line of data.split('\n')) {
                        if (!line)
                            continue;
                        let e;
                        try {
                            e = JSON.parse(line);
                        }
                        catch {
                            continue;
                        }
                        if (e.type !== 'user' || e.isMeta)
                            continue;
                        const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
                        if (!ts || ts < fromMs || ts >= toMs)
                            continue;
                        const content = e.message?.content;
                        if (typeof content === 'string') {
                            if (content.startsWith('<local-command') || content.startsWith('<command-name>'))
                                continue;
                            total++;
                        }
                        else if (Array.isArray(content)) {
                            const hasToolResult = content.some((b) => b && b.type === 'tool_result');
                            if (hasToolResult)
                                continue;
                            total++;
                        }
                    }
                }
                catch { /* skip unreadable file */ }
            }
        }
    }
    catch { /* ignore */ }
    return total;
}
export async function tryHandleOverview(ctx) {
    const { res, path, method } = ctx;
    if (path === '/api/overview' && method === 'GET') {
        const subAgents = listAgentNames();
        const running = subAgents.filter(n => isAgentRunning(n)).length + 1;
        const total = subAgents.length + 1;
        const db0 = getDb();
        const memStats = db0.prepare("SELECT COUNT(*) as c FROM memories").get();
        const memCats = db0.prepare("SELECT COUNT(DISTINCT category) as c FROM memories").get();
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const startTs = startOfDay.getTime();
        const yesterday = startTs - 24 * 60 * 60 * 1000;
        const schedToday = countTaskRunsBetween(startTs);
        const schedYesterday = countTaskRunsBetween(yesterday, startTs);
        const userTurns = countUserTurns(startTs);
        const userTurnsPrev = countUserTurns(yesterday, startTs);
        const tasksToday = schedToday + userTurns;
        const tasksYesterday = schedYesterday + userTurnsPrev;
        let skillCount = 0;
        let skillsToday = 0;
        const skillsDir = join(homedir(), '.claude', 'skills');
        if (existsSync(skillsDir)) {
            for (const entry of readdirSync(skillsDir)) {
                const skillFile = join(skillsDir, entry, 'SKILL.md');
                if (existsSync(skillFile)) {
                    skillCount++;
                    try {
                        const mtime = statSync(skillFile).mtimeMs;
                        if (mtime >= startTs)
                            skillsToday++;
                    }
                    catch { /* ignore */ }
                }
            }
        }
        const activity = [];
        try {
            const memRows = db0.prepare("SELECT content, created_at, agent_id FROM memories ORDER BY created_at DESC LIMIT 6").all();
            for (const r of memRows) {
                activity.push({
                    icon: 'memory',
                    text: `${r.agent_id}: ${r.content.slice(0, 80)}${r.content.length > 80 ? '…' : ''}`,
                    at: r.created_at * 1000,
                });
            }
        }
        catch { /* ignore */ }
        try {
            const msgRows = db0.prepare("SELECT from_agent, to_agent, content, created_at FROM agent_messages ORDER BY created_at DESC LIMIT 4").all();
            for (const r of msgRows) {
                activity.push({
                    icon: 'delegate',
                    text: `${r.from_agent} → ${r.to_agent}: ${r.content.slice(0, 60)}${r.content.length > 60 ? '…' : ''}`,
                    at: r.created_at * 1000,
                });
            }
        }
        catch { /* ignore */ }
        activity.sort((a, b) => b.at - a.at);
        const agentsForTeam = [];
        const mainHasAvatar = [
            join(PROJECT_ROOT, 'store', 'marveen-avatar.png'),
            join(PROJECT_ROOT, 'store', 'marveen-avatar.jpg'),
        ].some(existsSync);
        agentsForTeam.push({
            id: MAIN_AGENT_ID,
            label: BOT_NAME,
            role: 'main',
            running: true,
            hasAvatar: mainHasAvatar,
            avatarUrl: `/api/marveen/avatar`,
        });
        for (const a of subAgents) {
            const team = readAgentTeam(a);
            agentsForTeam.push({
                id: a,
                label: readAgentDisplayName(a),
                role: team.role,
                running: isAgentRunning(a),
                hasAvatar: existsSync(join(agentDir(a), 'avatar.png')),
                avatarUrl: `/api/agents/${encodeURIComponent(a)}/avatar`,
            });
        }
        json(res, {
            agents: { total, running },
            tasksToday,
            tasksYesterday,
            memories: { count: memStats.c, categories: memCats.c },
            skills: { count: skillCount, today: skillsToday },
            team: agentsForTeam,
            activity: activity.slice(0, 8),
        });
        return true;
    }
    return false;
}
