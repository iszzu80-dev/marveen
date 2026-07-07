// CostOps v0.7 -- subscription lifecycle.
//
// Per-subscription active/canceled/paid_until/next_renewal facts, loaded from
// store/costops-subscriptions.json (gitignored, same convention as
// costops-config.json -- real dates/amounts never enter a tracked file). This
// module is pure I/O + derived-field computation. No Gmail access, no secrets,
// no raw email/PII -- the facts here are already-extracted structured data.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'

export const SUBSCRIPTIONS_PATH = join(PROJECT_ROOT, 'store', 'costops-subscriptions.json')
export const SUBSCRIPTIONS_EXAMPLE_PATH = join(PROJECT_ROOT, 'store', 'costops-subscriptions.json.example')

export type SubscriptionStatus = 'active' | 'canceled' | 'expired' | 'unknown'
export type AmountSource = 'invoice' | 'manual_fallback' | 'no_invoice_found' | 'pending_permission'

export interface SubscriptionEntry {
  id: string
  name: string
  provider: string
  source: string             // where the lifecycle fact came from, e.g. 'google_play' | 'anthropic' | 'openai'
  status: SubscriptionStatus
  paid_until?: string        // 'YYYY-MM-DD', renews-then-ends date if canceled
  next_renewal?: string      // 'YYYY-MM-DD', next charge/renewal date if active
  amount?: number            // per-period amount, omitted entirely if unknown (never 0-fabricated)
  currency?: string
  amount_source: AmountSource
  notes?: string
}

export interface SubscriptionsConfig {
  version: number
  subscriptions: SubscriptionEntry[]
}

const EMPTY: SubscriptionsConfig = { version: 1, subscriptions: [] }

const EXAMPLE_CONFIG = {
  version: 1,
  _doc: 'CostOps v0.7 subscription lifecycle facts. Copy to store/costops-subscriptions.json. paid_until/next_renewal are ISO dates (YYYY-MM-DD). amount is omitted (not 0) when genuinely unknown -- set amount_source accordingly.',
  subscriptions: [
    { id: 'claude-pro-google-play', name: 'Claude Pro', provider: 'anthropic', source: 'google_play', status: 'canceled', paid_until: '2026-07-16', amount_source: 'invoice', notes: 'cancellation notice received; active until paid_until, then ends' },
    { id: 'anthropic-max', name: 'Anthropic Max', provider: 'anthropic', source: 'anthropic', status: 'active', next_renewal: '2026-07-20', amount_source: 'manual_fallback', notes: 'no invoice amount available yet' },
    { id: 'openai-chatgpt', name: 'ChatGPT Plus', provider: 'openai', source: 'openai', status: 'active', amount_source: 'no_invoice_found' },
  ],
}

export interface SubscriptionsLoadResult {
  config: SubscriptionsConfig
  exists: boolean
  errors: string[]
}

export function loadSubscriptionsConfig(): SubscriptionsLoadResult {
  if (!existsSync(SUBSCRIPTIONS_PATH)) {
    ensureExampleSubscriptions()
    return { config: { ...EMPTY }, exists: false, errors: [] }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(SUBSCRIPTIONS_PATH, 'utf-8'))
  } catch (err) {
    logger.warn({ err }, 'costops-subscriptions.json is not valid JSON')
    return { config: { ...EMPTY }, exists: true, errors: ['config is not valid JSON'] }
  }
  return validateSubscriptionsConfig(raw)
}

export function ensureExampleSubscriptions(): void {
  try {
    if (!existsSync(SUBSCRIPTIONS_EXAMPLE_PATH)) {
      writeFileSync(SUBSCRIPTIONS_EXAMPLE_PATH, JSON.stringify(EXAMPLE_CONFIG, null, 2) + '\n', 'utf-8')
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to write costops-subscriptions example')
  }
}

const VALID_STATUS = new Set(['active', 'canceled', 'expired', 'unknown'])
const VALID_AMOUNT_SOURCE = new Set(['invoice', 'manual_fallback', 'no_invoice_found', 'pending_permission'])
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function validateSubscriptionsConfig(raw: unknown): SubscriptionsLoadResult {
  const errors: string[] = []
  const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const rawSubs = Array.isArray(obj.subscriptions) ? obj.subscriptions : []
  const subscriptions: SubscriptionEntry[] = []
  for (const [i, e] of rawSubs.entries()) {
    const s = e as Record<string, unknown>
    if (typeof s?.id !== 'string' || !s.id) { errors.push(`subscriptions[${i}]: missing id`); continue }
    if (typeof s?.name !== 'string' || !s.name) { errors.push(`subscriptions[${i}] (${s.id}): missing name`); continue }
    const status = VALID_STATUS.has(s.status as string) ? s.status as SubscriptionStatus : 'unknown'
    const amount_source = VALID_AMOUNT_SOURCE.has(s.amount_source as string) ? s.amount_source as AmountSource : 'no_invoice_found'
    if (s.paid_until !== undefined && !ISO_DATE.test(s.paid_until as string)) { errors.push(`subscriptions[${i}] (${s.id}): paid_until must be YYYY-MM-DD`); continue }
    if (s.next_renewal !== undefined && !ISO_DATE.test(s.next_renewal as string)) { errors.push(`subscriptions[${i}] (${s.id}): next_renewal must be YYYY-MM-DD`); continue }
    if (s.amount !== undefined && (typeof s.amount !== 'number' || !isFinite(s.amount as number) || (s.amount as number) < 0)) {
      errors.push(`subscriptions[${i}] (${s.id}): amount must be a non-negative number when present`); continue
    }
    subscriptions.push({
      id: s.id, name: s.name,
      provider: typeof s.provider === 'string' ? s.provider : 'other',
      source: typeof s.source === 'string' ? s.source : 'unknown',
      status,
      paid_until: typeof s.paid_until === 'string' ? s.paid_until : undefined,
      next_renewal: typeof s.next_renewal === 'string' ? s.next_renewal : undefined,
      amount: typeof s.amount === 'number' ? s.amount : undefined,
      currency: typeof s.currency === 'string' ? s.currency : undefined,
      amount_source,
      notes: typeof s.notes === 'string' ? s.notes : undefined,
    })
  }
  return { config: { version: typeof obj.version === 'number' ? obj.version : 1, subscriptions }, exists: true, errors }
}

export interface SubscriptionLifecycle extends SubscriptionEntry {
  days_until_next_date: number | null  // to paid_until (if canceled) or next_renewal (if active); null if neither present
  past_due: boolean                    // next_renewal/paid_until date has passed with no corresponding invoice update
}

/**
 * Derive lifecycle display fields (days remaining, past-due flag) from the
 * static config facts + `now`. Pure function -- no I/O, no DB.
 */
export function deriveLifecycle(config: SubscriptionsConfig, now: number): SubscriptionLifecycle[] {
  const nowDay = Math.floor(now / 86400)
  return config.subscriptions.map(s => {
    const targetDate = s.status === 'canceled' ? s.paid_until : s.next_renewal
    let days_until_next_date: number | null = null
    let past_due = false
    if (targetDate && ISO_DATE.test(targetDate)) {
      const targetDay = Math.floor(Date.parse(`${targetDate}T00:00:00Z`) / 1000 / 86400)
      days_until_next_date = targetDay - nowDay
      past_due = s.status === 'active' && days_until_next_date < 0
    }
    return { ...s, days_until_next_date, past_due }
  })
}
