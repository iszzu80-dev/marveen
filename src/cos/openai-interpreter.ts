// OpenAI client for the interpreter layer (Istvan's decision, 2026-08-11:
// "deepseek legyen az alap ... ha szenzitív akkor lehet Anthropic vagy openai").
//
// WHY IT IS NOT THE ANTHROPIC CLIENT WITH A DIFFERENT baseURL. DeepSeek works
// that way because it serves an Anthropic-COMPATIBLE endpoint. OpenAI does not:
// the request shape (`messages` with an embedded system role, not a separate
// `system` field), the response shape (`choices[].message.content`, not a
// `content` block array) and the truncation signal (`finish_reason: 'length'`,
// not `stop_reason: 'max_tokens'`) all differ. Pointing the Anthropic SDK at
// api.openai.com would fail at the first call, so this is a real adapter.
//
// It exists to give SENSITIVE content a second home. Today one contracted
// provider is configured, so an expired Anthropic key means sensitive cases are
// refused entirely — correct, but it stops the work. With two, the sweep
// degrades to the other instead of stopping.
//
// Deliberately dependency-free: `fetch` is in the runtime, and adding an SDK for
// one POST would pull a dependency into the path that handles the most sensitive
// content in the system.

import type { LlmClient } from './progression-interpreter.js'

/** The cheapest OpenAI model that reliably returns the strict JSON the
 *  interpreter validates. Overridable per client, like the Anthropic one.
 *
 *  VERIFIED AGAINST THE ACCOUNT, not assumed. The first value here was
 *  `gpt-5.6-mini`, which I inferred from the naming pattern of the model the
 *  fleet uses elsewhere (gpt-5.6-sol). It does not exist: the live probe came
 *  back `model_not_found`. The account's 5.6 line is luna/sol/terra with no mini
 *  tier, and the newest mini is this one — confirmed by listing /v1/models and
 *  then completing a real request through it.
 *
 *  Worth stating because of WHEN it would have failed: this client is the
 *  FALLBACK for sensitive content. A wrong model id here costs nothing until the
 *  Anthropic key expires, and then the fallback fails at exactly the moment it
 *  exists for — an untested spare tyre. */
export const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini'

export const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions'

export interface OpenAiClientOptions {
  apiKey?: string
  /** For an OpenAI-compatible gateway. Omit for OpenAI itself. */
  baseURL?: string
  model?: string
  maxTokens?: number
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class OpenAiLlmClient implements LlmClient {
  private readonly apiKey?: string
  private readonly url: string
  private readonly model: string
  private readonly maxTokens: number
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(apiKeyOrOpts?: string | OpenAiClientOptions) {
    const o: OpenAiClientOptions = typeof apiKeyOrOpts === 'string' ? { apiKey: apiKeyOrOpts } : (apiKeyOrOpts ?? {})
    this.apiKey = o.apiKey
    this.url = o.baseURL ?? OPENAI_API_URL
    this.model = o.model ?? DEFAULT_OPENAI_MODEL
    this.maxTokens = o.maxTokens ?? 2048
    this.fetchImpl = o.fetchImpl ?? fetch
    this.timeoutMs = o.timeoutMs ?? 120_000
  }

  async complete(systemPrompt: string, userMessage: string): Promise<string> {
    const key = this.apiKey || process.env.OPENAI_API_KEY
    if (!key) {
      // Named as a CONFIGURATION fact, not a transport failure. Review #5 (Ö-3)
      // is exactly this distinction going wrong elsewhere: "not reachable" and
      // "never configured" send the next person to different, and one of them
      // wrong, places.
      throw new Error('OpenAI interpreter is not configured (no OPENAI_API_KEY)')
    }
    const resp = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        max_completion_tokens: this.maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`OpenAI request failed: ${resp.status} ${body.slice(0, 300)}`)
    }
    const j = await resp.json() as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
    }
    const choice = j.choices?.[0]
    // TRUNCATION FIRST, before looking for text — the same ordering the Anthropic
    // client had to learn the hard way. A model that spends the ceiling on
    // reasoning returns finish_reason 'length' with empty content, and reporting
    // that as "no content" reads as a protocol incompatibility rather than as
    // the budget problem it is.
    if (choice?.finish_reason === 'length') {
      throw new Error(
        `LLM reply truncated at max_completion_tokens (${this.maxTokens}, ${this.model}). `
        + `Raise maxTokens or shorten the input. `
        + `Partial: ${String(choice.message?.content ?? '').slice(0, 160) || '(no text emitted)'}`)
    }
    const text = choice?.message?.content
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error(
        `Unexpected OpenAI response — no message content. finish_reason: ${choice?.finish_reason ?? 'none'}`)
    }
    return text
  }
}
