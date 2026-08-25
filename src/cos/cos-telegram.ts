// The CoS's own Telegram channel (Istvan's decision, 2026-08-11): case traffic
// separated from build and fleet traffic, so an owner question is not competing
// with a commit report for the same notification.
//
// WHY NOT THE CHANNEL PLUGIN. The fleet's existing Telegram plugin is installed
// at USER level, which means every agent in the fleet loads it. A second plugin
// bound to a second bot would do the same, and several agents polling one bot
// split its updates between them at random -- we have hit exactly that before.
// Outbound needs no plugin at all (it is one HTTPS call), and inbound is a poll
// that ONE owner should run. So this module owns both, and nothing else does.
//
// The token never appears in a log line, an error message or a bus message. It
// is read from a 0600 file at call time and used as a URL segment, nothing else.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type Database from 'better-sqlite3'
import type { ExecutionIdentity } from '../identity/execution-identity.js'
import type { Classification } from '../identity/sensitivity-scale.js'
import { brokerExternalAction } from '../identity/action-broker.js'
import { scheduledIdentityFromEnv } from '../identity/scheduled-task-identity.js'

export interface CosBotConfig {
  token: string
  /** The channel IDENTITY, which is the BOT and not the chat.
   *
   *  Measured 2026-08-11: the CoS bot's private chat with Istvan has the SAME
   *  chat_id as the fleet bot's, because in a private chat Telegram uses the
   *  user's own id. Storing only the chat id would make the two channels
   *  indistinguishable — and the answer matching built for the split would then
   *  mis-attribute exactly the way the split exists to prevent. */
  channelId?: string
  /** The chat the questions go to. Unknown until Istvan messages the bot once —
   *  Telegram does not disclose a user to a bot before that. */
  chatId?: string
  /** WHOSE replies this channel accepts as owner answers (review 2026-08-12,
   *  T-4).
   *
   *  This is an AUTHORISATION boundary, not a display setting: a message that
   *  passes it closes questions and writes OWNER_DECISION events onto cases. The
   *  bot is reachable by anyone who finds it, so the check has to exist — it
   *  just must not live as a literal in a tracked script, which is where it was.
   *  Config is where deployment-local identity belongs, and a second deployment
   *  has no way to discover a constant buried in a poller. */
  ownerId?: string
  botUsername?: string
  /** WHICH KINDS OF MESSAGE this channel carries.
   *
   *  Istvan's open question (2026-08-11): should radar hits move here too, or
   *  stay on the dev channel? The answer is one config value rather than a
   *  rewrite, which is the point of the outbox — the work is the queue, not the
   *  bot. Absent or empty means owner questions ONLY, because turning a channel
   *  ON is a decision and a default must never make it silently.
   *
   *  OPTIONAL on the type, always present from `loadCosBotConfig`. The send
   *  path does not care which routes a channel carries, and making every
   *  caller that builds a config for a send state an empty list would be
   *  ceremony, not safety. */
  routes?: string[]
}

/** The route name for radar hits, so the config file and the producer cannot
 *  drift apart on a spelling. */
export const ROUTE_RADAR = 'radar'

/**
 * The CoS bot config. Deployment-local, gitignored, and the file that decides
 * WHO may answer:
 *
 * ```json
 * {
 *   "token": "...",              // from BotFather
 *   "channel_id": "telegram:cos",
 *   "chat_id": "...",            // known once the owner messages the bot
 *   "owner_id": "123456789",     // REQUIRED for the inbox — see below
 *   "routes": []
 * }
 * ```
 *
 * `owner_id` is the Telegram user id whose replies count as OWNER answers. Until
 * 2026-08-12 it was a literal inside `scripts/cos-channel-poll.ts`; it is
 * deployment-local identity on an authorisation path, so it belongs here.
 *
 * ON UPGRADE: an existing config has no `owner_id`, and the poller then REFUSES
 * every message and says so in its cycle line rather than accepting anyone. That
 * is the intended direction of failure — add the field to resume the inbox.
 */
export const COS_BOT_CONFIG_PATH = 'store/.cos-telegram-bot.json'

/** The RADAR bot (Istvan's decision, 2026-08-11: "legyen harmadik bot").
 *
 *  A separate bot, not a second route on the CoS one, because the separation he
 *  wants is on HIS side: a radar hit and an owner question deserve different
 *  notification treatment on his phone, and Telegram's unit of that is the bot.
 *  On this side the cost is the same either way — the work was the outbox, which
 *  already exists. */
export const RADAR_BOT_CONFIG_PATH = 'store/.cos-radar-bot.json'

/** Every channel this machine can send on, in the order they were configured.
 *
 *  MISSING IS NOT BROKEN. A config file that does not exist means that channel
 *  was never set up, which is a normal state and must not read as an outage —
 *  the radar bot did not exist at all until Istvan created it. Callers that need
 *  a specific channel ask for it and handle null; callers that drain the outbox
 *  iterate over whatever is here. */
