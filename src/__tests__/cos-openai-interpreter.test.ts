import { describe, it, expect } from 'vitest'
import { OpenAiLlmClient, OPENAI_API_URL } from '../cos/openai-interpreter.js'
import { isProviderAllowedForSensitivity, providersAllowedFor } from '../cos/provider-data-policy.js'

// Istvan, 2026-08-11: DeepSeek is the default because it is cheapest; sensitive
// content may go to Anthropic OR OpenAI. This file covers the second half — the
// adapter itself, and the policy entry that lets it receive sensitive content.

function fakeFetch(body: unknown, ok = true, status = 200): { impl: typeof fetch; seen: any[] } {
  const seen: any[] = []
  const impl = (async (url: string, init: any) => {
    seen.push({ url, init, parsed: JSON.parse(init.body) })
    return {
      ok, status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { impl, seen }
}

describe('the OpenAI adapter speaks OpenAI, not Anthropic', () => {
  it('sends system and user as MESSAGES and reads choices[].message.content', async () => {
    // The reason this is a real adapter rather than a baseURL swap: DeepSeek
    // works through the Anthropic SDK because it serves an Anthropic-compatible
    // endpoint. OpenAI does not — different request shape, different response
    // shape, different truncation signal.
    const { impl, seen } = fakeFetch({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] })
    const c = new OpenAiLlmClient({ apiKey: 'k', fetchImpl: impl })
    const out = await c.complete('RENDSZER', 'ADAT')
    expect(out).toBe('{"ok":true}')
    expect(seen[0].url).toBe(OPENAI_API_URL)
    expect(seen[0].parsed.messages).toEqual([
      { role: 'system', content: 'RENDSZER' },
      { role: 'user', content: 'ADAT' },
    ])
    expect(seen[0].init.headers.Authorization).toBe('Bearer k')
  })

  it('reports TRUNCATION as truncation, not as a missing-content protocol error', async () => {
    // The ordering the Anthropic client had to learn live: a model that spends
    // the ceiling on reasoning returns finish_reason 'length' with empty
    // content, and calling that "no content" sends the next person to the wrong
    // fix entirely.
    const { impl } = fakeFetch({ choices: [{ message: { content: '{"partial"' }, finish_reason: 'length' }] })
    const c = new OpenAiLlmClient({ apiKey: 'k', fetchImpl: impl, maxTokens: 64 })
    await expect(c.complete('s', 'u')).rejects.toThrow(/truncated at max_completion_tokens \(64/)
  })

  it('says NOT CONFIGURED when there is no key, rather than failing as a transport error', async () => {
    const { impl } = fakeFetch({})
    const c = new OpenAiLlmClient({ fetchImpl: impl })
    const prev = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      await expect(c.complete('s', 'u')).rejects.toThrow(/not configured/)
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev
    }
  })

  it('surfaces an HTTP failure with its status', async () => {
    const { impl } = fakeFetch({ error: { message: 'nope' } }, false, 401)
    const c = new OpenAiLlmClient({ apiKey: 'k', fetchImpl: impl })
    await expect(c.complete('s', 'u')).rejects.toThrow(/401/)
  })
})

describe('the policy table after the owner decision', () => {
  it('OpenAI may take sensitive content; DeepSeek still may not', async () => {
    expect(isProviderAllowedForSensitivity('openai', 'HIGHLY_SENSITIVE')).toBe(true)
    expect(isProviderAllowedForSensitivity('anthropic', 'HIGHLY_SENSITIVE')).toBe(true)
    expect(isProviderAllowedForSensitivity('deepseek', 'HIGHLY_SENSITIVE'),
      'the cheap default must not silently gain clearance').toBe(false)
  })

  it('DeepSeek is still allowed for ordinary content — it is the default, not the exception', async () => {
    expect(isProviderAllowedForSensitivity('deepseek', 'PERSONAL')).toBe(true)
    expect(isProviderAllowedForSensitivity('deepseek', 'PUBLIC')).toBe(true)
  })

  it('an unknown provider gains nothing from the new entry', async () => {
    expect(isProviderAllowedForSensitivity('openai-compatible-gateway', 'SENSITIVE_PERSONAL')).toBe(false)
    expect(isProviderAllowedForSensitivity('', 'SENSITIVE_PERSONAL')).toBe(false)
  })

  it('the refusal message names OpenAI among the providers that WOULD be allowed', async () => {
    // A refusal that does not say what would have worked is half a refusal.
    expect(providersAllowedFor('HIGHLY_SENSITIVE').sort()).toEqual(['anthropic', 'openai'])
  })
})
