// CostOps v0.2 -- local, deterministic token-cost ESTIMATE.
//
// Pure arithmetic over the existing token_usage rows + a local pricing config.
// NO LLM, no provider API, no external pricing API, no secrets. Token cost is
// an ESTIMATE (confidence: estimate), kept SEPARATE from the v0.1 fixed/manual
// spend -- it is never an invoice.
//
// Rows without a model (unknown) or without a matching pricing entry are left
// UNPRICED (counted as volume only), never guessed.

import type Database from 'better-sqlite3'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'

export const PRICING_CONFIG_PATH = join(PROJECT_ROOT, 'store', 'costops-pricing.json')
export const PRICING_EXAMPLE_PATH = join(PROJECT_ROOT, 'store', 'costops-pricing.json.example')

// Per-million-token rates, in the config's `currency` (default HUF).
export interface ModelRate {
  input_per_mtok: number
  output_per_mtok: number
  cache_read_per_mtok: number
  cache_write_per_mtok: number
}

export interface PricingConfig {
  version: number
  currency: string
  models: Record<string, ModelRate>
}

export interface PricingLoadResult {
  pricing: PricingConfig
  exists: boolean
  errors: string[]
}

const EMPTY_PRICING: PricingConfig = { version: 1, currency: 'HUF', models: {} }

// Safe skeleton -- ALL rates 0 (placeholder, no real provider prices). Operator
// fills real per-MTok rates locally. Generated to the gitignored store/ dir.
const EXAMPLE_PRICING = {
  version: 1,
  currency: 'HUF',
  _doc: 'CostOps v0.2 token pricing (gitignored, local). Rates are per 1,000,000 tokens in `currency`. All 0 here = no cost estimate until you fill real rates. Keys are model ids as they appear in the transcript (message.model), e.g. claude-opus-4-8. No secrets/API keys here.',
  models: {
    'claude-opus-4-8': { input_per_mtok: 0, output_per_mtok: 0, cache_read_per_mtok: 0, cache_write_per_mtok: 0 },
    'claude-sonnet-4-6': { input_per_mtok: 0, output_per_mtok: 0, cache_read_per_mtok: 0, cache_write_per_mtok: 0 },
    'claude-haiku-4-5': { input_per_mtok: 0, output_per_mtok: 0, cache_read_per_mtok: 0, cache_write_per_mtok: 0 },
    'deepseek-v4-pro': { input_per_mtok: 0, output_per_mtok: 0, cache_read_per_mtok: 0, cache_write_per_mtok: 0 },
  },
}

/**
 * Derive a coarse provider from a model id string. Deterministic, no network.
 * Returns 'unknown' when it cannot be classified (never guessed downstream).
 */
export function deriveProvider(model: string | null | undefined): string {
  if (!model) return 'unknown'
  const m = model.toLowerCase()
  if (/(claude|anthropic|opus|sonnet|haiku|fable)/.test(m)) return 'anthropic'
  if (/(deepseek)/.test(m)) return 'deepseek'
  if (/(gpt|openai|o1|o3|o4|davinci|codex)/.test(m)) return 'openai'
  if (/(gemini|google|palm|bard)/.test(m)) return 'google'
  if (/(grok|xai)/.test(m)) return 'xai'
  if (/(mistral|mixtral)/.test(m)) return 'mistral'
  if (/(llama|meta)/.test(m)) return 'meta'
  return 'unknown'
}

export function loadPricingConfig(): PricingLoadResult {
  if (!existsSync(PRICING_CONFIG_PATH)) {
    ensurePricingExample()
    return { pricing: { ...EMPTY_PRICING }, exists: false, errors: [] }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(PRICING_CONFIG_PATH, 'utf-8'))
  } catch (err) {
    logger.warn({ err }, 'costops-pricing.json is not valid JSON')
    return { pricing: { ...EMPTY_PRICING }, exists: true, errors: ['pricing config is not valid JSON'] }
  }
  return validatePricing(raw)
}

