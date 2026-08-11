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

export interface CosBotConfig {
  token: string
  /** The chat the questions go to. Unknown until Istvan messages the bot once —
   *  Telegram does not disclose a user to a bot before that. */
  chatId?: string
  botUsername?: string
}

export const COS_BOT_CONFIG_PATH = 'store/.cos-telegram-bot.json'

export function loadCosBotConfig(path = COS_BOT_CONFIG_PATH): CosBotConfig | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const token = typeof j.token === 'string' ? j.token.trim() : ''
    if (!token) return null
    return {
      token,
      chatId: typeof j.chat_id === 'string' ? j.chat_id : undefined,
      botUsername: typeof j.bot_username === 'string' ? j.bot_username : undefined,
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

export interface SendOptions { fetchImpl?: typeof fetch; timeoutMs?: number }

/** Send one question to the CoS chat. Returns the Telegram message id, which is
 *  what lets a later reply be tied back to THIS question rather than to whatever
 *  was asked most recently. */
export async function sendCosMessage(
  cfg: CosBotConfig, text: string, opts: SendOptions = {},
): Promise<{ messageId: number; chatId: string }> {
  if (!cfg.chatId) {
    // Named as configuration, not as a transport failure: until Istvan writes to
    // the bot once, Telegram will not tell us which chat he is.
    throw new Error('CoS bot has no chat_id yet — Istvan must message the bot once')
  }
  const res = await call<{ message_id: number; chat: { id: number } }>(
    cfg, 'sendMessage', { chat_id: cfg.chatId, text, disable_web_page_preview: true },
    opts.fetchImpl ?? fetch, opts.timeoutMs ?? 30_000)
  return { messageId: res.message_id, chatId: String(res.chat.id) }
}

export interface CosUpdate {
  updateId: number
  chatId: string
  fromId: string
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
      text: String(m.text),
      replyToMessageId: m.reply_to_message?.message_id,
    })
  }
  return out
}
