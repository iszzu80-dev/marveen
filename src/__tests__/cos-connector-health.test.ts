import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  registerConnector, getHealth, setMode, recordSuccess, recordFailure, isUsable,
  DEGRADED_THRESHOLD, DOWN_THRESHOLD,
} from '../cos/connector-health.js'

// COS connector health matrix. Proves the degradation ladder and the fail-closed
// preCheck gate (DOWN/DISABLED/unregistered → not usable; a write needs
// READ_WRITE mode).

describe('COS connector health', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('registers idempotently and starts UNKNOWN', () => {
    const db = getDb()
    registerConnector(db, 'gmail', 'email', 'READ_ONLY', 1000)
    registerConnector(db, 'gmail', 'email', 'READ_WRITE', 1001) // second call must NOT overwrite mode
    const h = getHealth(db, 'gmail')!
    expect(h).toMatchObject({ kind: 'email', mode: 'READ_ONLY', status: 'UNKNOWN', consecutiveFailures: 0 })
  })

  it('success sets OK and resets the failure counter', () => {
    const db = getDb()
    registerConnector(db, 'cal', 'calendar', 'READ_WRITE', 1000)
    recordFailure(db, 'cal', 'boom', 1001)
    const h = recordSuccess(db, 'cal', 1002)
    expect(h.status).toBe('OK')
    expect(h.consecutiveFailures).toBe(0)
    expect(h.lastOkAt).toBe(1002)
  })

  it('degrades OK → DEGRADED → DOWN by threshold, then a success recovers', () => {
    const db = getDb()
    registerConnector(db, 'rental', 'shopping', 'READ_ONLY', 1000)
    for (let i = 1; i < DEGRADED_THRESHOLD; i++) expect(recordFailure(db, 'rental', 'e', 1000 + i).status).toBe('OK')
    expect(recordFailure(db, 'rental', 'e', 2000).status).toBe('DEGRADED') // at threshold
    for (let i = DEGRADED_THRESHOLD + 1; i < DOWN_THRESHOLD; i++) recordFailure(db, 'rental', 'e', 2000 + i)
    expect(recordFailure(db, 'rental', 'e', 3000).status).toBe('DOWN')     // at DOWN threshold
    expect(recordSuccess(db, 'rental', 4000).status).toBe('OK')            // recovers
  })

  it('isUsable: fail-closed on unregistered/DOWN/DISABLED; write needs READ_WRITE', () => {
    const db = getDb()
    expect(isUsable(db, 'nope')).toBe(false) // unregistered
    registerConnector(db, 'gmail', 'email', 'READ_ONLY', 1000)
    expect(isUsable(db, 'gmail')).toBe(true)                 // UNKNOWN is usable (not yet failed)
    expect(isUsable(db, 'gmail', true)).toBe(false)          // write to READ_ONLY → no
    setMode(db, 'gmail', 'READ_WRITE', 1001)
    expect(isUsable(db, 'gmail', true)).toBe(true)           // now a write is allowed
    setMode(db, 'gmail', 'DISABLED', 1002)
    expect(isUsable(db, 'gmail')).toBe(false)                // disabled → no
    // drive it DOWN and confirm not usable
    setMode(db, 'gmail', 'READ_WRITE', 1003)
    for (let i = 0; i < DOWN_THRESHOLD; i++) recordFailure(db, 'gmail', 'e', 1100 + i)
    expect(getHealth(db, 'gmail')!.status).toBe('DOWN')
    expect(isUsable(db, 'gmail')).toBe(false)
  })
})
