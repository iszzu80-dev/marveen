// CostOps -- provider-neutral FX rate config (card 23912ca4).
//
// Before this file, the ONLY place fx_usd_huf/fx_eur_huf were ever configured
// was store/costops-render-pricing.json -- a Render-specific pricing file.
// That was never a Render fact (an fx rate has nothing to do with Render's
// plan prices); it just happened to be the first place a rate was needed.
// With the Render account deleted, that file reads as dead configuration a
// reasonable cleanup would remove -- and deleting it would silently convert
// every USD cost in CostOps to a fabricated 0 HUF, because every reader used
// `|| 0` as its fallback (see fx.ts's resolveFxRate for why that is wrong).
//
// This is the single, provider-neutral home for currency rates. It is the
// one file every USD/EUR conversion in CostOps should read from -- not a
// second parallel source that can drift from it.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from '../web/atomic-write.js'
import type { FxRateTable } from './fx.js'

export const COSTOPS_FX_CONFIG_PATH = join(PROJECT_ROOT, 'store', 'costops-fx.json')
// Legacy source, kept ONLY for the one-time migration below. Not imported from
// render.ts to avoid a module cycle -- this is deliberately a plain fs read of
// the same path render.ts uses.
const LEGACY_RENDER_PRICING_PATH = join(PROJECT_ROOT, 'store', 'costops-render-pricing.json')

interface FxRatesFile {
  version: number
  rates: Record<string, number>
}

function readJson(path: string): unknown {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    logger.warn({ err, path }, 'costops-fx: failed to read/parse config, treating as absent')
    return null
  }
}

// Only positive finite numbers are valid rates. Anything else (missing, 0,
// negative, NaN, non-number) is DROPPED, never coerced -- a dropped key reads
// as "unset" to resolveFxRate, which is the honest state; coercing it to 0
// would recreate exactly the bug this file exists to close.
function sanitizeRates(raw: unknown): FxRateTable {
  const out: FxRateTable = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && isFinite(v) && v > 0) out[k.toUpperCase()] = v
  }
  return out
}

/**
 * One-time, idempotent migration: if store/costops-fx.json does not exist yet
 * AND the legacy render-pricing file has a real (>0) fx_usd_huf/fx_eur_huf,
 * seed the new file from those values so the number already on file (e.g. the
 * 360 configured on 2026-07-05) is not lost, and Istvan does not need to
 * re-enter something that was already correctly configured.
 *
 * Best-effort: any failure here just means the migration did not happen this
 * call, which is safe -- loadFxRates() falls back to an empty (unset) table,
 * never to a fabricated one. Safe to call on every load (guarded by
 * existsSync), matching this codebase's existing store/*.json read pattern
 * (see loadRenderPricing) of no caching layer for these local config files.
 */
function migrateFromLegacyRenderPricingOnce(): void {
  if (existsSync(COSTOPS_FX_CONFIG_PATH)) return
  const legacy = readJson(LEGACY_RENDER_PRICING_PATH) as { fx_usd_huf?: unknown; fx_eur_huf?: unknown } | null
  if (!legacy) return
  const seeded = sanitizeRates({ USD: legacy.fx_usd_huf, EUR: legacy.fx_eur_huf })
  if (Object.keys(seeded).length === 0) return
  try {
    const file: FxRatesFile & { _doc: string } = {
      _doc:
        'CostOps provider-neutral FX rates (LOCAL, gitignored). HUF per 1 unit of the key ' +
        'currency. A missing/zero/absent currency is UNSET, never treated as a valid 0 rate -- ' +
        'converting an amount against an unset rate is refused, not fabricated. ' +
        `Auto-migrated from costops-render-pricing.json on ${new Date().toISOString().slice(0, 10)} ` +
        '(that file is no longer read for fx; it is Render plan-price data only).',
      version: 1,
      rates: seeded,
    }
    // COS-CORE-M7: atomic (tmp + rename) -- this is the single copy of the
    // fx table; a crash mid-write must not leave a truncated file that reads
    // back as "every rate unset".
    atomicWriteFileSync(COSTOPS_FX_CONFIG_PATH, JSON.stringify(file, null, 2))
    logger.info({ rates: Object.keys(seeded) }, 'costops-fx: migrated rate(s) from legacy render-pricing config')
  } catch (err) {
    logger.warn({ err }, 'costops-fx: migration write failed (continuing with unset rates)')
  }
}

/**
 * The single read path for every USD/EUR/... conversion in CostOps -- and as of
 * COS-OPS-M6 that is literal, not aspirational: the anthropic, github and
 * deepseek collectors read their USD rate here too, instead of the Render
 * plan-pricing file's fx_usd_huf (which is now seed-only, see below).
 *
 * Returns
 * an empty table (every currency unset) when nothing is configured -- never a
 * fabricated 0. Pair with fx.ts's resolveFxRate(), which already has the
 * correct "missing -> null, never 0" semantics this file exists to make the
 * ONLY rate source, instead of one of several that can silently drift apart.
 */
export function loadFxRates(): { rates: FxRateTable; source: 'costops_fx_config' | 'unset' } {
  migrateFromLegacyRenderPricingOnce()
  const raw = readJson(COSTOPS_FX_CONFIG_PATH) as FxRatesFile | null
  const rates = sanitizeRates(raw?.rates)
  return { rates, source: Object.keys(rates).length > 0 ? 'costops_fx_config' : 'unset' }
}
