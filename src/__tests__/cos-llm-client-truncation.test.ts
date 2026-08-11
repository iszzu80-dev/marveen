// What the client says when the model runs out of room.
//
// Live, 2026-08-11: every §10.2 Reader call on deepseek-v4-flash came back with
// content `[thinking]` and stop_reason `max_tokens` — the model reasoned until
// the ceiling and never emitted text. The client reported "Unexpected response —
// no text block found. Content types: thinking", which reads as a protocol
// mismatch and sends the next person to look at the wrong provider. It was a
// budget that was too small.
//
// The old check only reported truncation if it had ALREADY found a text block,
// so the one truncation shape that produces no text was the one it could not
// name. These tests pin the order.
import { describe, it, expect } from 'vitest'
import { AnthropicLlmClient } from '../cos/progression-interpreter.js'
import { READER_MAX_TOKENS } from '../cos/interpreter-provider.js'

/** Drive complete() against a fake SDK response by replacing the lazily-built
 *  client promise — the network is never reached. */
function withResponse(resp: unknown, opts: Record<string, unknown> = {}): AnthropicLlmClient {
  const c = new AnthropicLlmClient({ apiKey: 'test', ...opts })
  ;(c as unknown as { clientPromise: Promise<unknown> }).clientPromise = Promise.resolve({
    messages: { create: async () => resp },
  })
  return c
}

describe('LLM client truncation reporting', () => {
  it('HEADLINE: names truncation when the model emitted ONLY thinking', () => {
    const c = withResponse({ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '...' }] })
    return expect(c.complete('sys', 'user')).rejects.toThrow(/truncated at max_tokens/)
  })

  it('the message says the ceiling and the block types, so the fix is obvious', async () => {
    const c = withResponse(
      { stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '...' }] },
      { maxTokens: 2048 },
    )
    await expect(c.complete('sys', 'user')).rejects.toThrow(/2048/)
    await expect(c.complete('sys', 'user')).rejects.toThrow(/Blocks: thinking/)
  })

  it('still names truncation when a partial text block exists', async () => {
    const c = withResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a":1' }] })
    await expect(c.complete('sys', 'user')).rejects.toThrow(/truncated at max_tokens/)
    await expect(c.complete('sys', 'user')).rejects.toThrow(/\{"a":1/)
  })

  it('a complete reply is returned, thinking block and all', async () => {
    // The counter-case: thinking blocks are normal, and must not look like an error.
    const c = withResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: '{"ok":true}' }],
    })
    expect(await c.complete('sys', 'user')).toBe('{"ok":true}')
  })

  it('a genuinely unusable response is still reported as such', async () => {
    const c = withResponse({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hmm' }] })
    await expect(c.complete('sys', 'user')).rejects.toThrow(/no text block found/)
  })

  it('the ceiling is per call site, and the Reader gets more than the default', () => {
    // §10.2's packet plus the reasoning that precedes it does not fit in the
    // budget that suits three-field goal extraction. One shared number means the
    // bigger job truncates every time.
    expect(new AnthropicLlmClient({ apiKey: 'x' }).maxTokens).toBe(2048)
    expect(READER_MAX_TOKENS).toBeGreaterThan(2048)
    expect(new AnthropicLlmClient({ apiKey: 'x', maxTokens: READER_MAX_TOKENS }).maxTokens)
      .toBe(READER_MAX_TOKENS)
  })
})
