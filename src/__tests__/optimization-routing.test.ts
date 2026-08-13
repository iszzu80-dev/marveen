import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { listAgentNames } from '../web/agent-config.js'
import {
  listRuntimeOverlays,
  writeRuntimeOverlay,
  OVERLAY_PATH,
} from '../web/capacity-routing-store.js'
import {
  buildRoutingSnapshot,
  previewRuntimeRouting,
  ROUTING_PREVIEW_FORBIDDEN_CALLS,
} from '../optimization/optimization-routing.js'

const NOW = Math.floor(Date.UTC(2026, 6, 30, 12, 0, 0) / 1000)

function overlayBytes(): { exists: boolean; content: Buffer | null } {
  return {
    exists: existsSync(OVERLAY_PATH),
    content: existsSync(OVERLAY_PATH) ? readFileSync(OVERLAY_PATH) : null,
  }
}

describe('buildRoutingSnapshot', () => {
  let dir: string

  beforeEach(() => {
    initDatabase(':memory:')
    dir = mkdtempSync(join(tmpdir(), 'opt-routing-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns one correctly-shaped row per real configured agent', () => {
    const rows = buildRoutingSnapshot(getDb(), NOW)
    expect(rows).toHaveLength(listAgentNames().length)
    for (const row of rows) {
      expect(row).toEqual({
        agent: expect.any(String),
        configured_primary: expect.any(String),
        provider: expect.any(String),
        runtime_model: expect.any(String),
        capacity_state: expect.stringMatching(/^(available|degraded|limited|blocked|unknown)$/),
        routing_state: expect.stringMatching(/^(primary|fallback|static_mode|unknown)$/),
        fallback_reason: row.fallback_reason,
        last_decision_at: row.last_decision_at,
      })
      expect(row.fallback_reason === null || typeof row.fallback_reason === 'string').toBe(true)
      expect(row.last_decision_at === null || typeof row.last_decision_at === 'number').toBe(true)
    }
  })

  it('reports agents without overlay entries as primary', () => {
    const overlays = listRuntimeOverlays()
    const rows = buildRoutingSnapshot(getDb(), NOW)
    const withoutOverlay = rows.filter(row => !(row.agent in overlays))
    expect(withoutOverlay.length).toBeGreaterThan(0)
    expect(withoutOverlay.every(row => row.routing_state === 'primary')).toBe(true)
  })

  it('reports every row as static_mode when runtime routing is administratively disabled', () => {
    // A deterministic EMPTY overlay store: with no surviving overlay, static
    // mode reports every agent on its configured primary.
    const overlayPath = join(dir, 'runtime-model-overlay.json')
    const rows = buildRoutingSnapshot(getDb(), NOW, { runtimeRoutingEnabled: false, overlayPath })
    expect(rows).toHaveLength(listAgentNames().length)
    expect(rows.every(row => row.routing_state === 'static_mode')).toBe(true)
    expect(rows.every(row => row.runtime_model === row.configured_primary)).toBe(true)
    expect(rows.every(row => row.fallback_reason === null)).toBe(true)
  })

  it('OPT-C1: static_mode with a SURVIVING overlay reports the overlay model, not configured_primary', () => {
    // The previous version of the test above pinned the misreport this test
    // now forbids: routing switched off while an agent still sat on its
    // fallback overlay was shown as running its configured primary -- the
    // routing view lying about the exact state the emergency stop creates
    // when the overlay wipe fails. Reality wins: the overlay model, plus a
    // fallback_reason making clear routing is off but the agent has not
    // climbed back.
    const overlayPath = join(dir, 'runtime-model-overlay.json')
    const agent = listAgentNames()[0]
    expect(agent).toBeTruthy()
    writeRuntimeOverlay(agent, {
      model: 'stuck-fallback-model',
      provider: 'deepseek',
      authProfile: 'configdir:.claude-deepseek',
      dispatchId: 'd-42',
      fallbacksUsedThisPackage: 1,
      setAtMs: (NOW - 60) * 1000,
      reasonCode: 'primary_constrained_fallback_applied',
    }, overlayPath)

    const rows = buildRoutingSnapshot(getDb(), NOW, { runtimeRoutingEnabled: false, overlayPath })
    const row = rows.find(r => r.agent === agent)
    expect(row).toBeDefined()
    expect(row!.routing_state).toBe('static_mode')
    expect(row!.runtime_model).toBe('stuck-fallback-model')
    expect(row!.runtime_model).not.toBe(row!.configured_primary)
    expect(row!.fallback_reason).toBe('routing_disabled_overlay_active:primary_constrained_fallback_applied')
    expect(row!.last_decision_at).toBe(NOW - 60)

    // Agents WITHOUT an overlay are unaffected: still honest primaries.
    const others = rows.filter(r => r.agent !== agent)
    expect(others.every(r => r.runtime_model === r.configured_primary)).toBe(true)
    expect(others.every(r => r.fallback_reason === null)).toBe(true)
  })
})

describe('previewRuntimeRouting', () => {
  beforeEach(() => {
    initDatabase(':memory:')
  })

  it('never modifies the runtime overlay file across repeated previews', () => {
    const agents = listAgentNames()
    expect(agents.length).toBeGreaterThan(0)
    const before = overlayBytes()

    for (let index = 0; index < 3; index += 1) {
      const result = previewRuntimeRouting(getDb(), { agent: agents[index % agents.length] }, NOW)
      expect(result.agent).toBe(agents[index % agents.length])
      expect(typeof result.note).toBe('string')
      expect(result.would_change).toBe(result.decision.action === 'fallback')
    }

    const after = overlayBytes()
    expect(after.exists).toBe(before.exists)
    expect(after.content).toEqual(before.content)
  })

  it('contains none of the forbidden mutation call names in the source', () => {
    const source = readFileSync(
      join(__dirname, '../optimization/optimization-routing.ts'),
      'utf-8',
    )
    for (const forbidden of ROUTING_PREVIEW_FORBIDDEN_CALLS) {
      expect(source.includes(forbidden)).toBe(false)
    }
  })
})
