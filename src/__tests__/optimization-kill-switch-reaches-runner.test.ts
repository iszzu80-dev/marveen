// O-1 (lean-optimization review, 2026-08-11): the control panel must control.
//
// The Optimalizálás page offered a master switch, seven module toggles and an
// emergency stop. All three write `store/optimization-config.json`. The thing
// that actually routes — `startCapacityRoutingRunner` — gates on `enabled` in
// `store/capacity-routing-config.json`, which NOTHING in the codebase wrote.
//
// Measured on the live store that morning: `enabled: true`, unchanged since
// 2026-07-30, with the runner started in web.ts. So pressing the emergency stop
// would have reported success while the sweep kept running every ten minutes.
// A switch that reports success without acting is worse than no switch — it is
// the one you press in the minute you actually need it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setCapacityRoutingEnabled, readCapacityRoutingConfig } from '../web/capacity-routing-store.js'

let dir: string
let cfg: string

const ARMED = {
  enabled: true,
  candidates: [{ provider: 'deepseek', authProfile: 'configdir:.claude-deepseek', model: 'deepseek-v4-pro', enabledForRouting: true, subscriptionIncluded: false }],
  limitedThreshold: 0.9,
  ttlMs: 1_800_000,
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cap-routing-'))
  cfg = join(dir, 'capacity-routing-config.json')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('runtime routing kill switch', () => {
  it('HEADLINE: turning it off flips the flag the RUNNER reads', () => {
    writeFileSync(cfg, JSON.stringify(ARMED))
    expect(readCapacityRoutingConfig(cfg).enabled).toBe(true)

    expect(setCapacityRoutingEnabled(false, cfg)).toBe(true)
    expect(readCapacityRoutingConfig(cfg).enabled).toBe(false)
  })

  it('the candidates and their trust flags survive — one field changes', () => {
    // The routing candidates are an owner decision. A kill switch that also
    // wiped them would make re-arming a re-configuration.
    writeFileSync(cfg, JSON.stringify(ARMED))
    setCapacityRoutingEnabled(false, cfg)
    const after = readCapacityRoutingConfig(cfg)
    expect(after.candidates).toHaveLength(1)
    expect(after.candidates[0].enabledForRouting).toBe(true)
    expect(after.ttlMs).toBe(1_800_000)
    expect(after.limitedThreshold).toBe(0.9)
  })

  it('is idempotent — a second stop writes nothing', () => {
    writeFileSync(cfg, JSON.stringify(ARMED))
    expect(setCapacityRoutingEnabled(false, cfg)).toBe(true)
    expect(setCapacityRoutingEnabled(false, cfg)).toBe(false)
  })

  it('CANNOT arm routing when no config exists', () => {
    // Arming is an owner decision (Phase 3, 2026-07-30). A dashboard toggle may
    // stop routing; it must never start it by creating an enabled config.
    expect(existsSync(cfg)).toBe(false)
    expect(setCapacityRoutingEnabled(true, cfg)).toBe(false)
    expect(existsSync(cfg) ? readCapacityRoutingConfig(cfg).enabled : false).toBe(false)
  })

  it('re-enabling an EXISTING config is allowed (the stop is reversible)', () => {
    writeFileSync(cfg, JSON.stringify({ ...ARMED, enabled: false }))
    expect(setCapacityRoutingEnabled(true, cfg)).toBe(true)
    expect(readCapacityRoutingConfig(cfg).enabled).toBe(true)
  })

  it('STANDING CHECK: the optimization write path calls the setter', () => {
    // The property that was missing was not the setter — it was the CALL. A
    // switch nothing wires is the same switch as before.
    const src = readFileSync(join(process.cwd(), 'src/optimization/optimization-config.ts'), 'utf8')
    expect(src).toMatch(/setCapacityRoutingEnabled\(false\)/)
    expect(src).toMatch(/config\.modules\.runtimeRouting/)
  })

  it('STANDING CHECK: the runner still gates on the flag this setter writes', () => {
    // If the runner ever stops reading `enabled`, the kill switch silently
    // stops working again — and it would look exactly like it does today.
    const runner = readFileSync(join(process.cwd(), 'src/web/capacity-routing-runner.ts'), 'utf8')
    expect(runner).toMatch(/readCapacityRoutingConfig\(\)/)
    expect(runner).toMatch(/if \(!cfg\.enabled\) return/)
  })
})
