import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../config.js';
export const PROFILES_DIR = join(PROJECT_ROOT, 'templates', 'profiles');
export const HARDCODED_DEFAULT_PROFILE = {
    id: 'default',
    label: 'Alapértelmezett',
    description: 'Permissive fallback.',
    permissionMode: 'permissive',
    filesystem: { allow: [], deny: ['mcp__claude_ai_Supabase__*'] },
};
export function listProfileTemplates() {
    if (!existsSync(PROFILES_DIR))
        return [HARDCODED_DEFAULT_PROFILE];
    const out = [];
    for (const f of readdirSync(PROFILES_DIR)) {
        if (!f.endsWith('.json'))
            continue;
        try {
            const p = JSON.parse(readFileSync(join(PROFILES_DIR, f), 'utf-8'));
            if (p.id)
                out.push(p);
        }
        catch { /* skip malformed */ }
    }
    return out.length ? out : [HARDCODED_DEFAULT_PROFILE];
}
export function loadProfileTemplate(id) {
    const path = join(PROFILES_DIR, `${id}.json`);
    if (existsSync(path)) {
        try {
            return JSON.parse(readFileSync(path, 'utf-8'));
        }
        catch { /* fall through */ }
    }
    if (id !== 'default')
        return loadProfileTemplate('default');
    return HARDCODED_DEFAULT_PROFILE;
}
export function resolveProfilePlaceholders(value, ctx) {
    return value
        .replace(/\$\{HOME\}/g, ctx.HOME)
        .replace(/\$\{AGENT_DIR\}/g, ctx.AGENT_DIR)
        .replace(/\$\{WORKDIR\}/g, ctx.AGENT_DIR);
}
