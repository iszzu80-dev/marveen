import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { buildSourceInventory } from '../costops/inventory.js'
import { buildCollectorPlan } from '../costops/collectors/scheduled-sync.js'
import type { CostOpsConfig } from '../costops/config.js'

// Card 15cfff51. Nine comments across five CostOps modules claimed the modules
// were "not mounted anywhere" -- all five are called by initCostOpsSchema. One
// of those stale claims had a user-facing consequence: inventory.ts said no
// collector runs on an automatic interval (true 2026-07-15, false since the
// scheduled sync landed), and the cadence was hard-coded to manual|config_driven.
// The dashboard therefore showed every automatically synced provider as MANUAL.

const NOW = 1_700_000_000
const CONFIG = { fixed_costs: [], sources: [] } as unknown as CostOpsConfig

function addSource(provider: string, name = provider) {
  getDb().prepare(
    `INSERT INTO cost_sources (name, provider, source_type, active, lifecycle_state, created_at, updated_at)
     VALUES (?, ?, 'api', 1, 'active', ?, ?)`).run(name, provider, NOW, NOW)
}

describe('sync cadence is derived from the collector plan, not asserted', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a provider ON the automatic schedule reports automatic_interval', () => {
    const scheduled = buildCollectorPlan()[0].provider
    addSource(scheduled)
    const inv = buildSourceInventory(getDb(), CONFIG, NOW, { credentialChecker: () => true })
    expect(inv.find(e => e.provider === scheduled)?.sync_cadence,
      'the dashboard must not call an automatically synced provider manual').toBe('automatic_interval')
  })

  it('a provider NOT on the schedule is never called automatic', () => {
    // The counter-check: this must not relabel everything as automatic. It
    // asserts only what this change owns -- which of manual/config_driven a
    // non-scheduled source lands on is the credential logic's business, and
    // pinning it here would make this test fail for someone else's reasons.
    addSource('nem-letezo-szolgaltato')
    const inv = buildSourceInventory(getDb(), CONFIG, NOW, { credentialChecker: () => false })
    expect(inv.find(e => e.provider === 'nem-letezo-szolgaltato')?.sync_cadence)
      .not.toBe('automatic_interval')
  })

  it('EVERY scheduled provider is reported as automatic — the set is the plan', () => {
    const providers = [...new Set(buildCollectorPlan().map(e => e.provider))]
    expect(providers.length).toBeGreaterThan(3)
    for (const p of providers) addSource(p)
    const inv = buildSourceInventory(getDb(), CONFIG, NOW, { credentialChecker: () => true })
    for (const p of providers) {
      expect(inv.find(e => e.provider === p)?.sync_cadence, p).toBe('automatic_interval')
    }
  })
})
