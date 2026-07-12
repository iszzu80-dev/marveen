import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { resolveAgentChannelStateDir } from './voice-directive.js'
import {
  getPendingMessages,
  markMessageDelivered,
  markMessageDone,
  markMessageFailed,
  createAgentMessage,
} from '../db.js'
import type { AgentMessage } from '../db.js'
import { readAgentRemoteHost, readAgentVoiceConfig } from './agent-config.js'
import {
  agentSessionName,
  isSessionReadyForPrompt,
  clearStaleParkedInput,
  sendPromptToSession,
  sessionExistsOnHost,
} from './agent-process.js'
import { setLastInboundModality } from './voice-modality.js'
import { classifyAgentMessage, wrapAgentMessageForDelivery } from './agent-message-wrap.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'

// A message that cannot be delivered within this window (target session never
// exists / stays busy) is marked failed so it stops clogging the pending
// queue and we stop re-scanning it forever. Matches the scheduled-task retry
// window so a long turn that ate one also eats the other.
const MESSAGE_ABANDON_WINDOW_MS = 60 * 60 * 1000
// How long a message must have waited before the stale-parked-input janitor is
// allowed to clear the receiver's input box. Long enough that a brief, genuine
// "agent parked a draft it is about to submit" never gets clobbered; short
// enough that a wedged channel recovers within ~a minute instead of forever.
const JANITOR_PARKED_MIN_AGE_MS = 45 * 1000
// Log "skipping, target not ready" at most once per message id so a busy
// receiver over many 5s ticks does not spam the log.
const routerLoggedMisses: Set<number> = new Set()
// Wakeup cooldown for the main agent: the router fires at most one
// sendPromptToSession wakeup per COOLDOWN_MS window to avoid spamming the
// channels session. 45s gives enough headroom that a normal turn (typically
// 5-30s) ends and drain-inbox fires before we would retry.
let lastMainAgentWakeupMs = 0
const MAIN_AGENT_WAKEUP_COOLDOWN_MS = 45 * 1000

// ---- session-stuck detection (card 2922e380 thread a) ------------------------
// When a session EXISTS but is never ready (menu-blocked / context-saturated /
// parked input the janitor can't clear), track how long it has been continuously
// stuck. After STUCK_ESCALATE_MS, escalate to warning-level logs so the existing
// revival tooling (channel-monitor, stuck-input-watcher) can act before the
// message backlog grows large. State cleared when session becomes ready or absent.
const STUCK_ESCALATE_MS = 10 * 60 * 1000  // 10 min continuously stuck -> escalate
const agentStuckSince = new Map<string, number>()  // agent -> first tick stuck (Date.now)

// ---- reconnect-backlog batching (card 2922e380 thread b) --------------------
// When a session was absent and reconnects, old pending messages are summarized
// into ONE batch delivery instead of FIFO-bursting them one by one (the pattern
// that made the Mason incident read like churn). Only triggers when there are
// more than BATCH_THRESHOLD messages and the oldest is > BATCH_AGE_MS old.
const RECONNECT_BATCH_THRESHOLD = 5
const RECONNECT_BATCH_AGE_MS = 30 * 60 * 1000    // oldest > 30 min
// Agents that were absent on the previous tick. When they reappear, check for
// old backlog and batch it on the first delivery attempt.
const agentWasAbsent = new Set<string>()
// Agents we already batched this reconnect (one-shot per reconnect cycle).
const agentBatchedThisReconnect = new Set<string>()

/**
 * Pure decision: should a pending inter-agent message be abandoned?
 *
 * Abandon ONLY when the target session has been ABSENT for the full retry
 * window. A session that EXISTS (even if busy or mid-turn) is never hard-
 * abandoned -- it keeps retrying until an idle gap delivers the message.
 *
 * The previous inline code checked `ageMs > window` BEFORE the session-
 * existence check, which abandoned messages to an alive-but-busy main
 * session at the 1h mark even though the session was continuously running
 * (incident: two reports lost while the session was busy).
 *
 * @param sessionExists Whether the target tmux session is currently alive.
 * @param ageMs         How long the message has been pending (ms).
 * @param windowMs      The abandon window threshold (ms).
 */
export function shouldAbandon(sessionExists: boolean, ageMs: number, windowMs: number): boolean {
  return !sessionExists && ageMs > windowMs
}

// Checks for pending messages every 5 seconds and injects them into target
// agent tmux sessions.
let _tickRunning = false

// Max messages drained per 5s tick; a larger backlog rolls to the next tick.
export const MAX_MESSAGES_PER_TICK = 25