export function loadChannelConfigs(
  paths: { cos?: string; radar?: string } = {},
): CosBotConfig[] {
  const out: CosBotConfig[] = []
  const cos = loadCosBotConfig(paths.cos ?? COS_BOT_CONFIG_PATH)
  if (cos) out.push(cos)
  const radar = loadCosBotConfig(paths.radar ?? RADAR_BOT_CONFIG_PATH)
  // The radar config declares its own channel id; falling back to the CoS one
  // would silently merge the two channels the file exists to separate.
  if (radar && radar.channelId !== cos?.channelId) out.push(radar)
  return out
}

/** The channel that carries a given kind of message, or null when none does.
 *  Used by producers (the radar) to address their outbox entry. */
export function channelForRoute(
  route: string, paths: { cos?: string; radar?: string } = {},
): CosBotConfig | null {
  return loadChannelConfigs(paths).find(c => c.routes?.includes(route)) ?? null
}

export function loadCosBotConfig(path = COS_BOT_CONFIG_PATH): CosBotConfig | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const token = typeof j.token === 'string' ? j.token.trim() : ''
    if (!token) return null
    return {
      token,
      // Defaults to the CoS channel ONLY for the CoS file. A second bot whose
      // config forgot `channel_id` must not inherit the first one's address —
      // that would put both channels' traffic in one queue and undo the split.
      channelId: typeof j.channel_id === 'string'
        ? j.channel_id
        : (path.endsWith('.cos-telegram-bot.json') ? 'telegram:cos' : `telegram:${basename(path)}`),
      chatId: typeof j.chat_id === 'string' ? j.chat_id : undefined,
      // Accepts a number too: Telegram user ids are numeric in every payload
      // Istvan would copy from, and a config that silently ignores `12345`
      // because it wanted `"12345"` fails CLOSED in the most confusing way —
      // the poller would then accept nobody and report only `rejected`.
      ownerId: typeof j.owner_id === 'string'
        ? j.owner_id
        : (typeof j.owner_id === 'number' ? String(j.owner_id) : undefined),
      botUsername: typeof j.bot_username === 'string' ? j.bot_username : undefined,
      routes: Array.isArray(j.routes) ? j.routes.filter(r => typeof r === 'string') as string[] : [],
    }
  } catch { return null }
}

/** Strip anything token-shaped out of a message we are about to surface. The
 *  token is a URL segment here, so a transport error can echo the whole URL back
 *  — and an error string is exactly the thing that ends up in a log, a bus
 *  message and eventually a screenshot. */
export function redactToken(text: string, token: string): string {
  if (!token) return text
  const bare = token.split(':')[0]
  return text.split(token).join('<token>').split(`bot${bare}`).join('bot<token>')
}

async function call<T>(
  cfg: CosBotConfig, method: string, body: unknown, fetchImpl: typeof fetch, timeoutMs: number,
): Promise<T> {
  const url = `https://api.telegram.org/bot${cfg.token}/${method}`
  let r: Response
  try {
    r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw new Error(redactToken(`telegram ${method} failed: ${String((e as Error)?.message ?? e)}`, cfg.token))
  }
  const text = await r.text()
  if (!r.ok) throw new Error(redactToken(`telegram ${method}: ${r.status} ${text.slice(0, 200)}`, cfg.token))
  const j = JSON.parse(text) as { ok: boolean; result: T; description?: string }
  if (!j.ok) throw new Error(redactToken(`telegram ${method}: ${j.description ?? 'not ok'}`, cfg.token))
  return j.result
}

export interface SendOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /**
   * W10: WHO is sending. Defaults to the scheduled identity carried in the
   * environment, so a cycle step needs no change to be identified — and a script
   * run by hand, with no such environment, gets NO identity and is refused.
   *
   * Pass `null` explicitly to assert "no identity", which is a denial, not a
   * bypass. There is no value of this field that skips the broker.
   */
  identity?: ExecutionIdentity | null
  /** Sensitivity of the text. Defaults to CONFIDENTIAL: a CoS question quotes a
   *  case, and guessing low about someone's private business is the one direction
   *  a default must never be wrong in. */
  classification?: Classification
  /** Where the audit row and counters go. */
  db?: Database.Database
}

/** Thrown when the boundary refuses a send. Distinct from a transport failure,
 *  because "we were not allowed to" and "Telegram said no" are different facts
 *  and a caller that retries the second must not retry the first. */
export class CosSendRefused extends Error {
  constructor(public readonly reasons: string[]) {
    super(`CoS send refused by the policy boundary: ${reasons.join('; ')}`)
    this.name = 'CosSendRefused'
  }
}

