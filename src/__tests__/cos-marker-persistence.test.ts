import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { registerConnector, setMode, getHealth, recordMarkerProof } from '../cos/connector-health.js'
import { GmailSendAdapter, DryRunTransport } from '../cos/adapters/gmail-send.js'
import { verifyMarkerPersistence, markerPersistenceGate, probeAction } from '../cos/marker-persistence.js'
import type { OutboundAdapter } from '../cos/executor.js'

// AC-26: the Gmail adapter must PROVE its idempotency marker round-trips (send →
// read back from Sent by the marker) before it is granted EXECUTE. If it cannot,
// it stays PREPARE. This is the gate that keeps a blind-readback adapter from
// ever being allowed to send autonomously.

const SAMPLE = probeAction('mv-probe-1', { to: 'self@example.com', subject: 'marker probe', body: 'x' })

describe('marker persistence gate (AC-26)', () => {
  it('GmailSendAdapter over a working transport: marker round-trips → EXECUTE', async () => {
    const adapter = new GmailSendAdapter(new DryRunTransport())
    const report = await verifyMarkerPersistence(adapter, SAMPLE)
    expect(report.passed).toBe(true)
    expect(report.sent).toBe(true)
    expect(report.readbackFound).toBe(true)
    expect(report.refMatches).toBe(true) // the read-back message id == the sent id
    expect(markerPersistenceGate(report)).toBe('EXECUTE')
  })

  it('a transport whose Sent search is unreachable → not available → PREPARE', async () => {
    const t = new DryRunTransport()
    t.readbackUnavailable = true
    const report = await verifyMarkerPersistence(new GmailSendAdapter(t), SAMPLE)
    expect(report.passed).toBe(false)
    expect(report.readbackAvailable).toBe(false)
    expect(markerPersistenceGate(report)).toBe('PREPARE')
  })

  it('an adapter whose marker cannot be found on readback → PREPARE (blind readback rejected)', async () => {
    // send "succeeds" but readback never finds the marker → unproven → not EXECUTE
    const blind: OutboundAdapter = {
      actionType: 'EMAIL_SEND',
      async send() { return { externalRef: 'id-1' } },
      async readback() { return { found: false } },
    }
    const report = await verifyMarkerPersistence(blind, SAMPLE)
    expect(report.passed).toBe(false)
    expect(report.readbackFound).toBe(false)
    expect(markerPersistenceGate(report)).toBe('PREPARE')
  })

  it('an adapter whose send throws → PREPARE', async () => {
    const broken: OutboundAdapter = {
      actionType: 'EMAIL_SEND',
      async send() { throw new Error('no transport') },
      async readback() { return { found: false } },
    }
    const report = await verifyMarkerPersistence(broken, SAMPLE)
    expect(report.passed).toBe(false)
    expect(report.sent).toBe(false)
    expect(markerPersistenceGate(report)).toBe('PREPARE')
  })
})

// F-10 (review 2026-08-10). B.3 says: "if the marker cannot be proven, the Gmail
// EXECUTE mode may NOT be activated." That was a sentence in the spec and a
// manual habit — markerPersistenceGate and verifyMarkerPersistence existed with
// no production caller, so the rule lived in whoever remembered it. It is now a
// precondition of raising a connector to a write mode.
describe('the marker proof gates the write mode (F-10 / B.3)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a connector with no proof cannot be put into READ_WRITE', () => {
    const db = getDb()
    registerConnector(db, 'gmail', 'gmail', 'READ_ONLY', 1000)
    expect(() => setMode(db, 'gmail', 'READ_WRITE', 1001)).toThrow(/no marker-persistence proof/)
    expect(getHealth(db, 'gmail')!.mode).toBe('READ_ONLY')
  })

  it('a FAILED proof does not count as a proof', () => {
    const db = getDb()
    registerConnector(db, 'gmail', 'gmail', 'READ_ONLY', 1000)
    recordMarkerProof(db, 'gmail', { passed: false, detail: 'readback found nothing' }, 1001)
    expect(() => setMode(db, 'gmail', 'READ_WRITE', 1002)).toThrow(/no marker-persistence proof/)
  })

  it('with a passing proof the mode can be raised', () => {
    const db = getDb()
    registerConnector(db, 'gmail', 'gmail', 'READ_ONLY', 1000)
    recordMarkerProof(db, 'gmail', { passed: true, detail: 'marker round-trips' }, 1001)
    setMode(db, 'gmail', 'READ_WRITE', 1002)
    expect(getHealth(db, 'gmail')!.mode).toBe('READ_WRITE')
  })

  it('the proof is NOT required to lower a connector — DISABLED must always be reachable', () => {
    // A rule that made it harder to fence off a misbehaving connector would be
    // worse than no rule.
    const db = getDb()
    registerConnector(db, 'gmail', 'gmail', 'READ_ONLY', 1000)
    setMode(db, 'gmail', 'DISABLED', 1001)
    expect(getHealth(db, 'gmail')!.mode).toBe('DISABLED')
  })

  it('F-10: the provider-id comparison is part of the verdict, not just the prose', async () => {
    // B.3's third condition. refMatches used to be computed, printed into the
    // detail string as "id not compared", and left out of `passed`.
    const sent = { externalIdempotencyMarker: 'mk-1' } as never
    const adapter = {
      actionType: 'EMAIL_SEND',
      send: async () => ({ externalRef: 'id-A' }),
      readback: async () => ({ found: true, available: true, externalRef: 'id-B' }), // different id
    }
    const report = await verifyMarkerPersistence(adapter as never, sent)
    expect(report.readbackFound).toBe(true)
    expect(report.refMatches).toBe(false)
    expect(report.passed).toBe(false) // was true before F-10
    expect(markerPersistenceGate(report)).toBe('PREPARE')
  })
})
