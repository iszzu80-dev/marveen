// Which PROVIDER may see which sensitivity tier (§10, Istvan's decision 2026-08-11).
//
// WHAT THIS REPLACES, AND WHY. The §10 allowlist maps sensitivity tiers to
// MODEL PROFILES — HIGHLY_SENSITIVE to `premium_reasoning`, and so on. That
// table was written when `premium_reasoning` resolved to an Anthropic model and
// the cheap tiers resolved to DeepSeek, so the price tier COINCIDED with the
// provider, and the rule was built on the coincidence.
//
// The coincidence broke on 2026-08-11 when an Anthropic key arrived: Haiku and
// Opus are the same provider under the same terms, so refusing Haiku a
// sensitive case protects nothing — it only makes the same egress more
// expensive. Istvan's decision, in his words: sensitive content goes to a
// provider that is acceptable on data handling (Anthropic), everything else may
// go to DeepSeek v4.
//
// So the axis this file measures is WHERE THE CONTENT LANDS, not how clever the
// model is. The profile allowlist stays where it is and keeps doing its own job
// on the sending path; this is the reading path's question.
import { coerceSensitivity, effectiveSensitivity } from './sensitivity.js'
import { effectiveZstSensitivity, type ZstSensitivity } from './zst-sensitivity.js'
import type { CaseSensitivity } from './schema.js'

/** How a provider is classified for personal-data handling. */
export type DataHandlingClass =
  /** A provider Istvan has accepted for sensitive personal data. */
  | 'CONTRACTED'
  /** Everyone else. Not "untrusted" — just not cleared for sensitive content. */
  | 'THIRD_PARTY'

/**
 * The classification, per provider.
 *
 * This is a POLICY table and the only place the decision lives. Adding a
 * provider here is an owner decision about a data-processing relationship, not
 * a technical change — which is why a new provider defaults to THIRD_PARTY by
 * omission rather than by an entry someone has to remember to add.
 */
export const PROVIDER_DATA_CLASS: Record<string, DataHandlingClass> = {
  anthropic: 'CONTRACTED',
  // Istvan, 2026-08-11: "ha szenzitív akkor lehet Anthropic vagy openai."
  //
  // THE ENTRY IS CONDITIONAL AND THE CONDITION IS NOT DECORATION. What makes a
  // provider CONTRACTED here is the data-processing relationship, not the brand:
  // API business terms, with content not used for training. That holds for the
  // OpenAI PLATFORM API behind an organisation key — the only thing
  // OpenAiLlmClient talks to (it reads OPENAI_API_KEY and posts to
  // api.openai.com/v1).
  //
  // It does NOT hold for a personal ChatGPT subscription, which is what the
  // fleet's other OpenAI access is (the Codex CLI runs on Istvan's ChatGPT Plus
  // login). Nothing routes sensitive content through that path today, and
  // nothing may start to on the strength of this line.
  openai: 'CONTRACTED',
  deepseek: 'THIRD_PARTY',
}

/** Fail-closed: an unknown provider is THIRD_PARTY, never CONTRACTED. */
export function dataClassOf(provider: string): DataHandlingClass {
  return PROVIDER_DATA_CLASS[provider] === 'CONTRACTED' ? 'CONTRACTED' : 'THIRD_PARTY'
}

/** The tiers that may only go to a CONTRACTED provider. */
const CONTRACTED_ONLY: ReadonlySet<CaseSensitivity> = new Set<CaseSensitivity>([
  'SENSITIVE_PERSONAL', 'HIGHLY_SENSITIVE',
])

/** What a tier requires. PUBLIC and PERSONAL may go anywhere. */
export function requiredDataClass(tier: unknown): DataHandlingClass {
  return CONTRACTED_ONLY.has(coerceSensitivity(tier)) ? 'CONTRACTED' : 'THIRD_PARTY'
}

/**
 * May `provider` process content of `tier`?
 *
 * FAIL-CLOSED twice over: an unknown tier coerces to HIGHLY_SENSITIVE (via
 * coerceSensitivity) and an unknown provider classifies as THIRD_PARTY, so the
 * answer to a question nobody configured is always no.
 */