export function startMessageRouter(): NodeJS.Timeout {
  return setInterval(async () => {
    // Re-entrancy guard: STT can hold a tick for up to 65s; skip new ticks
    // while the previous one is still in flight to prevent double-delivery.
    if (_tickRunning) return
    _tickRunning = true
    try {
      await runMessageRouterTick()
    } finally {
      _tickRunning = false
    }
  }, 5000)
}

// Per-receiver batched-message-id set for the CURRENT tick. Built by the
// pre-pass reconnect detector; consumed by the main loop to skip messages
// that were already summarized into a batch delivery.
let batchedMsgIdsThisTick: Set<number> = new Set()

/**
 * Summarize old pending messages for a reconnected agent into one batch delivery.
 * Marks the batched messages as 'done' and creates a single summary message that
 * the router will deliver on the next tick.
 *
 * Only called from the reconnect pre-pass, once per reconnect cycle per agent.
 */
function batchDeliverBacklog(agent: string, agentPending: AgentMessage[], now: number): void {
  // Split: messages older than BATCH_AGE_MS get batched; recent ones stay for
  // individual delivery. The age threshold is measured against the message's
  // own created_at, not the youngest in the batch.
  const old: typeof agentPending = []
  const recent: typeof agentPending = []
  for (const m of agentPending) {
    const age = now - m.created_at * 1000
    if (age > RECONNECT_BATCH_AGE_MS) {
      old.push(m)
    } else {
      recent.push(m)
    }
  }
  if (old.length === 0) return

  // Build a summary: who sent what, when (oldest first).
  const lines: string[] = [
    `[BACKLOG-SUMMARY] ${old.length} inter-agent message(s) received while you were away:`,
    '',
  ]
  const senders = new Map<string, number>()
  for (const m of old) {
    const sender = m.from_agent || 'unknown'
    senders.set(sender, (senders.get(sender) ?? 0) + 1)
    const dt = new Date(m.created_at * 1000).toISOString().replace('T', ' ').slice(0, 19)
    const preview = m.content.length > 120 ? m.content.slice(0, 120) + '…' : m.content
    lines.push(`[${dt}] ${sender}: ${preview}`)
  }
  lines.push('')
  const senderSummary = Array.from(senders.entries())
    .map(([s, n]) => `${s} (${n})`)
    .join(', ')
  lines.push(`Summary: ${old.length} old message(s) from ${senderSummary}. Check the message log for full details.`)

  const summaryContent = lines.join('\n')
  // Mark all batched messages as done. Use markMessageDone so they transition
  // cleanly (with COALESCE backfill for delivered_at if needed).
  for (const m of old) {
    markMessageDone(m.id, `batched into backlog summary for ${agent}`)
    batchedMsgIdsThisTick.add(m.id)
  }
  // Create ONE new pending message with the summary. It will be picked up by
  // the router on the next tick and delivered normally (or via PULL if main agent).
  createAgentMessage('system', agent, summaryContent, 'reconnect-backlog-batch')
  logger.info({
    agent,
    batchedCount: old.length,
    recentRemaining: recent.length,
    oldestBatched: old[0]?.created_at,
  }, 'message-router: reconnect-backlog batched — summary message created')
}

