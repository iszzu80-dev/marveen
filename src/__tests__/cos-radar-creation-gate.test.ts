import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createRadarItem, radarCreationRefusal, getRadarItem } from '../cos/radar.js'

/**
 * Acceptance criterion 6 of the 2026-08-15 card: no target price and no search
 * terms, no item — and the test asserts the REFUSAL, not the success.
 *
 * The refusal is not tidiness. `hit` requires `target_price != null`, so an item
 * created without one would be checked on schedule, would record observations
 * for ever, and could never alert: wired in, running, structurally mute. That is
 * the shape of every failure found on 2026-08-15, and the gate exists so it
 * cannot be created by accident.
 *
 * The gate sits in createRadarItem, the single choke point, rather than in the
 * callers — a gate on one caller is a gate the second caller does not have.
 */

const NOW = 1_000_000

describe('creation gate: an item that could never speak is refused', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('refuses a PRODUCT with no target price', () => {
    expect(() => createRadarItem(getDb(), {
      radarId: 'x1', kind: 'PRODUCT', label: 'On Cloud 6', query: { terms: 'on cloud 6' },
    }, NOW)).toThrow(/nincs celar/)
    // ...and nothing was written: a refusal must not leave a half-item behind.
    expect(getRadarItem(getDb(), 'x1')).toBeUndefined()
  })

  it('refuses a PRODUCT with no search terms', () => {
    expect(() => createRadarItem(getDb(), {
      radarId: 'x2', kind: 'PRODUCT', label: 'Teraszszigeteles es beazas', targetPrice: 35000,
    }, NOW)).toThrow(/keresokifejezes/)
    expect(getRadarItem(getDb(), 'x2')).toBeUndefined()
  })

  it('refuses a PRODUCT whose terms are only whitespace', () => {
    expect(() => createRadarItem(getDb(), {
      radarId: 'x3', kind: 'PRODUCT', label: 'x', targetPrice: 35000, query: { terms: '   ' },
    }, NOW)).toThrow(/keresokifejezes/)
  })

  it('refuses a RENTAL with no search descriptor', () => {
    // Without one runRentalRadarCheck throws on EVERY check, six hours apart,
    // for ever. The gate turns that into one refusal at the moment of the
    // mistake.
    expect(() => createRadarItem(getDb(), {
      radarId: 'x4', kind: 'RENTAL', label: 'VLC->AGP', targetPrice: 85000, query: {},
    }, NOW)).toThrow(/kereses-leiro/)
  })

  it('refuses a nonsense target price', () => {
    expect(() => createRadarItem(getDb(), {
      radarId: 'x5', kind: 'PRODUCT', label: 'x', targetPrice: 0, query: { terms: 'x' },
    }, NOW)).toThrow(/ervenytelen celar/)
  })

  // POSITIVE CONTROL: a gate that refuses everything would pass every test
  // above while making the radar impossible to use.
  it('accepts a complete PRODUCT and a complete RENTAL', () => {
    const p = createRadarItem(getDb(), {
      radarId: 'ok1', kind: 'PRODUCT', label: 'HOFF Banks', targetPrice: 35000,
      query: { terms: 'HOFF Banks cipo' },
    }, NOW)
    expect(p.status).toBe('ACTIVE')

    const r = createRadarItem(getDb(), {
      radarId: 'ok2', kind: 'RENTAL', label: 'VLC->AGP', targetPrice: 85000,
      query: { search: { pickup: 'VLC', dropoff: 'AGP' } },
    }, NOW)
    expect(r.status).toBe('ACTIVE')
  })

  // The rule is exported and pure, so an intake path can ask BEFORE trying —
  // and report the reason to Istvan instead of throwing at him.
  it('the reason is available without attempting the write', () => {
    expect(radarCreationRefusal({ radarId: 'q', kind: 'PRODUCT', label: 'x' })).toMatch(/nincs celar/)
    expect(radarCreationRefusal({
      radarId: 'q', kind: 'PRODUCT', label: 'x', targetPrice: 100, query: { terms: 'x' },
    })).toBeNull()
  })
})
