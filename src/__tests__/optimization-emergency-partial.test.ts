// Ó-2 (lean-optimization review #2, 2026-08-11): the emergency stop must not lie
// in the more dangerous direction.
//
// The stop has TWO halves — the optimization config and the capacity-routing
// flag the runner reads. The propagation used to sit inside the config write's
// own try block, AFTER the file had been written. So a failure to flip the flag
// (read-only store, full disk, permissions) returned `{ok: false, config: <the
// PRE-write config>}`.
//
// The operator then sees "the stop failed" and the OLD state, while in fact the
// master switch IS off and only the routing flag is still on. Half-landed,
// reported as not-landed — and the half still running is the half that
// dispatches. The O-7 fix ("report what happened, not what was attempted")
// stopped one step short of its own new code.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeOptimizationConfig } from '../optimization/optimization-config.js'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const setEnabled = vi.fn()

let dir: string
let path: string

const BASE = {
  masterEnabled: true,
  preset: 'active' as const,
  modules: {
    measurement: true, contextEfficiency: true, capacityMonitoring: true, runtimeRouting: true,
    recommendations: true, marketWatch: true, benchmarkRecommendations: true,
  },
  routing: { automaticFallback: true, trustedProvidersOnly: true, maxFallbacksPerProfile: 2, maxAutomaticFallbacksPerDispatch: 1 },
  ui: { defaultWindow: '30d' as const, showAllocationCost: true },
}

beforeEach(() => {
  setEnabled.mockReset()
  dir = mkdtempSync(join(tmpdir(), 'opt-cfg-'))
  path = join(dir, 'optimization-config.json')
  writeFileSync(path, JSON.stringify({ version: 1, ...BASE, lastEnabledConfiguration: null }, null, 2))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('emergency stop reports what LANDED', () => {
  it('HEADLINE: a failed propagation does NOT turn a successful write into a failure', () => {
    setEnabled.mockImplementation(() => { throw new Error('EROFS: read-only file system') })
    const res = writeOptimizationConfig(
      { ...BASE, masterEnabled: false, modules: { ...BASE.modules, runtimeRouting: false } },
      { path, propagate: setEnabled },
    )

    expect(res.ok).toBe(true)                       // the config WAS written
    expect(res.config.masterEnabled).toBe(false)    // and the result is the NEW state
    expect(res.routingFlagPropagated).toBe(false)   // the other half did not land
    expect(res.warning).toMatch(/capacity-routing/)
    expect(res.error).toBeNull()
  })

  it('a successful stop says BOTH halves landed', () => {
    // The counter-case: if `routingFlagPropagated` were false whenever the field
    // exists, the operator would learn to ignore it.
    setEnabled.mockImplementation(() => true)
    const res = writeOptimizationConfig(
      { ...BASE, masterEnabled: false, modules: { ...BASE.modules, runtimeRouting: false } },
      { path, propagate: setEnabled },
    )
    expect(res.ok).toBe(true)
    expect(res.routingFlagPropagated).toBe(true)
    expect(res.warning).toBeNull()
    expect(setEnabled).toHaveBeenCalledWith(false)
  })

  it('a write that does NOT stop routing propagates nothing', () => {
    // Only the OFF direction is propagated. Nothing to do, and the field says
    // "nothing to do" (null) rather than "it failed" (false).
    const res = writeOptimizationConfig({ ...BASE }, { path, propagate: setEnabled })
    expect(res.ok).toBe(true)
    expect(res.routingFlagPropagated).toBeNull()
    expect(setEnabled).not.toHaveBeenCalled()
  })
})