/**
 * Send one question to the CoS chat. Returns the Telegram message id, which is
 * what lets a later reply be tied back to THIS question rather than to whatever
 * was asked most recently.
 *
 * W10: this is the single external write for the CoS channel, so the broker sits
 * INSIDE it rather than in front of it at three call sites. Callers cannot forget
 * the gate, because there is no path to the transport that does not go through
 * it — the `call()` helper is module-private and this is its only mutating use.
 */
export async function sendCosMessage(
  cfg: CosBotConfig, text: string, opts: SendOptions = {},
): Promise<{ messageId: number; chatId: string }> {
  if (!cfg.chatId) {
    // Named as configuration, not as a transport failure: until Istvan writes to
    // the bot once, Telegram will not tell us which chat he is.
    throw new Error('CoS bot has no chat_id yet — Istvan must message the bot once')
  }
  const identity = opts.identity === undefined ? scheduledIdentityFromEnv() : opts.identity

  const brokered = await brokerExternalAction(
    {
      connector: 'telegram.cos',
      operation: 'sendMessage',
      mutating: true,
      riskClass: 'ROUTINE',
      identity,
      classification: opts.classification
        ?? { level: 'CONFIDENTIAL', tags: [], basis: 'cos-telegram default: a CoS message quotes a case' },
      targetId: cfg.chatId,
      context: { textLength: text.length },
    },
    () => call<{ message_id: number; chat: { id: number } }>(
      cfg, 'sendMessage', { chat_id: cfg.chatId, text, disable_web_page_preview: true },
      opts.fetchImpl ?? fetch, opts.timeoutMs ?? 30_000),
    { db: opts.db, surface: 'cos_channel_send' },
  )

  if (brokered.outcome === 'DENIED') throw new CosSendRefused(brokered.reasons)
  // A transport failure is re-thrown as itself: the broker recorded it, and the
  // caller's existing error handling is about Telegram, not about policy.
  if (brokered.outcome === 'FAILED') throw new Error(brokered.error ?? 'telegram sendMessage failed')

  const res = brokered.value!
  return { messageId: res.message_id, chatId: String(res.chat.id) }
}

export interface CosUpdate {
  updateId: number
  chatId: string
  fromId: string
  /** The owner's own message id. Needed to store a message that could not be
   *  attributed: without it the held row cannot be deduplicated across polls. */
  messageId?: number
  text: string
  /** Set when the owner used Telegram's reply-to on one of our questions. */
  replyToMessageId?: number
}

/** Poll for replies. `offset` is the caller's cursor: Telegram only drops an
 *  update once it has been confirmed by a higher offset, so the caller persists
 *  it and a crash costs a re-read, never a lost answer. */
export async function pollCosUpdates(
  cfg: CosBotConfig, offset: number, opts: SendOptions = {},
): Promise<CosUpdate[]> {
  const raw = await call<Array<Record<string, any>>>(
    cfg, 'getUpdates', { offset, timeout: 0, allowed_updates: ['message'] },
    opts.fetchImpl ?? fetch, opts.timeoutMs ?? 30_000)
  const out: CosUpdate[] = []
  for (const u of raw) {
    const m = u.message
    if (!m?.text || !m.chat?.id || !m.from?.id) continue
    out.push({
      updateId: u.update_id,
      chatId: String(m.chat.id),
      fromId: String(m.from.id),
      messageId: typeof m.message_id === 'number' ? m.message_id : undefined,
      text: String(m.text),
      replyToMessageId: m.reply_to_message?.message_id,
    })
  }
  return out
}

/** Is this message plausibly an ANSWER, or is the owner asking something back?
 *
 *  Live 2026-08-11, within minutes of the channel going up: Istvan replied
 *  "Ez melyik számla?" to the Wizz Air question. The poller recorded it as his
 *  answer and CLOSED the case -- so a question of his became a decision of his
 *  in the ledger, and the real question stopped being asked.
 *
 *  The check is deliberately crude and fail-CLOSED: when it cannot tell, it
 *  refuses to treat the message as an answer. Refusing costs one manual
 *  follow-up; accepting writes a false OWNER_DECISION onto a case and silences
 *  the question. Those are not symmetric.
 *
 *  It does NOT try to understand the message. A model call here would add a
 *  second place for the meaning to drift, on the path whose whole job is to
 *  record what the owner actually said. */
export function looksLikeAQuestionBack(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  // A trailing question mark is the strongest signal and needs no language.
  if (/\?\s*$/.test(t)) return true
  // Hungarian interrogatives at the start, plus the English ones -- the owner
  // writes in both.
  if (/^\s*(mi|mit|miert|miért|melyik|hol|hogyan|hogy|ki|kinek|mikor|mennyi|milyen|van-e|lehet-e|what|which|why|how|who|when|where)\b/i.test(t)) return true
  return false
}
