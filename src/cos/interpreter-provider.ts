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
import { OpenAiLlmClient, DEFAULT_OPENAI_MODEL } from './openai-interpreter.js'
import { registerKnownSecret } from '../known-secrets.js'

/** Read a credential from the environment, falling back to the vault, and
 *  REGISTER it either way (W13 closure invariant).
 *
 *  The vault accessor registers what it hands out, so the vault branch is
 *  covered twice over; the ENV branch is the one that would otherwise be a hole
 *  — and on this machine the live Anthropic key has arrived both ways. */
function credentialFromEnvOrVault(fromEnv: string | undefined, fromVault: () => string | null | undefined): string {
  const value = (fromEnv || fromVault() || '').trim()
  if (value) registerKnownSecret(value)
  return value
}

/** DeepSeek's Anthropic-compatible endpoint. The SDK appends /v1/messages. */
export const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'

/** Goal interpretation is short, structured extraction: read a thread, return
 *  three fields of JSON. The cheap fast tier is the right one; a reasoning model
 *  would cost more for the same answer. */
export const DEEPSEEK_INTERPRETER_MODEL = 'deepseek-v4-flash'

export interface ResolvedInterpreter {
  client: LlmClient
  /** For the log line, so a reader can see WHICH model wrote the goals. */
  provider: 'anthropic' | 'openai' | 'deepseek'
  model: string
  // NO `profile` FIELD. It used to be here, filled at five call sites and read
  // at none (review #5, Ö-4). A field that carries a POLICY CLAIM and is never
  // checked is worse than an absent one: the next reader concludes from its
  // presence that the profile gate runs on this path, and it does not. The
  // reading path's rule is provider-data-policy.ts (WHICH PROVIDER may see which
  // tier); the profile allowlist in sensitivity.ts governs the SENDING path.
}

// WHERE THE READING PATH'S RULE LIVES — and why there is no profile table here.
//
// There used to be an `INTERPRETER_PROFILE` map declaring which §10 model
// profile each interpreter counts as. Nothing read it (review #5, Ö-4), and it
// stated a rule that does NOT govern this path: it said the cheap interpreters
// are `analysis_efficient`, which the profile allowlist forbids for
// SENSITIVE_PERSONAL and above — while the reader sweep happily routes those
// cases by provider instead. Two tables, two answers, one of them unread.
//
// The two rules, each named once, so the next reader finds both:
//   - READING path (what a model may be shown): provider-data-policy.ts —
//     WHICH PROVIDER is cleared for which tier (Istvan, 2026-08-11).
//   - SENDING path (what may go out of the system): PROFILE_ALLOWLIST in
//     sensitivity.ts.
// Reinstating a profile claim here means wiring it to a check, not writing the
// field back.

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
export function resolveInterpreter(
  getSecret: SecretReader,
  opts: { maxTokens?: number } = {},
): ResolvedInterpreter | null {
  // Env first, then the VAULT. The vault branch is not a nicety: Istvan handed
  // over an Anthropic key on 2026-08-11 and it went into the vault, where the
  // env-only lookup could not see it -- the provider would have stayed DeepSeek
  // while every report said "switched to Anthropic". A key nobody reads is the
  // same as no key, and it would have been invisible in the cycle output.
  const anthropicKey = credentialFromEnvOrVault(
    process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
    () => getSecret('ANTHROPIC_API_KEY'),
  )
  if (anthropicKey) {
    return {
      client: new AnthropicLlmClient({
        apiKey: anthropicKey, model: DEFAULT_INTERPRETER_MODEL, maxTokens: opts.maxTokens,
      }),
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
        maxTokens: opts.maxTokens,
      }),
      provider: 'deepseek',
      model: DEEPSEEK_INTERPRETER_MODEL,
    }
  }

  return null
}

/** What the §10.2 Reader needs, as opposed to what goal enrichment needs.
 *
 *  Not a guess, and raised twice against live measurement: at 2048 every call on
 *  deepseek-v4-flash burned the whole budget inside a thinking block and emitted
 *  no text; at 8192 one case reached the packet and was cut mid-JSON, another
 *  still produced thinking only. The packet itself is ~600 tokens — the rest is
 *  a reasoning model thinking over the context first, which is why the input
 *  side was bounded at the same time (context-builder's per-item ceiling).
 *  Raising this alone would have been treating the symptom. */
export const READER_MAX_TOKENS = 16384

/**
 * Both readers the §10 routing needs: one cleared for sensitive content and one
 * for everything else (Istvan's decision, 2026-08-11).
 *
 * `contracted` is null when no Anthropic key exists anywhere — and that is a
 * REPORTABLE state, not a fallback: sensitive cases are then skipped rather
 * than quietly sent to the general provider. `general` is whatever
 * resolveInterpreter picks, which is the cheap path when both keys are present.
 */
export function resolveReaderInterpreters(
  getSecret: SecretReader,
  opts: { maxTokens?: number } = {},
): { contracted: ResolvedInterpreter | null; general: ResolvedInterpreter | null } {
  const anthropicKey = credentialFromEnvOrVault(
    process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
    () => getSecret('ANTHROPIC_API_KEY'),
  )
  // TWO contracted providers, tried in order (Istvan, 2026-08-11: sensitive may
  // go to Anthropic or OpenAI). The second one is not redundancy for its own
  // sake: with a single cleared provider, an expired key means every sensitive
  // case is refused — correct, and it stops the work. With two, the sweep
  // degrades instead of halting, and the refusal that remains means "neither
  // cleared provider is available", which is a different and much rarer fact.
  const openaiKey = (process.env.OPENAI_API_KEY || (getSecret('OPENAI_API_KEY') ?? '')).trim()
  const contracted: ResolvedInterpreter | null = anthropicKey
    ? {
        client: new AnthropicLlmClient({
          apiKey: anthropicKey, model: DEFAULT_INTERPRETER_MODEL, maxTokens: opts.maxTokens,
        }),
        provider: 'anthropic',
        model: DEFAULT_INTERPRETER_MODEL,
      }
    : openaiKey
      ? {
          client: new OpenAiLlmClient({
            apiKey: openaiKey, model: DEFAULT_OPENAI_MODEL, maxTokens: opts.maxTokens,
          }),
          provider: 'openai',
          model: DEFAULT_OPENAI_MODEL,
        }
      : null

  // The general reader is the CHEAP one when it exists — that is the whole
  // point of routing by tier rather than sending everything to the contracted
  // provider. Falls back to the contracted client when no DeepSeek key exists,
  // because a cleared provider is always acceptable for a lower tier.
  const deepseekKey = (getSecret('DEEPSEEK_API_KEY') ?? '').trim()
  const general: ResolvedInterpreter | null = deepseekKey
    ? {
        client: new AnthropicLlmClient({
          apiKey: deepseekKey,
          baseURL: DEEPSEEK_ANTHROPIC_BASE_URL,
          model: DEEPSEEK_INTERPRETER_MODEL,
          maxTokens: opts.maxTokens,
        }),
        provider: 'deepseek',
        model: DEEPSEEK_INTERPRETER_MODEL,
      }
    : contracted

  return { contracted, general }
}