export function ensurePricingExample(): void {
  try {
    if (!existsSync(PRICING_EXAMPLE_PATH)) {
      writeFileSync(PRICING_EXAMPLE_PATH, JSON.stringify(EXAMPLE_PRICING, null, 2) + '\n', 'utf-8')
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to write costops-pricing example')
  }
}

export function validatePricing(raw: unknown): PricingLoadResult {
  const errors: string[] = []
  const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const currency = typeof obj.currency === 'string' ? obj.currency : 'HUF'
  const models: Record<string, ModelRate> = {}
  const rawModels = (obj.models && typeof obj.models === 'object') ? obj.models as Record<string, unknown> : {}
  for (const [id, v] of Object.entries(rawModels)) {
    const r = v as Record<string, unknown>
    const num = (x: unknown) => (typeof x === 'number' && isFinite(x) && x >= 0) ? x : null
    const inp = num(r?.input_per_mtok), out = num(r?.output_per_mtok)
    const cr = num(r?.cache_read_per_mtok), cw = num(r?.cache_write_per_mtok)
    if (inp === null || out === null) { errors.push(`models['${id}']: input_per_mtok and output_per_mtok must be non-negative numbers`); continue }
    models[id] = {
      input_per_mtok: inp, output_per_mtok: out,
      cache_read_per_mtok: cr ?? 0, cache_write_per_mtok: cw ?? 0,
    }
  }
  return { pricing: { version: typeof obj.version === 'number' ? obj.version : 1, currency, models }, exists: true, errors }
}

// ---- deterministic token-cost estimate over token_usage for a month ---------

export interface TokenCostEstimate {
  currency: string
  total_estimated_huf: number
  confidence: 'estimate'
  pricing_profile_status: 'no_pricing_config' | 'loaded' | 'partial'
  priced_by_model: Array<{
    model: string
    provider: string
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
    estimated_huf: number
  }>
  unpriced: {
    unknown_model_tokens: number   // rows with NULL model
    no_rate_tokens: number         // model present but no pricing entry
    calls: number
  }
  note: string
}

interface ModelAgg {
  model: string | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  calls: number
}

/**
 * Compute a deterministic token-cost estimate for [start,end) from token_usage,
 * grouped by model, using the local pricing config. Pure SQL + arithmetic.
 * `pricingExists` distinguishes "no config at all" from "config with no match".
 */
export function getTokenCostEstimate(
  db: Database.Database,
  pricing: PricingConfig,
  pricingExists: boolean,
  start: number,
  end: number,
): TokenCostEstimate {
  const rows = db.prepare(`
    SELECT model,
      COALESCE(SUM(input_tokens),0) as input_tokens,
      COALESCE(SUM(output_tokens),0) as output_tokens,
      COALESCE(SUM(cache_read_tokens),0) as cache_read_tokens,
      COALESCE(SUM(cache_creation_tokens),0) as cache_creation_tokens,
      COUNT(*) as calls
    FROM token_usage
    WHERE timestamp >= @start AND timestamp < @end
    GROUP BY model
  `).all({ start, end }) as ModelAgg[]

  const priced_by_model: TokenCostEstimate['priced_by_model'] = []
  let total = 0
  let unknownTokens = 0, noRateTokens = 0, unpricedCalls = 0
  let anyPriced = false, anyUnpriced = false

  for (const r of rows) {
    const tokenSum = r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens
    const rate = r.model ? pricing.models[r.model] : undefined
    if (!r.model) {
      unknownTokens += tokenSum; unpricedCalls += r.calls; anyUnpriced = true; continue
    }
    if (!rate) {
      noRateTokens += tokenSum; unpricedCalls += r.calls; anyUnpriced = true; continue
    }
    const est = round2(
      (r.input_tokens / 1e6) * rate.input_per_mtok +
      (r.output_tokens / 1e6) * rate.output_per_mtok +
      (r.cache_read_tokens / 1e6) * rate.cache_read_per_mtok +
      (r.cache_creation_tokens / 1e6) * rate.cache_write_per_mtok,
    )
    total += est
    anyPriced = true
    priced_by_model.push({
      model: r.model, provider: deriveProvider(r.model),
      input_tokens: r.input_tokens, output_tokens: r.output_tokens,
      cache_read_tokens: r.cache_read_tokens, cache_creation_tokens: r.cache_creation_tokens,
      estimated_huf: est,
    })
  }
  priced_by_model.sort((a, b) => b.estimated_huf - a.estimated_huf)

  const pricing_profile_status: TokenCostEstimate['pricing_profile_status'] =
    !pricingExists || Object.keys(pricing.models).length === 0 ? 'no_pricing_config'
    : (anyUnpriced && anyPriced) ? 'partial'
    : 'loaded'

  return {
    currency: pricing.currency,
    total_estimated_huf: round2(total),
    confidence: 'estimate',
    pricing_profile_status,
    priced_by_model,
    unpriced: { unknown_model_tokens: unknownTokens, no_rate_tokens: noRateTokens, calls: unpricedCalls },
    note: 'ESTIMATE only, not an invoice. Separate from fixed/manual spend. Rows with unknown model or no pricing rate are left unpriced (volume only).',
  }
}

function round2(n: number): number { return Math.round(n * 100) / 100 }
