import { statSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { getDb } from '../db.js';
import { logger } from '../logger.js';
import { deriveProvider } from '../costops/pricing.js';
// The transcript-dir -> agent mapping rule lives in ONE place (see
// transcript-sources.ts); P2-A's resolveCurrentSessionId() reuses the very same
// helper, so the `-agents-<name>` regex is not duplicated across the two
// consumers.
import { discoverAgentSources } from './transcript-sources.js';
// P2-A: collection is what CREATES the token_usage rows the dispatch window
// correlation attributes, so the correlation is chained to the end of
// collectTokenUsage() itself -- the ONE place every collection path goes
// through (the hourly interval, the startup pass, and POST
// /api/token-usage/collect). Wiring it here instead of at each of those three
// call sites makes it structurally impossible for a collection path to exist
// that does not correlate. The _Safe variant is used because a measurement
// fault must never break a collection that already wrote real rows.
import { correlateTokenUsageToDispatchesSafe } from '../costops/dispatch.js';
function findJsonlFiles(dir) {
    const files = [];
    if (!existsSync(dir))
        return files;
    function scanDir(d) {
        let entries;
        try {
            entries = readdirSync(d);
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const full = join(d, entry);
            if (entry.endsWith('.jsonl')) {
                files.push(full);
            }
            else {
                let stat;
                try {
                    stat = statSync(full);
                }
                catch {
                    continue;
                }
                if (stat.isDirectory()) {
                    scanDir(full);
                }
            }
        }
    }
    scanDir(dir);
    return files;
}
/**
 * Collapse transcript rows that belong to the same assistant turn (same
 * message id) into a single row, so a tool-calling turn is counted ONCE.
 *
 * Usage is identical across a turn's lines, so we take the max per field
 * (defensive against a partial/streaming line) rather than summing. The tool
 * name and preview are filled from whichever line carries them. Rows without a
 * message id (older transcripts) pass through untouched. Pure + order-stable
 * for unit testing.
 */
export function collapseByMessageId(calls) {
    const byId = new Map();
    const out = [];
    for (const c of calls) {
        if (!c.messageId) {
            out.push(c);
            continue;
        }
        const ex = byId.get(c.messageId);
        if (!ex) {
            const copy = { ...c };
            byId.set(c.messageId, copy);
            out.push(copy);
            continue;
        }
        ex.inputTokens = Math.max(ex.inputTokens, c.inputTokens);
        ex.outputTokens = Math.max(ex.outputTokens, c.outputTokens);
        ex.cacheReadTokens = Math.max(ex.cacheReadTokens, c.cacheReadTokens);
        ex.cacheCreationTokens = Math.max(ex.cacheCreationTokens, c.cacheCreationTokens);
        ex.thinkingTokens = Math.max(ex.thinkingTokens, c.thinkingTokens);
        if (!ex.model && c.model)
            ex.model = c.model;
        if (!ex.toolName && c.toolName)
            ex.toolName = c.toolName;
        if (!ex.contentPreview && c.contentPreview)
            ex.contentPreview = c.contentPreview;
    }
    return out;
}
async function parseJsonlFile(filePath, agent, fromLine) {
    const calls = [];
    let lineNum = 0;
    let sessionId = '';
    const rl = createInterface({
        input: createReadStream(filePath, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
    });
    for await (const line of rl) {
        lineNum++;
        if (lineNum <= fromLine)
            continue;
        if (!line.trim())
            continue;
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (obj.sessionId) {
            sessionId = obj.sessionId;
        }
        if (obj.type !== 'assistant' || !obj.message?.usage)
            continue;
        const u = obj.message.usage;
        const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
        if (!ts)
            continue;
        let preview = '';
        const content = obj.message?.content;
        if (Array.isArray(content)) {
            for (const block of content) {
                if (block.type === 'text' && block.text) {
                    preview = block.text.slice(0, 200);
                    break;
                }
            }
        }
        else if (typeof content === 'string') {
            preview = content.slice(0, 200);
        }
        let toolName = null;
        let thinkingTokens = 0;
        if (Array.isArray(content)) {
            for (const block of content) {
                if (block.type === 'tool_use' && block.name && !toolName) {
                    toolName = block.name;
                }
                // Estimate thinking tokens from char length (no per-block count in API)
                if (block.type === 'thinking' && typeof block.thinking === 'string') {
                    thinkingTokens += Math.ceil(block.thinking.length / 4);
                }
            }
        }
        calls.push({
            agent,
            sessionId: sessionId || basename(filePath, '.jsonl'),
            timestamp: Math.floor(ts / 1000),
            inputTokens: (u.input_tokens || 0),
            outputTokens: (u.output_tokens || 0),
            cacheReadTokens: (u.cache_read_input_tokens || 0),
            cacheCreationTokens: (u.cache_creation_input_tokens || 0),
            thinkingTokens,
            model: obj.message?.model || null,
            contentPreview: preview,
            toolName,
            messageId: obj.message?.id || null,
        });
    }
    // Collapse the multi-line tool-turn rows (same message id, repeated usage)
    // before they reach the DB -- this is the fix for the ~2x token inflation.
    return { calls: collapseByMessageId(calls), linesRead: lineNum };
}
/**
 * `dispatchAttributed` = token_usage rows this pass linked to a dispatch by the
 * P2-A window correlation (0 when nothing matched, or when the correlation
 * faulted and was isolated). Returned so the wiring is OBSERVABLE from the
 * outside -- POST /api/token-usage/collect reports it -- rather than being an
 * invisible side effect.
 */
export async function collectTokenUsage() {
    const db = getDb();
    const sources = discoverAgentSources();
    let totalInserted = 0;
    let totalFiles = 0;
    const getCursor = db.prepare('SELECT last_line, last_size FROM token_usage_cursors WHERE file_path = ?');
    const setCursor = db.prepare('INSERT OR REPLACE INTO token_usage_cursors (file_path, last_line, last_size) VALUES (?, ?, ?)');
    // Reconciled with upstream #573/#583 (per-model cost accuracy): ON CONFLICT DO UPDATE
    // backfills columns that were NULL/0 on the first (partial-transcript) write once a
    // later pass sees the real value, instead of INSERT OR IGNORE silently keeping the gap
    // forever. Extended to our own enrichment columns (provider, model_source) so they get
    // the same backfill treatment as upstream's model/thinking_tokens.
    const insertCall = db.prepare(`
    INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, thinking_tokens, model, content_preview, tool_name,
      provider, model_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, session_id, timestamp, input_tokens, output_tokens) DO UPDATE SET
      model = CASE WHEN token_usage.model IS NULL AND excluded.model IS NOT NULL THEN excluded.model ELSE token_usage.model END,
      thinking_tokens = CASE WHEN (token_usage.thinking_tokens IS NULL OR token_usage.thinking_tokens = 0) AND excluded.thinking_tokens > 0 THEN excluded.thinking_tokens ELSE token_usage.thinking_tokens END,
      provider = CASE WHEN token_usage.provider IS NULL AND excluded.provider IS NOT NULL THEN excluded.provider ELSE token_usage.provider END,
      model_source = CASE WHEN token_usage.model_source IS NULL AND excluded.model_source IS NOT NULL THEN excluded.model_source ELSE token_usage.model_source END
  `);
    for (const source of sources) {
        const files = findJsonlFiles(source.projectDir);
        for (const file of files) {
            let fileSize;
            try {
                fileSize = statSync(file).size;
            }
            catch {
                continue;
            }
            const cursor = getCursor.get(file);
            if (cursor && cursor.last_size === fileSize)
                continue;
            const fromLine = (cursor && cursor.last_size <= fileSize) ? cursor.last_line : 0;
            try {
                const { calls, linesRead } = await parseJsonlFile(file, source.agent, fromLine);
                if (calls.length > 0) {
                    const tx = db.transaction(() => {
                        for (const c of calls) {
                            insertCall.run(c.agent, c.sessionId, c.timestamp, c.inputTokens, c.outputTokens, c.cacheReadTokens, c.cacheCreationTokens, c.thinkingTokens, c.model || null, c.contentPreview || null, c.toolName, c.model ? deriveProvider(c.model) : null, c.model ? 'transcript' : null);
                        }
                        setCursor.run(file, linesRead, fileSize);
                    });
                    tx();
                    totalInserted += calls.length;
                }
                else {
                    setCursor.run(file, linesRead, fileSize);
                }
                totalFiles++;
            }
            catch (err) {
                logger.warn({ err, file }, 'Token usage parse failed');
            }
        }
    }
    // P2-A: attribute the rows we just wrote to their dispatches. Runs on EVERY
    // collection (hourly interval, startup, manual route) because it hangs off
    // collectTokenUsage itself. One bounded SQL UPDATE per dispatch window, only
    // over `dispatch_id IS NULL` rows, so re-running is idempotent and cheap.
    // Fault-isolated: never throws into the collection above.
    const dispatchAttributed = correlateTokenUsageToDispatchesSafe(db);
    if (dispatchAttributed > 0) {
        logger.info({ dispatchAttributed }, 'P2-A: token_usage rows attributed to dispatches');
    }
    return { inserted: totalInserted, files: totalFiles, dispatchAttributed };
}
export function getTokenSummary(from, to) {
    const db = getDb();
    const conditions = [];
    const params = [];
    if (from) {
        conditions.push('timestamp >= ?');
        params.push(from);
    }
    if (to) {
        conditions.push('timestamp <= ?');
        params.push(to);
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const rows = db.prepare(`
    SELECT agent,
      COUNT(*) as totalCalls,
      SUM(input_tokens) as totalInput,
      SUM(output_tokens) as totalOutput,
      SUM(cache_read_tokens) as totalCacheRead,
      SUM(cache_creation_tokens) as totalCacheCreation,
      COUNT(DISTINCT session_id) as totalSessions,
      MIN(timestamp) as firstSeen,
      MAX(timestamp) as lastSeen
    FROM token_usage
    ${where}
    GROUP BY agent ORDER BY totalInput DESC
  `).all(...params);
    const modelRows = db.prepare(`
    SELECT agent, model,
      SUM(input_tokens) as totalInput,
      SUM(output_tokens) as totalOutput,
      SUM(cache_read_tokens) as totalCacheRead,
      SUM(cache_creation_tokens) as totalCacheCreation
    FROM token_usage
    ${where}
    GROUP BY agent, model
  `).all(...params);
    const byAgent = new Map();
    for (const mr of modelRows) {
        const { agent, ...rest } = mr;
        if (!byAgent.has(agent))
            byAgent.set(agent, []);
        byAgent.get(agent).push(rest);
    }
    return rows.map(r => ({ ...r, perModel: byAgent.get(r.agent) ?? [] }));
}
export function getModelDistribution(from, to, agent) {
    const db = getDb();
    const hasModelCol = db.prepare("SELECT COUNT(*) as n FROM pragma_table_info('token_usage') WHERE name='model'").get();
    if (!hasModelCol.n)
        return [];
    let sql = `
    SELECT model,
      COUNT(*) as count,
      SUM(input_tokens) as totalInput,
      SUM(output_tokens) as totalOutput,
      SUM(cache_read_tokens) as totalCacheRead,
      SUM(cache_creation_tokens) as totalCacheCreation
    FROM token_usage
  `;
    const conditions = [
        "model IS NOT NULL",
        "model != ''",
        "model != '<synthetic>'",
    ];
    const params = [];
    if (from) {
        conditions.push('timestamp >= ?');
        params.push(from);
    }
    if (to) {
        conditions.push('timestamp <= ?');
        params.push(to);
    }
    if (agent) {
        conditions.push('agent = ?');
        params.push(agent);
    }
    sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' GROUP BY model ORDER BY count DESC';
    return db.prepare(sql).all(...params);
}
export function getToolStats(from, to, agent) {
    const db = getDb();
    let sql = `
    SELECT tool_name,
      model,
      COUNT(*) as count,
      GROUP_CONCAT(DISTINCT agent) as agents,
      SUM(input_tokens) as totalInput,
      SUM(output_tokens) as totalOutput,
      SUM(cache_read_tokens) as totalCacheRead,
      SUM(cache_creation_tokens) as totalCacheCreation
    FROM token_usage
    WHERE tool_name IS NOT NULL
  `;
    const conditions = [];
    const params = [];
    if (from) {
        conditions.push('timestamp >= ?');
        params.push(from);
    }
    if (to) {
        conditions.push('timestamp <= ?');
        params.push(to);
    }
    if (agent) {
        conditions.push('agent = ?');
        params.push(agent);
    }
    if (conditions.length)
        sql += ' AND ' + conditions.join(' AND ');
    sql += ' GROUP BY tool_name, model ORDER BY count DESC';
    return db.prepare(sql).all(...params);
}
export function getTokenTimeline(bucketMinutes = 60, from, to, agent) {
    const db = getDb();
    const bucketSeconds = bucketMinutes * 60;
    let sql = `
    SELECT
      (timestamp / ${bucketSeconds}) * ${bucketSeconds} as bucket,
      agent,
      COUNT(*) as calls,
      SUM(input_tokens + cache_read_tokens + cache_creation_tokens) as inputTokens,
      SUM(output_tokens) as outputTokens
    FROM token_usage
  `;
    const conditions = [];
    const params = [];
    if (from) {
        conditions.push('timestamp >= ?');
        params.push(from);
    }
    if (to) {
        conditions.push('timestamp <= ?');
        params.push(to);
    }
    if (agent) {
        conditions.push('agent = ?');
        params.push(agent);
    }
    if (conditions.length)
        sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' GROUP BY bucket, agent ORDER BY bucket ASC';
    return db.prepare(sql).all(...params);
}
export function getTokenDetails(opts) {
    const db = getDb();
    let sql = `SELECT * FROM token_usage`;
    const conditions = [];
    const params = [];
    if (opts.agent) {
        conditions.push('agent = ?');
        params.push(opts.agent);
    }
    if (opts.from) {
        conditions.push('timestamp >= ?');
        params.push(opts.from);
    }
    if (opts.to) {
        conditions.push('timestamp <= ?');
        params.push(opts.to);
    }
    if (opts.minTokens) {
        conditions.push('(input_tokens + cache_read_tokens + cache_creation_tokens) >= ?');
        params.push(opts.minTokens);
    }
    if (opts.q) {
        const like = `%${opts.q}%`;
        conditions.push('(agent LIKE ? OR tool_name LIKE ? OR content_preview LIKE ? OR task_title LIKE ?)');
        params.push(like, like, like, like);
    }
    if (conditions.length)
        sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY timestamp DESC';
    sql += ' LIMIT ? OFFSET ?';
    params.push(opts.limit || 100, opts.offset || 0);
    return db.prepare(sql).all(...params);
}
export function correlateWithKanban() {
    const db = getDb();
    const uncorrelated = db.prepare(`
    SELECT DISTINCT agent, MIN(timestamp) as minTs, MAX(timestamp) as maxTs
    FROM token_usage
    WHERE task_title IS NULL
    GROUP BY agent
  `).all();
    for (const row of uncorrelated) {
        const cards = db.prepare(`
      SELECT id, title, project, assignee, updated_at
      FROM kanban_cards
      WHERE (assignee = ? OR assignee LIKE '%' || ? || '%')
        AND updated_at BETWEEN ? AND ?
      ORDER BY updated_at ASC
    `).all(row.agent, row.agent, row.minTs, row.maxTs);
        for (const card of cards) {
            const nextCard = cards.find((c) => c.updated_at > card.updated_at);
            const endTs = nextCard ? nextCard.updated_at : row.maxTs;
            db.prepare(`
        UPDATE token_usage
        SET task_title = ?, project = ?
        WHERE agent = ? AND timestamp BETWEEN ? AND ? AND task_title IS NULL
      `).run(card.title, card.project || null, row.agent, card.updated_at, endTs);
        }
    }
}
