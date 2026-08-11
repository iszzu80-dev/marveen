import { existsSync, unlinkSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { PROJECT_ROOT, MAIN_AGENT_ID, CHANNEL_PROVIDER, currentBotName, currentBrandName, currentOwnerName, 
// LOCAL-FORK: keep on merge. Boot-time defaults for the brand chrome this
// fork adds (logo + accent). Upstream's current*() accessors cover the three
// display NAMES; these two are read through getEffectiveSettingValue below
// with these constants as the fallback, which is the same hot-reload idea
// applied to the fields upstream does not have.
BRAND_LOGO_URL, BRAND_ACCENT, KANBAN_LABEL_COLORS, } from '../../config.js';
import { getEffectiveSettingValue } from '../../settings-store.js';
import { readMarveenTelegramConfig, readMarveenDiscordConfig, readMarveenSlackConfig, readMarveenGooglechatConfig, readMarveenTeamsConfig, sendMarveenAvatarChange } from '../telegram.js';
import { hardRestartMarveenChannels } from '../channel-monitor.js';
import { readFileOr } from '../agent-config.js';
import { parseMultipart } from '../multipart.js';
import { readBody, json, serveFile } from '../http-helpers.js';
import { MAIN_CHANNELS_SESSION } from '../main-agent.js';
import { readActiveModelFromProjectDir, readContextTokensFromProjectDir } from '../active-model.js';
import { readAutoRestartConfig } from '../auto-restart-store.js';
function getActiveMarveenModel() {
    return readActiveModelFromProjectDir(PROJECT_ROOT) ?? 'unknown';
}
export function buildMarveenIdentityCore(botName, brandName, mainAgentId) {
    return {
        name: botName,
        brandName,
        agentId: mainAgentId,
        autoRestartId: mainAgentId,
        role: 'main',
    };
}
export async function tryHandleMarveen(ctx, webDir) {
    const { req, res, path, method } = ctx;
    if (path === '/api/marveen' && method === 'GET') {
        const claudeMd = readFileOr(join(PROJECT_ROOT, 'CLAUDE.md'), '');
        const soulMd = readFileOr(join(PROJECT_ROOT, 'SOUL.md'), '');
        const mcpJson = readFileOr(join(PROJECT_ROOT, '.mcp.json'), '');
        const soulSection = claudeMd.match(/## Személyiség\n\n([\s\S]*?)(?=\n## )/)?.[1]?.trim()
            || claudeMd.match(/## Szemelyiseg\n\n([\s\S]*?)(?=\n## )/)?.[1]?.trim()
            || '';
        const firstLine = claudeMd.match(/^Te .+$/m)?.[0]?.trim() || '';
        const descFromPersonality = soulSection.split('\n').filter(l => l.trim()).slice(0, 2).join(' ').slice(0, 200);
        const description = firstLine || descFromPersonality || `${currentOwnerName()} AI asszisztense`;
        const tg = readMarveenTelegramConfig();
        const dc = readMarveenDiscordConfig();
        const sl = readMarveenSlackConfig();
        const gc = readMarveenGooglechatConfig();
        const tc = readMarveenTeamsConfig();
        // Brand-relevant identity core. `name` = main agent display name (BOT_NAME),
        // `brandName` = product brand for the dashboard chrome (defaults to BOT_NAME;
        // the client falls back to its own HTML default "Marveen" if absent on a
        // legacy backend), `agentId` = canonical MAIN_AGENT_ID so the dashboard can
        // hit /api/agents/<id>/skills for the main agent.
        const idCore = buildMarveenIdentityCore(currentBotName(), currentBrandName(), MAIN_AGENT_ID);
        // LOCAL-FORK: keep on merge. Brand accent and logo resolved through settings
        // overrides so the Settings page can hot-reload them, with the boot-time env
        // as fallback. Same intent as upstream's current*() name accessors.
        const brandAccent = String(getEffectiveSettingValue('BRAND_ACCENT') ?? BRAND_ACCENT);
        const brandLogoUrl = String(getEffectiveSettingValue('BRAND_LOGO_URL') ?? BRAND_LOGO_URL);
        json(res, {
            ...idCore,
            // Configured owner display name (OWNER_NAME). The dashboard chat view uses
            // this to pin/label the owner's own message thread instead of a hardcoded
            // literal, so a renamed install recognizes its real owner.
            ownerName: currentOwnerName(),
            // LOCAL-FORK: keep on merge. Brand chrome: logo URL (empty = monogram
            // fallback) and accent colour applied as --qq-accent / --qq-accent-dark /
            // --qq-accent-light on :root.
            brandLogoUrl,
            brandAccent,
            description,
            model: getActiveMarveenModel(),
            tmuxSession: MAIN_CHANNELS_SESSION,
            running: true,
            // Auto-restart applies to the main channels session too; key it by the
            // orchestrator id (autoRestartId, part of idCore) so the UI PUTs to the
            // right store entry.
            autoRestart: readAutoRestartConfig(MAIN_AGENT_ID),
            contextTokens: readContextTokensFromProjectDir(PROJECT_ROOT),
            hasTelegram: tg.hasTelegram,
            hasDiscord: dc.hasDiscord,
            hasSlack: sl.hasSlack,
            hasGooglechat: gc.hasGooglechat,
            hasTeams: tc.hasTeams,
            telegramBotUsername: tg.botUsername,
            personality: soulSection,
            claudeMd,
            soulMd,
            mcpJson,
            readonly: true,
            // Dashboard kliens defaultja a provider-dropdown-hoz: a backend
            // CHANNEL_PROVIDER env-jébe pinneljük, hogy a UI ne hardcode-olt
            // 'telegram'-mal induljon.
            channelProvider: CHANNEL_PROVIDER,
            // Resolved through the settings overrides layer so the UI hot-reloads.
            kanbanAging: {
                warnH: getEffectiveSettingValue('KANBAN_AGING_WARN_H'),
                cautionH: getEffectiveSettingValue('KANBAN_AGING_CAUTION_H'),
                criticalH: getEffectiveSettingValue('KANBAN_AGING_CRITICAL_H'),
                warnColor: getEffectiveSettingValue('KANBAN_AGING_WARN_COLOR'),
                cautionColor: getEffectiveSettingValue('KANBAN_AGING_CAUTION_COLOR'),
                criticalColor: getEffectiveSettingValue('KANBAN_AGING_CRITICAL_COLOR'),
            },
            // Resolved through the settings overrides layer (override > .env >
            // registry default) instead of the boot-time config.ts constants, so a
            // value saved on the Settings page takes effect immediately -- no
            // process restart needed for these 9 keys.
            kanbanWip: {
                limits: {
                    planned: getEffectiveSettingValue('KANBAN_WIP_PLANNED'),
                    in_progress: getEffectiveSettingValue('KANBAN_WIP_IN_PROGRESS'),
                    testing: getEffectiveSettingValue('KANBAN_WIP_TESTING'),
                    waiting: getEffectiveSettingValue('KANBAN_WIP_WAITING'),
                    done: getEffectiveSettingValue('KANBAN_WIP_DONE'),
                },
                warnPct: getEffectiveSettingValue('KANBAN_WIP_WARN_PCT'),
                okColor: getEffectiveSettingValue('KANBAN_WIP_OK_COLOR'),
                warnColor: getEffectiveSettingValue('KANBAN_WIP_WARN_COLOR'),
                fullColor: getEffectiveSettingValue('KANBAN_WIP_FULL_COLOR'),
                overColor: getEffectiveSettingValue('KANBAN_WIP_OVER_COLOR'),
            },
            kanbanSwimlanes: {
                defaultGroup: getEffectiveSettingValue('KANBAN_SWIMLANE_DEFAULT_GROUP'),
                separatorColor: getEffectiveSettingValue('KANBAN_SWIMLANE_SEPARATOR_COLOR') || null,
            },
            kanbanLabels: {
                colors: KANBAN_LABEL_COLORS,
            },
        });
        return true;
    }
    // Intentionally read-only: Marveen's CLAUDE.md / SOUL.md / .mcp.json must be
    // edited from the filesystem or via a Telegram request to Marveen herself,
    // not through the dashboard. A leaked dashboard token would otherwise allow
    // remote identity rewrite of the live agent.
    if (path === '/api/marveen' && method === 'PUT') {
        json(res, { ok: true, readonly: true });
        return true;
    }
    if (path === '/api/marveen/restart' && method === 'POST') {
        const result = await hardRestartMarveenChannels();
        if (!result.ok) {
            json(res, { error: result.error || 'Restart failed' }, 500);
            return true;
        }
        json(res, { ok: true });
        return true;
    }
    if (path === '/api/marveen/avatar' && method === 'GET') {
        // Avatars are ~1MB each and rarely change: let browsers reuse them for an
        // hour without a round-trip (an avatar swapped in another session shows up
        // after at most 1h, then ETag revalidation; the swapping session itself
        // busts via the frontend avatar epoch).
        for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
            const p = join(PROJECT_ROOT, 'store', `marveen-avatar${ext}`);
            if (existsSync(p)) {
                serveFile(req, res, p, { cacheSeconds: 3600 });
                return true;
            }
        }
        const fallback = join(webDir, 'avatars', '01_robot.png');
        if (existsSync(fallback)) {
            serveFile(req, res, fallback, { cacheSeconds: 3600 });
            return true;
        }
        res.writeHead(404);
        res.end();
        return true;
    }
    if (path === '/api/marveen/avatar' && method === 'POST') {
        const body = await readBody(req);
        const contentType = req.headers['content-type'] || '';
        for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
            const p = join(PROJECT_ROOT, 'store', `marveen-avatar${ext}`);
            if (existsSync(p))
                unlinkSync(p);
        }
        if (contentType.includes('application/json')) {
            const { galleryAvatar } = JSON.parse(body.toString());
            if (!galleryAvatar) {
                json(res, { error: 'No avatar specified' }, 400);
                return true;
            }
            if (galleryAvatar.includes('..') || galleryAvatar.includes('/') || galleryAvatar.includes('\\')) {
                json(res, { error: 'Invalid avatar name' }, 400);
                return true;
            }
            const srcPath = join(webDir, 'avatars', galleryAvatar);
            if (!existsSync(srcPath)) {
                json(res, { error: 'Avatar not found' }, 404);
                return true;
            }
            const destPath = join(PROJECT_ROOT, 'store', `marveen-avatar${extname(galleryAvatar) || '.png'}`);
            copyFileSync(srcPath, destPath);
            sendMarveenAvatarChange(destPath).catch(() => { });
        }
        else {
            const { file } = parseMultipart(body, contentType);
            if (!file) {
                json(res, { error: 'No file uploaded' }, 400);
                return true;
            }
            const destPath = join(PROJECT_ROOT, 'store', `marveen-avatar${extname(file.name) || '.png'}`);
            writeFileSync(destPath, file.data);
            sendMarveenAvatarChange(destPath).catch(() => { });
        }
        json(res, { ok: true });
        return true;
    }
    return false;
}
