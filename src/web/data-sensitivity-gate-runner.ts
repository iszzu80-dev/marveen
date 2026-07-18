// I/O layer for the data-sensitivity dispatch gate.
//
// Reads config from store/data-sensitivity-gate.json, resolves provider trust
// from env, writes audit log entries, and provides the hook for message-router
// integration. This is the ONLY file that touches fs / env / logger / db.
//
// Audit log entries NEVER contain raw content, secrets, PII, or prompt text.
// content_hash = SHA-256 of the message body (correlation only, irreversible).

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger.js';
import { readAgentModel } from './agent-config.js';
import {
  evaluateDispatch,
  parseTrustedProviders,
  normalizeConfig,
  type GateConfig,
  type GateResult,
} from '../data-sensitivity-gate.js';

const CONFIG_PATH = join(process.cwd(), 'store', 'data-sensitivity-gate.json');

// Cache: config is re-read at most once per tick. Invalidate by touching the file.
let cachedConfig: GateConfig | null = null;
let cachedConfigMtime = 0;

export function readGateConfig(): GateConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const stat = readFileSync(CONFIG_PATH); // read raw bytes first to check mtime
      // Re-read if file changed or never cached.
      // Use a simple approach: always re-read (cheap, store/ is on local disk).
      const raw = JSON.parse(stat.toString('utf-8'));
      return normalizeConfig(raw);
    }
  } catch (err) {
    logger.warn({ err }, 'data-sensitivity-gate: failed to read config, using safe defaults');
  }
  return normalizeConfig({});
}

// Resolve trusted provider prefixes from env.
let cachedTrustedPrefixes: Set<string> | null = null;

export function readTrustedProviders(): Set<string> {
  if (cachedTrustedPrefixes) return cachedTrustedPrefixes;
  cachedTrustedPrefixes = parseTrustedProviders(process.env['TRUSTED_PROVIDERS']);
  logger.info(
    { trusted: [...cachedTrustedPrefixes] },
    'data-sensitivity-gate: trusted providers resolved',
  );
  return cachedTrustedPrefixes;
}

// For testing: invalidate caches.
export function invalidateGateConfigCache(): void {
  cachedConfig = null;
  cachedConfigMtime = 0;
  cachedTrustedPrefixes = null;
}

// ---- message-router integration hook -----------------------------------------

export interface GateCheckInput {
  content: string;
  targetAgent: string;
  messageId?: number;
}

// Called by the message-router before tmux injection. Returns the gate result
// plus a pre-formatted audit log entry (caller persists it).
// In observe-only mode, 'would_block' is logged but delivery proceeds.
// In enforce mode, 'block' means the caller MUST NOT deliver.
export function checkDispatchGate(input: GateCheckInput): {
  result: GateResult;
  auditEntry: Record<string, unknown> | null;
  shouldBlock: boolean;
} {
  const config = readGateConfig();

  if (!config.enabled || config.mode === 'off') {
    return { result: { verdict: 'allow', category: 'public', matchedPatterns: [], reason: 'gate disabled' }, auditEntry: null, shouldBlock: false };
  }

  const targetModel = readAgentModel(input.targetAgent);
  const trustedPrefixes = readTrustedProviders();
  const result = evaluateDispatch(input.content, targetModel, config, trustedPrefixes);

  // Build audit entry — NEVER include raw content.
  const contentHash = createHash('sha256').update(input.content, 'utf-8').digest('hex');
  const auditEntry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    verdict: result.verdict,
    category: result.category,
    matched_patterns: result.matchedPatterns,
    target_agent: input.targetAgent,
    target_model: targetModel,
    message_id: input.messageId ?? null,
    content_hash: contentHash,
    mode: config.mode,
  };

  const shouldBlock = config.mode === 'enforce' && result.verdict === 'block';

  if (result.verdict !== 'allow') {
    logger.warn(auditEntry, `data-sensitivity-gate: ${result.verdict} — ${result.reason}`);
  }

  return { result, auditEntry, shouldBlock };
}
