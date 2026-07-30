import { beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { listAgentNames } from '../web/agent-config.js'
import {
  listRuntimeOverlays,
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
  beforeEach(() => {
    initDatabase(':memory:')
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
    const rows = buildRoutingSnapshot(getDb(), NOW, { runtimeRoutingEnabled: false })
    expect(rows).toHaveLength(listAgentNames().length)
    expect(rows.every(row => row.routing_state === 'static_mode')).toBe(true)
    expect(rows.every(row => row.runtime_model === row.configured_primary)).toBe(true)
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
