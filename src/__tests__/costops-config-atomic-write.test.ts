// COS-CORE-M7: store/costops-config.json is the SINGLE copy of every
// fixed-cost/budget definition, and saveCostopsConfig used a plain
// writeFileSync -- a crash mid-write truncates the file, after which
// loadCostopsConfig silently degrades to the EMPTY config (every budget and
// fixed cost gone). It now goes through atomicWriteFileSync (tmp + rename,
// the same helper capacity-routing-store et al. use). Same real-fs pattern
// as costops-fx-config.test.ts: this worktree's own isolated store/, cleaned
// up around every test.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { saveCostopsConfig, loadCostopsConfig, COSTOPS_CONFIG_PATH, type CostOpsConfig } from '../costops/config.js'

const STORE = dirname(COSTOPS_CONFIG_PATH())

function cleanup(): void {
  rmSync(COSTOPS_CONFIG_PATH(), { force: true })
  rmSync(join(STORE, 'costops-config.json.example'), { force: true })
}

beforeEach(() => {
  mkdirSync(STORE, { recursive: true })
  cleanup()
})
afterEach(cleanup)

function cfg(): CostOpsConfig {
  return {
    version: 1,
    currency: 'HUF',
    fixed_costs: [
      { source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 22000, period: 'monthly', confidence: 'manual', currency: 'HUF' },
    ],
    budgets: [
      { id: 'global-monthly', name: 'Global monthly', scope: 'global', amount: 100000, warning_threshold: 0.8, hard_threshold: 1.0 },
    ],
  }
}

describe('saveCostopsConfig atomic write (COS-CORE-M7)', () => {
  it('round-trips through the real loader', () => {
    saveCostopsConfig(cfg())
    const loaded = loadCostopsConfig()
    expect(loaded.exists).toBe(true)
    expect(loaded.errors).toEqual([])
    expect(loaded.config.fixed_costs).toHaveLength(1)
    expect(loaded.config.fixed_costs[0].amount).toBe(22000)
    expect(loaded.config.budgets[0].amount).toBe(100000)
  })

  it('leaves no orphan tmp file behind (the write is tmp + rename, fully consumed)', () => {
    saveCostopsConfig(cfg())
    const leftovers = readdirSync(STORE).filter(f => f.startsWith(basename(COSTOPS_CONFIG_PATH())) && f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('replaces an existing config in one rename -- the target is never observably truncated', () => {
    // Pre-existing config with a DIFFERENT amount; after the save, the file
    // must contain exactly the new content (valid JSON, never a partial mix).
    writeFileSync(COSTOPS_CONFIG_PATH(), JSON.stringify({ version: 1, currency: 'HUF', fixed_costs: [], budgets: [] }))
    saveCostopsConfig(cfg())
    const onDisk = JSON.parse(readFileSync(COSTOPS_CONFIG_PATH(), 'utf-8'))
    expect(onDisk.fixed_costs).toHaveLength(1)
    expect(onDisk.fixed_costs[0].source_id).toBe('anthropic-max')
  })
})
