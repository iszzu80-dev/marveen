import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readRuntimeOverlay,
  writeRuntimeOverlay,
  clearRuntimeOverlay,
  resolveRuntimeModel,
  readCapacityRoutingConfig,
  normalizeCapacityRoutingConfig,
  isEnabledForRouting,
  type RuntimeOverlayEntry,
} from '../web/capacity-routing-store.js'

describe('capacity-routing-store', () => {
  let dir: string
  let overlayPath: string
  let configPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'capacity-routing-'))
    overlayPath = join(dir, 'runtime-model-overlay.json')
    configPath = join(dir, 'capacity-routing-config.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const entry: RuntimeOverlayEntry = {
    model: 'claude-sonnet-5',
    provider: 'anthropic',
    authProfile: 'plan:secondary',
    dispatchId: 'd-1',
    fallbacksUsedThisPackage: 1,
    setAtMs: 12345,
    reasonCode: 'primary_constrained_fallback_applied',
  }

  const trustedConfig = {
    enabled: true,
    candidates: [{ provider: 'anthropic', authProfile: 'plan:secondary', model: 'claude-sonnet-5', enabledForRouting: true, subscriptionIncluded: true }],
    limitedThreshold: 0.9,
    ttlMs: 1_800_000,
  }

  describe('overlay read/write/clear (real fs)', () => {
    it('round-trips one agent entry', () => {
      writeRuntimeOverlay('devops', entry, overlayPath)
      expect(readRuntimeOverlay('devops', overlayPath)).toEqual(entry)
    })

    it('is null for an agent with no overlay entry', () => {
      expect(readRuntimeOverlay('nobody', overlayPath)).toBeNull()
    })

    it('clearing removes exactly that agent, leaving siblings untouched', () => {
      writeRuntimeOverlay('devops', entry, overlayPath)
      writeRuntimeOverlay('qa', { ...entry, model: 'claude-opus-5' }, overlayPath)
      clearRuntimeOverlay('devops', overlayPath)
      expect(readRuntimeOverlay('devops', overlayPath)).toBeNull()
      expect(readRuntimeOverlay('qa', overlayPath)).not.toBeNull()
    })

    it('a missing overlay file behaves as "no agent has an overlay" rather than throwing', () => {
      expect(() => readRuntimeOverlay('devops', join(dir, 'does-not-exist.json'))).not.toThrow()
      expect(readRuntimeOverlay('devops', join(dir, 'does-not-exist.json'))).toBeNull()
    })

    it('a corrupt overlay file degrades to empty rather than throwing', () => {
      writeFileSync(overlayPath, '{ not json')
      expect(readRuntimeOverlay('devops', overlayPath)).toBeNull()
    })
  })

  describe('config normalization', () => {
    it('junk input degrades to safe defaults (disabled, no candidates)', () => {
      const cfg = normalizeCapacityRoutingConfig({ garbage: true })
      expect(cfg.enabled).toBe(false)
      expect(cfg.candidates).toEqual([])
    })

    it('drops a candidate missing enabledForRouting (fail-closed, never silently true)', () => {
      const cfg = normalizeCapacityRoutingConfig({
        candidates: [{ provider: 'deepseek', authProfile: 'x', model: 'deepseek-v4-pro' }],
      })
      expect(cfg.candidates[0].enabledForRouting).toBe(false)
    })

    it('caps candidates at the hard ceiling of 2, dropping the rest rather than truncating silently later', () => {
      const cfg = normalizeCapacityRoutingConfig({
        candidates: [
          { provider: 'a', authProfile: 'x', model: 'm1', enabledForRouting: true },
          { provider: 'b', authProfile: 'x', model: 'm2', enabledForRouting: true },
          { provider: 'c', authProfile: 'x', model: 'm3', enabledForRouting: true },
        ],
      })
      expect(cfg.candidates).toHaveLength(2)
    })

    it('a missing config file resolves to the safe default (enabled:false)', () => {
      const cfg = readCapacityRoutingConfig(join(dir, 'nope.json'))
      expect(cfg.enabled).toBe(false)
    })
  })

  describe('isEnabledForRouting', () => {
    it('is true only for a candidate explicitly enabled for that exact (provider, authProfile) pair', () => {
      expect(isEnabledForRouting('anthropic', 'plan:secondary', trustedConfig)).toBe(true)
      expect(isEnabledForRouting('anthropic', 'plan:other', trustedConfig)).toBe(false)
      expect(isEnabledForRouting('deepseek', 'plan:secondary', trustedConfig)).toBe(false)
    })
  })

  describe('resolveRuntimeModel -- the choke point', () => {
    it('falls through to configuredModel when there is no overlay at all (the safe default)', () => {
      const model = resolveRuntimeModel('devops', 'claude-opus-5', { overlayPath, configPath })
      expect(model).toBe('claude-opus-5')
    })

    it('returns the overlay model when an overlay exists AND its pair is enabled for routing', () => {
      writeFileSync(configPath, JSON.stringify(trustedConfig))
      writeRuntimeOverlay('devops', entry, overlayPath)
      const model = resolveRuntimeModel('devops', 'claude-opus-5', { overlayPath, configPath })
      expect(model).toBe('claude-sonnet-5')
    })

    it('DEFENSE IN DEPTH: falls through to configuredModel when the overlay pair is no longer enabled, even though the overlay entry still exists on disk', () => {
      writeFileSync(configPath, JSON.stringify({ ...trustedConfig, candidates: [] })) // trust revoked
      writeRuntimeOverlay('devops', entry, overlayPath)
      const model = resolveRuntimeModel('devops', 'claude-opus-5', { overlayPath, configPath })
      expect(model).toBe('claude-opus-5')
    })

    it('ROLLBACK PROOF: deleting the overlay file makes every subsequent call return exactly configuredModel', () => {
      writeFileSync(configPath, JSON.stringify(trustedConfig))
      writeRuntimeOverlay('devops', entry, overlayPath)
      expect(resolveRuntimeModel('devops', 'claude-opus-5', { overlayPath, configPath })).toBe('claude-sonnet-5')

      clearRuntimeOverlay('devops', overlayPath)
      expect(resolveRuntimeModel('devops', 'claude-opus-5', { overlayPath, configPath })).toBe('claude-opus-5')
      // The rollback claim in full: an absent overlay file entirely (not just
      // this one agent's key) behaves identically.
      rmSync(overlayPath, { force: true })
      expect(resolveRuntimeModel('devops', 'claude-opus-5', { overlayPath, configPath })).toBe('claude-opus-5')
    })

    it('THE CENTRAL GUARD (secondary/behavioral): a full fallback+revert cycle through the real interface never touches an unrelated config-shaped file', () => {
      // Complements, but does not replace, the PRIMARY mutation-proven guard:
      // capacity-routing-no-config-write.test.ts's source-level scan of
      // resolveRuntimeModel's function body. That test is what actually goes
      // RED when a write call is reintroduced (verified 2026-07-30 by
      // injecting a writeFileSync into the function and reverting). THIS test
      // only proves the two functions, called through their normal interface,
      // do not incidentally touch an unrelated file -- it cannot by itself
      // catch a write hardcoded to some path it does not know to check.
      const fakeAgentConfigPath = join(dir, 'agent-config.json')
      const before = JSON.stringify({ model: 'claude-opus-5' })
      writeFileSync(fakeAgentConfigPath, before)
      writeFileSync(configPath, JSON.stringify(trustedConfig))

      writeRuntimeOverlay('devops', entry, overlayPath)
      resolveRuntimeModel('devops', 'claude-opus-5', { overlayPath, configPath })
      clearRuntimeOverlay('devops', overlayPath)
      resolveRuntimeModel('devops', 'claude-opus-5', { overlayPath, configPath })

      expect(readFileSync(fakeAgentConfigPath, 'utf-8')).toBe(before)
    })
  })
})
