import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { json } from '../http-helpers.js';
import { agentDir } from '../agent-config.js';
import { resolveAgentConfigDir } from '../claude-plans.js';
import { projectsDirFor } from '../active-model.js';
import { isMainChannelsAgent } from '../main-agent.js';
import { PROJECT_ROOT } from '../../config.js';
const MAX_TEXT = 6000;
const DEFAULT_LIMIT = 400;
function workingDirFor(name) {
    return isMainChannelsAgent(name) ? PROJECT_ROOT : agentDir(name);
}
function newestTranscript(name) {
    const configDir = isMainChannelsAgent(name) ? undefined : (resolveAgentConfigDir(name).configDir ?? undefined);
    const dir = projectsDirFor(workingDirFor(name), configDir);
    try {
        if (!existsSync(dir))
            return null;
        const files = readdirSync(dir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => ({ f, m: statSync(join(dir, f)).mtimeMs }))
            .sort((a, b) => b.m - a.m);
        return files.length ? join(dir, files[0].f) : null;
    }
    catch {
        return null;
    }
}
const CHANNEL_RE = /<channel\b[^>]*>([\s\S]*?)<\/channel>/g;
function clip(s) {
    return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + ' …' : s;
}
// One-line human label for a non-messaging tool call.
function actionLabel(name, input) {
    const base = name.includes('__') ? name.split('__').pop() : name;
    const pick = (k) => (typeof input[k] === 'string' ? input[k] : '');
    if (name === 'Bash')
        return `Bash: ${pick('description') || pick('command').slice(0, 80)}`;
    if (name === 'Read')
        return `Read: ${pick('file_path')}`;
    if (name === 'Write')
        return `Write: ${pick('file_path')}`;
    if (name === 'Edit')
        return `Edit: ${pick('file_path')}`;
    if (base.includes('search_gmail'))
        return `Gmail keresés: ${pick('query')}`;
    if (base.includes('draft_gmail'))
        return `Gmail draft: ${pick('subject')}`;
    if (base.includes('send_gmail'))
        return `Email küldés: ${pick('subject')}`;
    if (base.includes('import_to_google_doc'))
        return `Google Doc: ${pick('file_name')}`;
    if (base.includes('import_to_google_slides'))
        return `Google Slides: ${pick('file_name')}`;
    if (base === 'WebSearch')
        return `Web keresés: ${pick('query')}`;
    if (base === 'WebFetch')
        return `Web lekérés: ${pick('url')}`;
    if (base.includes('download_attachment'))
        return 'Csatolmány letöltés';
    return base;
}
// Turn the newest transcript into a flat, chronological, readable timeline.
function buildTimeline(file) {
    const entries = [];
    const raw = readFileSync(file, 'utf-8').split('\n');
    for (const line of raw) {
        const t = line.trim();
        if (!t)
            continue;
        let d;
        try {
            d = JSON.parse(t);
        }
        catch {
            continue;
        }
        const type = d['type'];
        const ts = typeof d['timestamp'] === 'string' ? d['timestamp'] : null;
        const msg = d['message'];
        if (!msg)
            continue;
        if (type === 'user') {
            const content = msg['content'];
            const asText = typeof content === 'string' ? content : '';
            // Only surface real inbound channel messages; skip tool results,
            // system-reminders and slash-command echoes.
            if (asText.includes('<channel')) {
                let m;
                CHANNEL_RE.lastIndex = 0;
                while ((m = CHANNEL_RE.exec(asText)) !== null) {
                    const inner = m[1].trim();
                    if (inner)
                        entries.push({ ts, kind: 'in', text: clip(inner) });
                }
            }
            continue;
        }
        if (type === 'assistant') {
            const content = msg['content'];
            if (!Array.isArray(content))
                continue;
            for (const block of content) {
                const bt = block['type'];
                if (bt === 'text') {
                    const txt = typeof block['text'] === 'string' ? block['text'].trim() : '';
                    if (txt)
                        entries.push({ ts, kind: 'note', text: clip(txt) });
                }
                else if (bt === 'tool_use') {
                    const name = typeof block['name'] === 'string' ? block['name'] : '';
                    const input = block['input'] ?? {};
                    if (name.endsWith('telegram__reply') || name.endsWith('__reply')) {
                        const txt = typeof input['text'] === 'string' ? input['text'] : '';
                        if (txt)
                            entries.push({ ts, kind: 'out', text: clip(txt), label: 'válasz' });
                    }
                    else if (name.endsWith('telegram__react') || name.endsWith('__react')) {
                        const emoji = typeof input['emoji'] === 'string' ? input['emoji'] : '?';
                        entries.push({ ts, kind: 'out', text: emoji, label: 'reakció' });
                    }
                    else if (name.endsWith('telegram__edit_message') || name.endsWith('__edit_message')) {
                        const txt = typeof input['text'] === 'string' ? input['text'] : '';
                        entries.push({ ts, kind: 'out', text: clip(txt), label: 'szerkesztés' });
                    }
                    else {
                        entries.push({ ts, kind: 'action', text: actionLabel(name, input) });
                    }
                }
            }
            continue;
        }
    }
    // The full timeline, oldest-first; the route windows it for pagination.
    return entries;
}
export async function tryHandleAgentConversation(ctx) {
    const { res, path, method, url } = ctx;
    const match = path.match(/^\/api\/agents\/([^/]+)\/conversation$/);
    if (!match || method !== 'GET')
        return false;
    const name = decodeURIComponent(match[1]);
    // Pagination: `limit` is the page size, `offset` is how many of the NEWEST
    // entries to skip. offset=0 is the latest page; the UI pages further back
    // (offset += limit) to load older history beyond the on-screen window -- and
    // beyond the old fixed cap, since the whole transcript is now reachable.
    const limitRaw = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 2000) : DEFAULT_LIMIT;
    const offsetRaw = Number(url.searchParams.get('offset'));
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
    const file = newestTranscript(name);
    if (!file) {
        json(res, { agent: name, entries: [], total: 0, offset: 0, hasOlder: false, note: 'Nincs még beszélgetés-előzmény ehhez az agenthez.' });
        return true;
    }
    try {
        const all = buildTimeline(file);
        const total = all.length;
        const end = Math.max(0, total - offset);
        const start = Math.max(0, end - limit);
        const entries = all.slice(start, end);
        json(res, {
            agent: name,
            sessionId: file.split('/').pop()?.replace('.jsonl', '') ?? null,
            total,
            offset,
            hasOlder: start > 0,
            count: entries.length,
            entries,
        });
    }
    catch {
        json(res, { error: 'A beszélgetés feldolgozása nem sikerült' }, 500);
    }
    return true;
}
