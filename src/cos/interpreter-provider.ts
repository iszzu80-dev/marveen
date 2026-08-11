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
import type { ModelProfileId } from '../model-profiles.js'

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
  /** Which §10 model profile this interpreter counts as, for the sensitivity
   *  allowlist. Carried EXPLICITLY rather than inferred at the call site: a gate
   *  that guesses which profile it is protecting is a gate nobody can audit. */
  profile: ModelProfileId
}

/**
 * Interpreter → model profile.
 *
 * Derived from the deployment's own map (`store/model-profile-map.json`), not
 * from a guess: there `analysis_efficient` and `routine_lowcost` both resolve to
 * a DeepSeek model, and the two Claude tiers to Opus and Sonnet. Both
 * interpreters here are cheap-tier models — DeepSeek flash and Claude Haiku —
 * so neither counts as `premium_reasoning`, and the §10 allowlist consequently
 * keeps SENSITIVE_PERSONAL and above away from both.
 *
 * If that becomes too strict for the Reader, the fix is a decision about WHICH
 * MODEL may read sensitive cases — an owner call — not a quieter profile here.
 */
export const INTERPRETER_PROFILE: Record<'anthropic' | 'deepseek', ModelProfileId> = {
  anthropic: 'analysis_efficient',
  deepseek: 'analysis_efficient',
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
export function resolveInterpreter(
  getSecret: SecretReader,
  opts: { maxTokens?: number } = {},
): ResolvedInterpreter | null {
  // Env first, then the VAULT. The vault branch is not a nicety: Istvan handed
  // over an Anthropic key on 2026-08-11 and it went into the vault, where the
  // env-only lookup could not see it -- the provider would have stayed DeepSeek
  // while every report said "switched to Anthropic". A key nobody reads is the
  // same as no key, and it would have been invisible in the cycle output.
  const anthropicKey = process.env.ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_AUTH_TOKEN
    || (getSecret('ANTHROPIC_API_KEY') ?? '').trim()
  if (anthropicKey) {
    return {
      client: new AnthropicLlmClient({
        apiKey: anthropicKey, model: DEFAULT_INTERPRETER_MODEL, maxTokens: opts.maxTokens,
      }),
      provider: 'anthropic',
      model: DEFAULT_INTERPRETER_MODEL,
      profile: INTERPRETER_PROFILE.anthropic,
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
      profile: INTERPRETER_PROFILE.deepseek,
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
  const anthropicKey = process.env.ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_AUTH_TOKEN
    || (getSecret('ANTHROPIC_API_KEY') ?? '').trim()
  const contracted: ResolvedInterpreter | null = anthropicKey
    ? {
        client: new AnthropicLlmClient({
          apiKey: anthropicKey, model: DEFAULT_INTERPRETER_MODEL, maxTokens: opts.maxTokens,
        }),
        provider: 'anthropic',
        model: DEFAULT_INTERPRETER_MODEL,
        profile: INTERPRETER_PROFILE.anthropic,
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
        profile: INTERPRETER_PROFILE.deepseek,
      }
    : contracted

  return { contracted, general }
}
