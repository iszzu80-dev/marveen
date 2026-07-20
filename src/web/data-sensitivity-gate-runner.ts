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
import { saveSensitivityAuditEntry, getDb } from '../db.js';

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
    reason: result.reason,
  };

  const shouldBlock = config.mode === 'enforce' && result.verdict === 'block';

  // Persist every non-allow verdict to the audit log so the false-positive
  // sample is durable across restarts (card 6bf535bf FP-sample phase).
  // Only would_block/block are persisted — 'allow' verdicts are volume-heavy
  // and would dilute the sample. The 48h observation window starts from the
  // first persisted row, not from gate activation time.
  if (result.verdict !== 'allow') {
    logger.warn(auditEntry, `data-sensitivity-gate: ${result.verdict} — ${result.reason}`);
    try {
      saveSensitivityAuditEntry({
        content_hash: contentHash,
        verdict: result.verdict,
        category: result.category,
        matched_patterns: result.matchedPatterns as string[],
        target_agent: input.targetAgent,
        target_model: targetModel,
        message_id: input.messageId ?? null,
        mode: config.mode,
        reason: result.reason,
      });
    } catch (err) {
      logger.warn({ err }, 'data-sensitivity-gate: failed to persist audit entry');
    }
  }

  return { result, auditEntry, shouldBlock };
}

// ---- gate liveness check (card aaabd99c) ------------------------------------
//
// The gate can be silently unwired: a merge drops the checkDispatchGate call
// from message-router.ts, but the module, tests, and audit-log table survive
// intact. Nobody notices because a never-called gate and an always-passing gate
// emit exactly the same thing — silence.
//
// This check queries the audit log directly at boot time and periodically.
// It does NOT depend on checkDispatchGate being called — it reads the EFFECT
// (audit entries) rather than the CAUSE (call site). A merge that removes the
// call site does not remove this check; they live in different imports.
//
// Threshold: 24 hours. If the most recent audit entry is older than that
// (or the table is empty), the gate is either unwired or something upstream
// is preventing audit entries from being written. In observe mode with low
// traffic this can legitimately be silent, so this is a WARN-level log, not
// an alert — it surfaces in the dashboard logs for a human to triage.

const GATE_SILENCE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function checkGateLiveness(): { healthy: boolean; lastEntry: number | null } {
  try {
    const db = getDb();
    const row = db
      .prepare('SELECT MAX(created_at) AS last_ts FROM sensitivity_audit_log')
      .get() as { last_ts: number | null } | undefined;
    const lastTs = row?.last_ts ?? null;

    if (lastTs === null) {
      logger.warn(
        'data-sensitivity-gate: LIVENESS CHECK FAILED — audit log is EMPTY. ' +
          'The gate may be unwired (no callers) or the observe window has never triggered a non-allow verdict. ' +
          'Verify that message-router.ts imports and calls checkDispatchGate.',
      );
      return { healthy: false, lastEntry: null };
    }

    const ageMs = Date.now() - lastTs * 1000;
    if (ageMs > GATE_SILENCE_THRESHOLD_MS) {
      const ageHours = Math.round(ageMs / 3600000);
      logger.warn(
        { lastEntry: new Date(lastTs * 1000).toISOString(), ageHours },
        `data-sensitivity-gate: LIVENESS CHECK FAILED — last audit entry was ${ageHours}h ago. ` +
          'The gate may be unwired (no callers since last deploy/restart). ' +
          'Verify that message-router.ts imports and calls checkDispatchGate.',
      );
      return { healthy: false, lastEntry: lastTs };
    }

    return { healthy: true, lastEntry: lastTs };
  } catch (err) {
    logger.warn({ err }, 'data-sensitivity-gate: liveness check query failed (table may not exist yet)');
    return { healthy: false, lastEntry: null };
  }
}