// One router pass: drain up to MAX_MESSAGES_PER_TICK pending inter-agent
// messages and inject each into its target tmux session. Extracted from the
// setInterval body so it can be exercised directly in unit tests (the
// _tickRunning re-entrancy guard stays in startMessageRouter, around the call).
export async function runMessageRouterTick(): Promise<void> {
    // Reset per-tick batched-message tracker.
    batchedMsgIdsThisTick = new Set()
    // Cap work per tick: process at most MAX_MESSAGES_PER_TICK messages, the
    // rest roll to the next 5s tick. Bounds a single tick's wall-time so a
    // backlog (e.g. after a delivery stall) can never make one tick run long
    // and starve the event loop -- the slow-tick half of the progressive-hang
    // pattern. Ordering is preserved (oldest first) so nothing is starved.
    const pending = getPendingMessages().slice(0, MAX_MESSAGES_PER_TICK)
    const now = Date.now()
    // ---- update absent/present tracking for all receivers in this tick ----
    // Rebuild the stuck-detector's view of which agents are absent RIGHT NOW.
    // Shared across all messages to the same agent (one sessionExistsOnHost call
    // per unique receiver per tick, not per message). Cache the results so the
    // main loop can reuse them instead of re-calling sessionExistsOnHost.
    const receiversInTick = new Set<string>()
    for (const m of pending) {
      if (m.to_agent !== MAIN_AGENT_ID) receiversInTick.add(m.to_agent)
    }
    const absentNow = new Set<string>()
    const presentNow = new Set<string>()
    // agent -> {exists: bool, host, session} cached lookup for the main loop.
    const agentSessionCache = new Map<string, {host: string | null, session: string, exists: boolean}>()
    for (const agent of receiversInTick) {
      const host = readAgentRemoteHost(agent)
      const session = agentSessionName(agent)
      const exists = sessionExistsOnHost(host, session)
      agentSessionCache.set(agent, { host, session, exists })
      if (exists) {
        presentNow.add(agent)
      } else {
        absentNow.add(agent)
      }
    }
    // Reconnect detection: agent was absent on the last tick, now present.
    for (const agent of presentNow) {
      if (agentWasAbsent.has(agent) && !agentBatchedThisReconnect.has(agent)) {
        // Check if this agent qualifies for backlog batching.
        const agentPending = getPendingMessages(agent)
        if (agentPending.length > RECONNECT_BATCH_THRESHOLD) {
          const oldestAge = now - agentPending[0].created_at * 1000
          if (oldestAge > RECONNECT_BATCH_AGE_MS) {
            logger.warn({ agent, pendingCount: agentPending.length, oldestAgeMs: oldestAge },
              'message-router: reconnect-backlog batch — summarizing old messages')
            batchDeliverBacklog(agent, agentPending, now)
            agentBatchedThisReconnect.add(agent)
          }
        }
      }
    }
    // Maintain absent-set: agents absent now will be checked next tick for reconnect.
    for (const agent of absentNow) {
      agentWasAbsent.add(agent)
      agentBatchedThisReconnect.delete(agent) // reset batched flag on new absence
      agentStuckSince.delete(agent)           // absent = not stuck, just gone
    }
    for (const agent of presentNow) {
      agentWasAbsent.delete(agent)
    }

    let mainAgentWakeupFiredThisTick = false
    for (const msg of pending) {
      // Skip messages already batched by the reconnect pre-pass: they are
      // 'done' in the DB now but still appear in our snapshot slice.
      if (batchedMsgIdsThisTick.has(msg.id)) continue
      const ageMs = now - msg.created_at * 1000
      // The main agent runs in `${MAIN_AGENT_ID}-channels`, not `agent-${name}`,
      // so agentSessionName() would miss it and strand every sub-agent → main
      // message as pending forever. Mirror the scheduler's session resolution.
      const isMainAgent = msg.to_agent === MAIN_AGENT_ID
      // PULL MODEL: the main agent drains its OWN inbox each turn (the
      // drain-inbox endpoint + UserPromptSubmit hook), so the router does NOT
      // tmux-inject into its perpetually-busy channel session -- that race is
      // what stalled inter-agent delivery to the main agent for ~1h on a busy
      // day. Leave the message pending; the next main-agent turn claims it
      // atomically. Sub-agents keep the tmux-inject path (they have idle gaps).
      //
      // WAKEUP: without an active nudge the main agent only drains on the next
      // user message or heartbeat -- up to 22+ min latency observed in prod.
      // Fire one lightweight wakeup per cooldown window so an idle channels
      // session starts a turn and drain-inbox claims the message immediately.
      // Busy session: Claude Code queues the wakeup for the next turn boundary.
      if (isMainAgent) {
        if (!mainAgentWakeupFiredThisTick && now - lastMainAgentWakeupMs >= MAIN_AGENT_WAKEUP_COOLDOWN_MS) {
          mainAgentWakeupFiredThisTick = true
          lastMainAgentWakeupMs = now
          try {
            sendPromptToSession(MAIN_CHANNELS_SESSION, '[inbox-wakeup: pending inter-agent messages]', null, { waitForIdle: false })
            logger.info({ msgId: msg.id }, 'message-router: main-agent wakeup fired')
          } catch (err) {
            logger.warn({ err }, 'message-router: main-agent wakeup injection failed')
          }
        }
        continue
      }
      // Use cached session data from the pre-pass (one sessionExistsOnHost call
      // per unique receiver per tick). Fall back to a direct call for agents not
      // in the pending set (shouldn't happen, but safe).
      const cached = agentSessionCache.get(msg.to_agent)
      const session = cached?.session ?? agentSessionName(msg.to_agent)
      const host = isMainAgent ? null : cached?.host ?? readAgentRemoteHost(msg.to_agent)
      const sessionExists = cached?.exists ?? sessionExistsOnHost(host, session)

      if (shouldAbandon(sessionExists, ageMs, MESSAGE_ABANDON_WINDOW_MS)) {
        logger.warn({ id: msg.id, from: msg.from_agent, to: msg.to_agent, ageMs }, 'Agent message abandoned: target session absent for full retry window')
        if (!markMessageFailed(msg.id, 'Abandoned: target session absent for full retry window')) {
          logger.warn({ id: msg.id }, 'markMessageFailed affected 0 rows (deleted concurrently?)')
        }
        routerLoggedMisses.delete(msg.id)
        continue
      }

      if (!sessionExists) {
        if (!routerLoggedMisses.has(msg.id)) {
          logger.warn({ id: msg.id, to: msg.to_agent, session }, 'Agent message target session not running, will retry')
          routerLoggedMisses.add(msg.id)
        }
        continue
      }

      if (!isSessionReadyForPrompt(session, host)) {
        // ---- session-stuck detection (card 2922e380 thread a) ----
        // Track how long this session has been continuously not-ready.
        const stuckStart = agentStuckSince.get(msg.to_agent)
        if (!stuckStart) {
          agentStuckSince.set(msg.to_agent, now)
        } else if (now - stuckStart > STUCK_ESCALATE_MS) {
          // Session has been continuously stuck past the escalation threshold.
          // Log at warn level so monitoring/revival tooling can act — the
          // stuck-input-watcher and channel-monitor pick these patterns up.
          logger.warn({
            to: msg.to_agent, session,
            stuckDurationMs: now - stuckStart,
            pendingMsgCount: pending.filter(m => m.to_agent === msg.to_agent).length,
          }, 'message-router: session STUCK — continuously not-ready past escalation threshold')
          // Reset timer so we don't spam every tick; re-escalate after another window.
          agentStuckSince.set(msg.to_agent, now)
        }
        // Stale-parked-input janitor: a non-submitted line stuck in the input
        // box (e.g. a weak local model that typed its heartbeat reply into the
        // box instead of ending the turn) keeps isSessionReadyForPrompt false
        // forever, so this message -- and every later one -- strands as pending
        // and the channel silently wedges. Once a message has waited long enough,
        // clear a STABLE parked input so delivery resumes next tick. clearStale
        // ParkedInput only fires on the idle 'typing' state with text unchanged
        // across a settle, so it never clobbers a session that is actually
        // processing or input a human/agent is mid-typing.
        if (ageMs > JANITOR_PARKED_MIN_AGE_MS && clearStaleParkedInput(session, host)) {
          routerLoggedMisses.delete(msg.id)
          continue // input cleared; deliver on the next tick
        }
        if (!routerLoggedMisses.has(msg.id)) {
          logger.warn({ id: msg.id, to: msg.to_agent, session }, 'Agent message target session busy, will retry')
          routerLoggedMisses.add(msg.id)
        }
        continue
      }

      // Session is ready — clear stuck tracking.
      agentStuckSince.delete(msg.to_agent)

      // Classify (channel-inbound / trusted-peer / untrusted) + reject an empty
      // from_agent -- SINGLE SOURCE in agent-message-wrap so the router and the
      // main-agent pull endpoint frame messages identically (no security drift).
      const cls = classifyAgentMessage(msg.from_agent, msg.to_agent)
      if (!cls) {
        logger.warn({ id: msg.id, rawFrom: msg.from_agent }, 'Agent message rejected: from_agent empty after sanitize')
        if (!markMessageFailed(msg.id, 'Invalid or empty from_agent')) {
          logger.warn({ id: msg.id }, 'markMessageFailed affected 0 rows (deleted concurrently?)')
        }
        routerLoggedMisses.delete(msg.id)
        continue
      }
      const { category, safeFrom: safeFromAgent } = cls
      const isChannelInbound = category === 'channel-inbound'
      const trusted = category === 'trusted-peer'

      // Voice auto-mode: if this is a channel-inbound voice message, run STT
      // and update the last-inbound-modality flag. The decision (STT or not)
      // lives HERE so both the inbound transcript injection and the modality
      // flag are set in one place, with full knowledge of agent-id + chat-id.
      let deliveryContent = msg.content
      if (isChannelInbound) {
        const voiceFileId = extractVoiceFileId(msg.content)
        const chatId = extractChatId(msg.content)
        const voiceCfg = readAgentVoiceConfig(msg.to_agent)
        if (voiceFileId && chatId) {
          // Always record modality so auto-mode TTS can fire on reply.
          setLastInboundModality(msg.to_agent, chatId, 'voice')
          if (voiceCfg.responseMode !== 'text') {
            // Attempt STT; on failure fall through to raw voice block.
            const transcript = await callVoiceSTT(voiceFileId, msg.to_agent)
            if (transcript) {
              deliveryContent = injectTranscript(msg.content, transcript)
              logger.info({ id: msg.id, agent: msg.to_agent }, 'message-router: voice STT applied')
              // TTS directive is injected by the UserPromptSubmit hook (voice-reply-directive.py)
              // which fires on every delivery path, not just coordinator-relay.
            } else {
              logger.warn({ id: msg.id, agent: msg.to_agent }, 'message-router: STT failed, delivering raw voice block')
            }
          }
        } else if (chatId) {
          // Text message: record modality so a previous voice flag is cleared.
          setLastInboundModality(msg.to_agent, chatId, 'text')
        }
      }

      try {
        // channel-inbound carries the STT-applied deliveryContent; the agent
        // wrap (trusted/untrusted) carries the raw content. Single-source frame.
        // msgId passed so receiving agents can write back via PUT /api/messages/:id.
        const content = isChannelInbound ? deliveryContent : msg.content
        const { prefix, wrapped } = wrapAgentMessageForDelivery(category, safeFromAgent, msg.from_agent, content, msg.id, msg.origin_note)
        // Inline preamble so a fresh session (post hard-restart) doesn't miss
        // the context that explains the tag semantics.
        sendPromptToSession(session, prefix + wrapped, host)
        if (!markMessageDelivered(msg.id)) {
          logger.warn({ id: msg.id }, 'markMessageDelivered affected 0 rows (deleted concurrently?)')
        }
        routerLoggedMisses.delete(msg.id)
        logger.info({ id: msg.id, from: msg.from_agent, to: msg.to_agent, category: isChannelInbound ? 'channel-inbound' : trusted ? 'trusted-peer' : 'untrusted' }, 'Agent message delivered')
      } catch (err) {
        logger.warn({ err, id: msg.id }, 'Failed to deliver agent message')
        if (!markMessageFailed(msg.id, 'Failed to inject into tmux session')) {
          logger.warn({ id: msg.id }, 'markMessageFailed affected 0 rows (deleted concurrently?)')
        }
        routerLoggedMisses.delete(msg.id)
      }
    }
}