export function isProviderAllowedForSensitivity(provider: string, tier: unknown): boolean {
  if (requiredDataClass(tier) === 'THIRD_PARTY') return true
  return dataClassOf(provider) === 'CONTRACTED'
}

/** Providers that may take this tier — for the refusal message, so a blocked
 *  case says what WOULD have been allowed instead of only that it was refused. */
export function providersAllowedFor(tier: unknown): string[] {
  if (requiredDataClass(tier) === 'THIRD_PARTY') return Object.keys(PROVIDER_DATA_CLASS)
  return Object.keys(PROVIDER_DATA_CLASS).filter(p => dataClassOf(p) === 'CONTRACTED')
}

// ── The egress tier, for EITHER namespace ────────────────────────────────────
//
// WHY THIS IS HERE AND NOT IN EITHER SWEEP. The two namespaces carry different
// sensitivity vocabularies: `personal_cases.sensitivity` speaks PUBLIC /
// PERSONAL / SENSITIVE_PERSONAL / HIGHLY_SENSITIVE, `zst_cases.sensitivity`
// speaks PUBLIC / ZST_INTERNAL / ZST_CONFIDENTIAL / … Reading one with the
// other's coercer is not a small mistake — the personal coercer does not know
// `ZST_INTERNAL`, so it fail-closes to HIGHLY_SENSITIVE and EVERY corporate case
// is treated as maximally sensitive by DATA ABSENCE rather than by content.
//
// That is exactly what happened. `goal-enrichment.ts` grew a private `tierFor`
// to solve it for the enrichment sweep; the Reader sweep — the module that
// enrichment copied its `routeFor` FROM — kept calling the personal coercer, and
// every ZST case it read went to the contracted provider with a stored refusal
// reason claiming the content was HIGHLY_SENSITIVE. Two paths, one question, and
// only one of them had the answer. So the answer moves here, where both paths
// already import from, and the standing check in cos-egress-tier.test.ts fails
// if they ever disagree again.
//
// It is also STRICTER than the private version it replaces: that one coerced the
// declared corporate tier and never ran the corporate content classifier, so an
// IBAN in a ZST_INTERNAL thread did not lift the tier. Here it does.

/**
 * The corporate class → egress tier map.
 *
 * NOT invented: each row is the corporate class whose model-profile allowlist
 * (zst-sensitivity.ts) is identical to the personal tier's allowlist
 * (sensitivity.ts). The standing check re-derives it from those two tables, so
 * this cannot drift into a private opinion about corporate data.
 */
export const ZST_TO_EGRESS_TIER: Record<ZstSensitivity, CaseSensitivity> = {
  PUBLIC: 'PUBLIC',
  ZST_INTERNAL: 'PERSONAL',
  ZST_CONFIDENTIAL: 'SENSITIVE_PERSONAL',
  ZST_FINANCIAL: 'HIGHLY_SENSITIVE',
  ZST_LEGAL: 'HIGHLY_SENSITIVE',
  ZST_PERSONAL_DATA: 'HIGHLY_SENSITIVE',
  ZST_HIGHLY_SENSITIVE: 'HIGHLY_SENSITIVE',
  UNKNOWN: 'HIGHLY_SENSITIVE',
}

/**
 * What tier does this content travel at, on the provider axis?
 *
 * Declared tier AND content, in BOTH namespaces: each side escalates the case's
 * own declaration with its own classifier, so an IBAN lifts the tier even when
 * nobody labelled the case — and the corporate side uses the corporate patterns,
 * not the personal ones.
 *
 * Fail-closed on the domain too: anything that is not literally 'zst' is read
 * with the personal vocabulary, which is what every non-corporate caller means.
 */
export function egressTierFor(
  domain: 'personal' | 'zst' | string,
  declared: unknown,
  content: string,
): CaseSensitivity {
  if (domain !== 'zst') return effectiveSensitivity(declared, content)
  return ZST_TO_EGRESS_TIER[effectiveZstSensitivity(declared, content)] ?? 'HIGHLY_SENSITIVE'
}
