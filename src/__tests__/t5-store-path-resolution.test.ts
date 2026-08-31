import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storeDir, storePath } from '../config.js'
import { costopsConfigPath } from '../costops/config.js'

// T5: the ISOLATION MECHANISM itself, defended.
//
// The mutation run on 2026-08-31 caught a gap this file closes. Replacing
// storeDir()'s per-call read with a module-load capture left the whole suite
// GREEN, because the suite only ever sets MARVEEN_STORE_DIR once, in setupFiles,
// before any module loads -- so a captured constant happens to hold the right
// value. Nothing would have gone red if someone put the constant back, and the
// next person needing a per-test store would have hit exactly the defect that
// made store/vault.json a shared fixture and failed run 10 of that morning's
// sweep.
//
// So the property is asserted directly: the path FOLLOWS the override, at any
// moment, not just at import.

describe('T5 -- the store path resolves per call, not at module load', () => {
  it('storeDir() follows an override set AFTER the module was imported', () => {
    const before = storeDir()
    const moved = mkdtempSync(join(tmpdir(), 't5-moved-'))
    const saved = process.env.MARVEEN_STORE_DIR
    try {
      process.env.MARVEEN_STORE_DIR = moved
      expect(storeDir()).toBe(moved)
      expect(storeDir()).not.toBe(before)
      expect(storePath('config-overrides.json')).toBe(join(moved, 'config-overrides.json'))
    } finally {
      if (saved === undefined) delete process.env.MARVEEN_STORE_DIR
      else process.env.MARVEEN_STORE_DIR = saved
      rmSync(moved, { recursive: true, force: true })
    }
    expect(storeDir()).toBe(before)
  })

  it('a CONSUMER follows it too -- the constants are functions, not captured strings', () => {
    // storeDir() being per-call buys nothing if a consumer resolved its own path
    // once at import. costopsConfigPath() stands in for the eleven converted
    // constants: if any of them goes back to `const X = join(...)`, that one
    // stops following, and this is the shape of assertion that catches it.
    const moved = mkdtempSync(join(tmpdir(), 't5-consumer-'))
    const saved = process.env.MARVEEN_STORE_DIR
    const savedCostops = process.env.COSTOPS_CONFIG_PATH
    try {
      delete process.env.COSTOPS_CONFIG_PATH      // let it fall back to the store
      process.env.MARVEEN_STORE_DIR = moved
      expect(costopsConfigPath()).toBe(join(moved, 'costops-config.json'))
    } finally {
      if (saved === undefined) delete process.env.MARVEEN_STORE_DIR
      else process.env.MARVEEN_STORE_DIR = saved
      if (savedCostops !== undefined) process.env.COSTOPS_CONFIG_PATH = savedCostops
      rmSync(moved, { recursive: true, force: true })
    }
  })

  it('CONTROL: with no override it falls back to the checkout store, so the test is not vacuous', () => {
    const saved = process.env.MARVEEN_STORE_DIR
    try {
      delete process.env.MARVEEN_STORE_DIR
      expect(storeDir()).toMatch(/[/\\]store$/)
      expect(storeDir()).not.toMatch(/^\/tmp\/marveen-store-/)
    } finally {
      if (saved !== undefined) process.env.MARVEEN_STORE_DIR = saved
    }
  })

  it('the suite is running under an isolated store right now', () => {
    // If the setup file ever stops loading, everything above still passes and
    // the suite quietly goes back to writing the checkout. This is the line that
    // notices.
    expect(process.env.MARVEEN_STORE_DIR).toBeTruthy()
    expect(storeDir()).toBe(process.env.MARVEEN_STORE_DIR)
    writeFileSync(storePath('t5-isolation-witness.json'), '{}')
    expect(existsSync(join(process.env.MARVEEN_STORE_DIR!, 't5-isolation-witness.json'))).toBe(true)
  })
})
