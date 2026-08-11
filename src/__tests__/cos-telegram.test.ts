import { describe, it, expect } from 'vitest'
import { sendCosMessage, pollCosUpdates, redactToken, loadCosBotConfig, looksLikeAQuestionBack } from '../cos/cos-telegram.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TOKEN = '1234567:AAsecret-part-that-must-never-leak'
const CFG = { token: TOKEN, chatId: '999' }

function fake(ok: boolean, payload: unknown, httpOk = true, status = 200) {
  const seen: Array<{ url: string; body: any }> = []
  const impl = (async (url: string, init: any) => ({
    ok: httpOk, status,
    text: async () => { seen.push({ url, body: JSON.parse(init.body) }); return JSON.stringify({ ok, result: payload, description: 'bad chat' }) },
  } as unknown as Response)) as unknown as typeof fetch
  return { impl, seen }
}

describe('the token never travels in an error', () => {
  it('redacts the token out of any text', () => {
    const msg = `failed calling https://api.telegram.org/bot${TOKEN}/sendMessage`
    const red = redactToken(msg, TOKEN)
    expect(red).not.toContain('AAsecret-part-that-must-never-leak')
    expect(red).not.toContain('1234567')
    expect(red).toContain('<token>')
  })

  it('an HTTP failure surfaces WITHOUT the token', async () => {
    // The token is a URL segment, so an unredacted transport error carries the
    // whole credential into a log line, a bus message and eventually a
    // screenshot. This is the assertion that keeps that from happening.
    const { impl } = fake(false, null, false, 401)
    await expect(sendCosMessage(CFG, 'szia', { fetchImpl: impl })).rejects.toThrow(/telegram sendMessage: 401/)
    await sendCosMessage(CFG, 'szia', { fetchImpl: impl }).catch((e: Error) => {
      expect(e.message).not.toContain('AAsecret-part-that-must-never-leak')
    })
  })

  it('a network throw is redacted too', async () => {
    const impl = (async () => { throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendMessage`) }) as unknown as typeof fetch
    await sendCosMessage(CFG, 'x', { fetchImpl: impl }).catch((e: Error) => {
      expect(e.message).not.toContain('AAsecret')
      expect(e.message).toContain('<token>')
    })
  })
})

describe('sending', () => {
  it('posts to the configured chat and returns the message id', async () => {
    const { impl, seen } = fake(true, { message_id: 42, chat: { id: 999 } })
    const r = await sendCosMessage(CFG, 'kérdés', { fetchImpl: impl })
    expect(r).toEqual({ messageId: 42, chatId: '999' })
    expect(seen[0].body.chat_id).toBe('999')
    expect(seen[0].body.text).toBe('kérdés')
  })

  it('says NOT CONFIGURED when the chat is unknown, rather than failing at the wire', async () => {
    // Until Istvan writes to the bot once, Telegram will not disclose his chat.
    // That is a configuration fact and must not read as an outage.
    const { impl } = fake(true, {})
    await expect(sendCosMessage({ token: TOKEN }, 'x', { fetchImpl: impl }))
      .rejects.toThrow(/no chat_id yet/)
  })
})

describe('polling', () => {
  it('returns text messages with their chat, sender and reply target', async () => {
    const { impl } = fake(true, [
      { update_id: 7, message: { text: 'Igen', chat: { id: 999 }, from: { id: 5 }, reply_to_message: { message_id: 42 } } },
      { update_id: 8, message: { chat: { id: 999 }, from: { id: 5 } } },           // no text -> skipped
      { update_id: 9, message: { text: 'Nem', chat: { id: 999 }, from: { id: 5 } } },
    ])
    const ups = await pollCosUpdates(CFG, 0, { fetchImpl: impl })
    expect(ups).toHaveLength(2)
    expect(ups[0]).toEqual({ updateId: 7, chatId: '999', fromId: '5', text: 'Igen', replyToMessageId: 42 })
    expect(ups[1].replyToMessageId).toBeUndefined()
  })

  it('passes the caller offset through — a crash costs a re-read, not an answer', async () => {
    const { impl, seen } = fake(true, [])
    await pollCosUpdates(CFG, 118, { fetchImpl: impl })
    expect(seen[0].body.offset).toBe(118)
  })
})

describe('config', () => {
  it('returns null rather than a half-built config when the token is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cosbot-'))
    const p = join(dir, 'c.json')
    writeFileSync(p, JSON.stringify({ bot_username: 'x' }))
    expect(loadCosBotConfig(p)).toBeNull()
  })

  it('reads chat_id when it is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cosbot-'))
    const p = join(dir, 'c.json')
    writeFileSync(p, JSON.stringify({ token: TOKEN, chat_id: '123', bot_username: 'b' }))
    expect(loadCosBotConfig(p)).toMatchObject({ chatId: '123', botUsername: 'b' })
  })
})

describe('a question back is not an answer', () => {
  // Live 2026-08-11: Istvan replied "Ez melyik számla?" to the Wizz Air
  // question. It was recorded as his answer and closed the case, so his
  // question became his decision in the ledger.
  it('treats the live case as a question', () => {
    expect(looksLikeAQuestionBack('Ez melyik számla?')).toBe(true)
  })

  it('catches interrogatives even without a question mark', () => {
    for (const t of ['Melyik számla ez', 'mennyi lett a vege', 'Which invoice', 'miert nyilt ez meg']) {
      expect(looksLikeAQuestionBack(t), t).toBe(true)
    }
  })

  it('lets real answers through', () => {
    for (const t of ['Igen.', 'Nem kell vele foglalkozni.', 'Én voltam', 'Minden bérléshez megvan a kártya',
                     'Rendben van, a mostani bérlést is megoldottam']) {
      expect(looksLikeAQuestionBack(t), t).toBe(false)
    }
  })

  it('refuses an empty message rather than guessing', () => {
    expect(looksLikeAQuestionBack('   ')).toBe(true)
  })
})
