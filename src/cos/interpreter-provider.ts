// Which model interprets a case goal, and where the key comes from.
//
// Split out from the runner so the choice is one testable function rather than
// a chain of `||` at a call site. Istvan's decision, 2026-08-10: there is no
// Anthropic key on this machine, and the vault holds a DeepSeek one, so use
// DeepSeek.
//
// Why one client and not two: the Anthropic SDK speaks a protocol, and DeepSeek
// serves that protocol at /anthropic. The fleet already runs its non-Claude
// agents this way (agent-process.ts sets ANTHROPIC_BASE_URL to exactly this
// endpoint). A second, provider-specific client would be a second place for the
// interpreter's prompt-injection guard to be forgotten.

import { AnthropicLlmClient, DEFAULT_INTERPRETER_MODEL, type LlmClient } from './progression-interpreter.js'

/** DeepSeek's Anthropic-compatible endpoint. The SDK appends /v1/messages. */
export const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'

/** Goal interpretation is short, structured extraction: read a thread, return
 *  three fields of JSON. The cheap fast tier is the right one; a reasoning model
 *  would cost more for the same answer. */
export const DEEPSEEK_INTERPRETER_MODEL = 'deepseek-v4-flash'

export interface ResolvedInterpreter {
  client: LlmClient
  /** For the log line, so a reader can see WHICH model wrote the goals. */
  provider: 'anthropic' | 'deepseek'
  model: string
}

/** Read a secret without the caller having to know where secrets live, and
 *  without importing the web layer into the cos domain at module load. */
export type SecretReader = (id: string) => string | null | undefined

/** Pick the interpreter. Order is deliberate:
 *
 *  1. An Anthropic key in the environment wins. It is what the interpreter was
 *     written and tuned against, so if it is present, use it.
 *  2. Otherwise the vault's DeepSeek key, over the Anthropic-compatible endpoint.
 *  3. Otherwise NOTHING — and the caller must report that, not substitute.
 *
 *  Returning null rather than a client that will fail on first use keeps the two
 *  facts apart: "no interpreter is configured" is a different thing from "the
 *  interpreter ran and produced nothing", and only the second one means the
 *  goals are as good as they are going to get. */
export function resolveInterpreter(getSecret: SecretReader): ResolvedInterpreter | null {
  const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
  if (anthropicKey) {
    return {
      client: new AnthropicLlmClient({ apiKey: anthropicKey, model: DEFAULT_INTERPRETER_MODEL }),
      provider: 'anthropic',
      model: DEFAULT_INTERPRETER_MODEL,
    }
  }

  const deepseekKey = getSecret('DEEPSEEK_API_KEY')
  if (deepseekKey && deepseekKey.trim()) {
    return {
      client: new AnthropicLlmClient({
        apiKey: deepseekKey.trim(),
        baseURL: DEEPSEEK_ANTHROPIC_BASE_URL,
        model: DEEPSEEK_INTERPRETER_MODEL,
      }),
      provider: 'deepseek',
      model: DEEPSEEK_INTERPRETER_MODEL,
    }
  }

  return null
}