// ---- voice helpers (message-router level) ----------------------------------

// Extract attachment_file_id from a <channel ... attachment_kind="voice" attachment_file_id="..."> block.
function extractVoiceFileId(content: string): string | null {
  if (!content.includes('attachment_kind="voice"')) return null
  const m = content.match(/attachment_file_id="([^"]+)"/)
  return m ? m[1] : null
}

// Extract chat_id from a <channel chat_id="..."> block.
function extractChatId(content: string): string | null {
  const m = content.match(/chat_id="([^"]+)"/)
  return m ? m[1] : null
}

// Replace the voice attachment block with a transcript prefix.
// Removes attachment_kind and attachment_file_id attributes; prepends [Hang átirat]:.
function injectTranscript(content: string, transcript: string): string {
  // Strip the attachment attributes from the opening tag
  let result = content
    .replace(/\s*attachment_kind="voice"/, '')
    .replace(/\s*attachment_file_id="[^"]*"/, '')
  // Replace the body with the transcript unconditionally (handles empty, "(empty message)", and caption).
  // Replacer function avoids $1/$& special-pattern interpretation in the transcript string.
  result = result.replace(
    /(<channel[^>]*>)[\s\S]*?(<\/channel>)/,
    (_m, open: string, close: string) => `${open}\n[Hang átirat]: ${transcript}\n${close}`,
  )
  return result
}

// Transcribe an inbound voice message. Calls transcribeVoiceFile() DIRECTLY
// (in-process) instead of self-HTTP'ing to /api/voice/stt: the old fetch to
// the same process's dashboard (65s AbortSignal) ran on the tick and coupled
// delivery to the HTTP server -- under sustained voice traffic it progressively
// throttled the event loop (/api/agents 73ms -> 12s -> timeout). The whisper
// subprocess keeps its own 60s timeout inside transcribeVoiceFile, so this can
// never hang the tick beyond that. Returns the transcript, or null on failure.
async function callVoiceSTT(fileId: string, agentId: string): Promise<string | null> {
  try {
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')

    // Resolve the agent's channel state_dir using the canonical helper so
    // sub-agents (whose .env lives under AGENTS_BASE_DIR) are found correctly.
    const resolvedDir = resolveAgentChannelStateDir(agentId, 'telegram')
    if (!existsSync(join(resolvedDir, '.env'))) return null

    const { transcribeVoiceFile } = await import('./routes/voice.js')
    return await transcribeVoiceFile(fileId, resolvedDir)
  } catch (err) {
    logger.warn({ err }, 'message-router: callVoiceSTT error')
    return null
  }
}

