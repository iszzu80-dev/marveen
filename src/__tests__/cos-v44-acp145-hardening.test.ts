import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase, appendCaseEvent } from '../cos/case-store.js'
import { recordTemporalFact, listCaseTemporalFacts } from '../cos/temporal-facts.js'
import { evaluateTemporalConsistency, extractTemporalClaims } from '../cos/temporal-consistency-gate.js'
import { classifyActionability } from '../cos/actionability.js'
import { builtinConsumerManifest, standardFeatureResult, validateConsumerManifest } from '../cos/consumer-manifest.js'
import { makeEvidenceWatermark, evaluateEvidenceFreshness } from '../cos/evidence-freshness.js'
import { classifyScope } from '../cos/scope-gate.js'

const T0 = Math.floor(Date.UTC(2026, 7, 15, 8, 0, 0) / 1000)

describe('CoS v4.4 / ACP v1.4.5 hardening gates', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('Hertz/Sixt: pickup due_at cannot satisfy an earlier decision deadline', () => {
    const db = getDb()
    createCase(db, { caseId: 'hertz-sixt', title: 'Hertz vagy Sixt', caseType: 'TRAVEL' }, T0)
    recordTemporalFact(db, {
      factId: 'pickup', domain: 'personal', caseId: 'hertz-sixt', kind: 'BOOKING_START',
      occursAt: Math.floor(Date.UTC(2026, 7, 18, 10, 0, 0) / 1000),
      sourceSystem: 'booking', sourceReference: 'rental', verification: 'VERIFIED', confidence: 1,
    }, T0)

    const claims = extractTemporalClaims('DONTES 2026-08-16 10:00 elott: Hertz VAGY Sixt')
    expect(claims[0]?.kind).toBe('DECISION_DUE')
    const gate = evaluateTemporalConsistency({
      facts: listCaseTemporalFacts(db, 'personal', 'hertz-sixt'), now: T0,
      observedClaims: claims,
    })
    expect(gate.allowProgression).toBe(false)
    expect(gate.status).toBe('TEMPORAL_MISSING')
    expect(gate.missingKinds).toContain('DECISION_DUE')
  })

  it('rejects an open operational orphan', () => {
    const r = classifyActionability({ status: 'READY', nextAction: null, nextActionOwner: null })
    expect(r.classification).toBe('ORPHAN')
    expect(r.valid).toBe(false)
  })

  it('accepts a parent-only case only while an open child owns work', () => {
    expect(classifyActionability({ status: 'READY', hasOpenChildren: true }).classification).toBe('PARENT_ONLY')
    expect(classifyActionability({ status: 'READY', hasOpenChildren: false }).classification).toBe('ORPHAN')
  })

  it('private connector never auto-routes ZST-looking content into ZST', () => {
    const d = classifyScope({ text: 'ZST Radio Kft üzletrész ügyvezető változás', accountId: 'private', corporateAccounts: ['zst'] })
    expect(d.target).toBe('personal')
    expect(d.needsReview).toBe(true)
  })

  it('ZST connector remains in ZST even when content looks personal', () => {
    const d = classifyScope({ text: 'ház kert medence javítás', accountId: 'zst', corporateAccounts: ['zst'] })
    expect(d.target).toBe('zst')
    expect(d.needsReview).toBe(true)
  })

  it('owner reply/event after Reader watermark makes evidence stale', () => {
    const db = getDb()
    const c = createCase(db, { caseId: 'stale', title: 'stale', caseType: 'PERSONAL' }, T0)
    const wm = makeEvidenceWatermark(db, 'personal', c.case_id, T0 + 1)
    appendCaseEvent(db, {
      caseId: c.case_id, caseVersion: c.version, actor: 'owner', eventType: 'OWNER_INPUT',
      reason: 'yes', sourceSystem: 'telegram', sourceReference: 'msg-1',
    }, T0 + 38)
    const freshness = evaluateEvidenceFreshness(db, wm)
    expect(freshness.fresh).toBe(false)
    expect(freshness.currentMaxEventSeq).toBeGreaterThan(wm.evidenceMaxEventSeq)
  })

  it('CPP manifest has no built-without-consumer holes and standard zero semantics are explicit', () => {
    expect(validateConsumerManifest(builtinConsumerManifest())).toEqual([])
    expect(standardFeatureResult({ examined: 0, matched: 0, acted: 0, failed: 0, reason: 'empty' }).outcome).toBe('NO_DATA')
    expect(standardFeatureResult({ examined: 4, matched: 0, acted: 0, failed: 0, reason: 'none due' }).outcome).toBe('NO_MATCH')
    expect(standardFeatureResult({ examined: 4, matched: 2, acted: 0, failed: 0, reason: 'dedup' }).outcome).toBe('NO_ACTION')
  })
})
