// O-2 and O-7 from the lean-optimization review (2026-08-11).
//
// Both are the same shape as O-1: a surface that reports a state it did not
// verify. O-2 — the summary read only the module flags, so a master-OFF system
// reported every module as live. O-7 — the emergency stop answered `ok: true`
// without looking at whether the write succeeded.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeOptimizationConfig, readOptimizationConfig } from '../optimization/optimization-config.js'

let dir: string
let cfg: string

const BASE = {
  masterEnabled: true,
  preset: 'active' as const,
  modules: {
    measurement: true, contextEfficiency: true, capacityMonitoring: true,
    runtimeRouting: true, recommendations: true, marketWatch: true,
    benchmarkRecommendations: true,
  },
  routing: {
    automaticFallback: true, trustedProvidersOnly: true,
    maxFallbacksPerProfile: 1, maxAutomaticFallbacksPerDispatch: 1,
  },
  ui: { defaultWindow: '30d' as const, showAllocationCost: true },
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'opt-cfg-'))
  cfg = join(dir, 'optimization-config.json')
})
afterEach(() => {
  try { chmodSync(dir, 0o755) } catch { /* already writable */ }
  rmSync(dir, { recursive: true, force: true })
})

describe('O-2: master switch gates the summary', () => {
  it('HEADLINE: the summary file consults masterEnabled on every module gate', () => {
    // Asserted on the source because building a full summary needs the live
    // store. The defect was an ABSENCE — the word never appeared in the file —
    // so absence is exactly what has to be pinned.
    const src = readFileSync(join(process.cwd(), 'src/optimization/optimization-summary.ts'), 'utf8')
    expect(src).toMatch(/config\.masterEnabled/)
    // Every module gate goes through the helper, so none can be added later
    // that silently ignores the master switch.
    expect(src).not.toMatch(/if \(config\.modules\.\w+\) \{/)
    expect((src.match(/on\(config\.modules\./g) ?? []).length).toBeGreaterThanOrEqual(5)
  })
})

describe('O-7: the emergency stop reports what happened', () => {
  it('HEADLINE: a failed write is surfaced, not answered green', () => {
    const src = readFileSync(join(process.cwd(), 'src/web/routes/optimization.ts'), 'utf8')
    // The handler must branch on the write result before answering.
    // Anchor on the handler's `if (path === ...)` line, not the first mention
    // of the route string anywhere in the file — the earlier match was a
    // different block, which is what made the first version of this assertion
    // compare offsets from the wrong slice.
    const at = src.indexOf("if (path === '/api/optimization/emergency-disable'")
    expect(at).toBeGreaterThan(-1)
    const handler = src.slice(at)
    expect(handler).toMatch(/if \(!result\.ok\)/)
    expect(handler.indexOf('if (!result.ok)')).toBeLessThan(handler.indexOf('json(res, { ok: true'))
  })

  it('writeOptimizationConfig reports ok:false when the write cannot land', () => {
    // The condition the handler now checks has to be reachable, or the branch
    // above is decoration. A config path inside a directory that does not
    // exist is the write-cannot-land case. (This used to chmod the dir to
    // 0o500, which silently proves nothing when the suite runs as root --
    // root writes through mode bits, and the test went red for the wrong
    // reason. A nonexistent parent fails for EVERY uid.)
    const result = writeOptimizationConfig(
      { ...BASE, masterEnabled: false },
      { path: join(dir, 'no-such-dir', 'optimization-config.json') },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('a successful write still reports ok:true with the new config', () => {
    // The counter-case: a check that always fails is not a check.
    writeOptimizationConfig(BASE, { path: cfg })
    const result = writeOptimizationConfig({ ...BASE, masterEnabled: false }, { path: cfg })
    expect(result.ok).toBe(true)
    expect(result.config.masterEnabled).toBe(false)
    expect(readOptimizationConfig(cfg).config.masterEnabled).toBe(false)
  })
})
