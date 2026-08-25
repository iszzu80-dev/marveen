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
import {
  bumpPolicyCounter, counterForVerdict, policyGateLiveness,
} from '../identity/policy-metrics.js';
import { fromFleetCategory, tagsFromPatternNames } from '../identity/sensitivity-scale.js';
import { authorizeAction } from '../identity/authorize-action.js';
import { resolveIdentity, LEGACY_UNKNOWN_IDENTITY } from '../identity/execution-identity.js';
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
  /**
   * W10: who is causing this dispatch. Optional so every existing call site
   * keeps compiling, but its ABSENCE is recorded as an identity-resolution
   * failure rather than being treated as "no identity needed" -- an unmeasured
   * gap and a closed one look identical otherwise.
   */
  identity?: unknown;
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

  // W10 §4.7: count EVERY decision, including allow.
  //
  // This is what makes `policy_allow_count` measurable and -- the same fix --
  // what turns the liveness question from "are there no violations?" (an
  // absence claim, true of a healthy quiet gate AND of a dead one) into "did
  // this gate decide anything?" (a presence claim, which can be false).
  // Aggregate per hour, so the row count grows with time and not with traffic;
  // per-message allow rows were rejected for exactly that reason.
  const identity = resolveIdentity(input.identity);
  try {
    const db = getDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const verdictCounter = result.verdict === 'allow'
      ? counterForVerdict('ALLOW')
      : counterForVerdict('DENY');
    bumpPolicyCounter(db, 'fleet_dispatch', verdictCounter, nowSec);
    if (!identity) bumpPolicyCounter(db, 'fleet_dispatch', 'identity_resolution_failure', nowSec);
    if (result.category === 'restricted' && result.matchedPatterns.length === 0) {
      bumpPolicyCounter(db, 'fleet_dispatch', 'sensitivity_unknown', nowSec);
    }
  } catch (err) {
    // A metrics failure must never change the dispatch decision. It is recorded
    // and swallowed; the verdict above already stands on its own.
    logger.warn({ err }, 'data-sensitivity-gate: failed to record policy counters');
  }

  // W10 §4.9: the audit record must name the ACTOR, not only the target. Until
  // callers pass one this is LEGACY_UNKNOWN, which is the honest value -- and
  // the identity_resolution_failure counter above says how often that happens,
  // so the gap is a number rather than an impression.
  const actor = identity ?? LEGACY_UNKNOWN_IDENTITY;
  auditEntry.actor_id = actor.actorId;
  auditEntry.actor_type = actor.actorType;
  auditEntry.on_behalf_of = actor.onBehalfOf;
  auditEntry.run_id = actor.runId;

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

    // W10: ask the PRESENCE question first. The violation log below can only
    // report absence, and absence is what a healthy quiet gate also produces --
    // this check reported FAILED for fifteen days in August 2026 while the gate
    // was demonstrably alive (52/52 messages replayed clean). Decision counters
    // answer it properly, so they are consulted before the old signal.
    try {
      const live = policyGateLiveness(db, Math.floor(Date.now() / 1000));
      if (live.state === 'LIVE') {
        return { healthy: true, lastEntry: lastTs };
      }
      if (live.state === 'NO_DECISIONS_RECORDED') {
        logger.warn(
          { decisions: live.decisions, windowHours: live.windowHours },
          'data-sensitivity-gate: LIVENESS FAILED — the gate recorded ZERO decisions in the window. '
          + 'This is a presence check: it means checkDispatchGate is not being called at all.',
        );
        return { healthy: false, lastEntry: lastTs };
      }
      // NOT_INSTRUMENTED: counters have never been written (this build is newer
      // than the last dispatch). Fall through to the legacy signal rather than
      // claiming either health or failure from no data.
    } catch (err) {
      logger.warn({ err }, 'data-sensitivity-gate: policy-counter liveness unavailable, falling back');
    }

    if (lastTs === null) {
      logger.warn(
        'data-sensitivity-gate: LIVENESS CHECK FAILED — audit log is EMPTY. ' +
          'NOTE: this signal cannot distinguish a dead gate from a quiet one — only non-allow verdicts land here. ' +
          'The authoritative check is policyGateLiveness (decision counters). Verify those before concluding anything.',
      );
      return { healthy: false, lastEntry: null };
    }

    const ageMs = Date.now() - lastTs * 1000;
    if (ageMs > GATE_SILENCE_THRESHOLD_MS) {
      const ageHours = Math.round(ageMs / 3600000);
      logger.warn(
        { lastEntry: new Date(lastTs * 1000).toISOString(), ageHours },
        `data-sensitivity-gate: LIVENESS CHECK FAILED — last audit entry was ${ageHours}h ago. ` +
          'NOTE: this signal cannot distinguish a dead gate from a quiet one. ' +
          'The authoritative check is policyGateLiveness (decision counters).',
      );
      return { healthy: false, lastEntry: lastTs };
    }

    return { healthy: true, lastEntry: lastTs };
  } catch (err) {
    logger.warn({ err }, 'data-sensitivity-gate: liveness check query failed (table may not exist yet)');
    return { healthy: false, lastEntry: null };
  }
}
