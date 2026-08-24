// W10 coverage — the policy boundary on the COS send path, on the REAL gate.
//
// These drive `evaluateDispatch` itself, not a copy of its logic, because the
// claim being made is "this production choke point now consults the boundary".
// A test against a re-implementation would prove the re-implementation.
//
// The asymmetry under test is the migration rule Istvan approved on 2026-08-24:
// a caller that supplies an identity is BOUND by the verdict; a caller that does
// not gets an ADVISORY verdict that is counted -- except for a credential, which
// vetoes either way, because "we do not know who you are" is not a reason to let
// a secret leave.
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { evaluateDispatch } from '../cos/dispatch-gate.js'
import { initCosSchema } from '../cos/schema.js'
import { readPolicyMetrics } from '../identity/policy-metrics.js'
import type { ExecutionIdentity } from '../identity/execution-identity.js'

const NOW = 1_787_600_000

function identity(over: Partial<ExecutionIdentity> = {}): ExecutionIdentity {
  return {
    actorId: 'marveen', actorType: 'AGENT', onBehalfOf: 'istvan', runId: 'run-w10',
    capabilityScope: ['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT'],
    ...over,
  }
}

/** The minimum a send request needs. Everything else about the gate (connector
 *  health, campaign approval, autonomy rung) will veto in these fixtures too --
 *  which is fine and is the point: we assert on the POLICY reason specifically,
 *  never on `allowed` alone. */
function req(over: Record<string, unknown> = {}) {
  return {
    connectorId: 'gmail-personal',
    recipient: 'someone@example.com',
    declaredSensitivity: 'PERSONAL',
    content: 'Kedves Robert, koszonom a valaszt.',
    targetProfile: 'premium_reasoning',
    campaignId: 'c1',
    templateHash: 'th',
    renderedPayloadHash: 'rh',
    now: NOW,
    ...over,
  } as Parameters<typeof evaluateDispatch>[1]
}

const policyReasons = (d: { reasons: string[] }) => d.reasons.filter(r => r.startsWith('policy boundary'))

describe('W10 coverage: the COS send gate consults the policy boundary', () => {
  let db: Database.Database
  beforeEach(() => { db = new Database(':memory:'); initCosSchema(db) })

  it('a credential in the payload is vetoed even with NO caller identity', () => {
    // The exception to the migration rule, and the reason it exists.
    const d = evaluateDispatch(db, req({
      content: 'itt a token: Bearer abcdefghijklmnopqrstuvwxyz012345',
    }))
    expect(d.allowed).toBe(false)
    const p = policyReasons(d)
    expect(p.length, 'the credential must veto, not merely advise').toBeGreaterThan(0)
    expect(p.join(' ')).toContain('never-external tag')
  })

  it('the same credential payload WITH an identity is still vetoed', () => {
    const d = evaluateDispatch(db, req({
      content: 'itt a token: Bearer abcdefghijklmnopqrstuvwxyz012345',
      identity: identity({ capabilityScope: ['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT'] }),
    }))
    expect(policyReasons(d).join(' ')).toContain('never-external tag')
  })

  it('an identity WITHOUT EXTERNAL_EFFECT is BINDING and vetoes the send', () => {
    const d = evaluateDispatch(db, req({
      identity: identity({ capabilityScope: ['READ'] }),
    }))
    const p = policyReasons(d)
    expect(p.length, 'a supplied identity must bind').toBeGreaterThan(0)
    expect(p.join(' ')).toContain('lacks capability EXTERNAL_EFFECT')
  })

  it('no identity means ADVISORY, not veto — and it is surfaced, not swallowed', () => {
    const d = evaluateDispatch(db, req())      // ordinary content, no identity
    expect(policyReasons(d), 'must not veto during migration').toHaveLength(0)
    expect(d.policyAdvisory?.join(' ') ?? '', 'the boundary must still be heard')
      .toContain('policy boundary ADVISORY')
    expect(d.policyAdvisory?.join(' ')).toContain('no caller identity')
  })

  it('an agent may not exceed the principal it sends for', () => {
    const agent = identity({ capabilityScope: ['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT'] })
    const principal: ExecutionIdentity = {
      actorId: 'istvan', actorType: 'HUMAN_USER', onBehalfOf: null, runId: null,
      capabilityScope: ['READ', 'WRITE_LOCAL'],
    }
    const d = evaluateDispatch(db, req({ identity: agent, principal }))
    expect(policyReasons(d).join(' ')).toContain('lacks capability EXTERNAL_EFFECT')

    // Same agent, no principal: the capability is there, so the test measures
    // delegation rather than a permanently missing permission.
    const alone = evaluateDispatch(db, req({ identity: agent }))
    expect(policyReasons(alone).join(' ')).not.toContain('lacks capability EXTERNAL_EFFECT')
  })

  it('every send bumps a decision counter on the cos_send surface', () => {
    evaluateDispatch(db, req())
    evaluateDispatch(db, req({ identity: identity({ capabilityScope: ['READ'] }) }))
    const m = readPolicyMetrics(db, NOW)
    expect(m.bySurface.cos_send, 'the gate must prove it ran').toBeGreaterThanOrEqual(2)
    expect(m.decisions).toBeGreaterThanOrEqual(2)
  })

  it('a send with no identity is counted as an identity-resolution failure', () => {
    evaluateDispatch(db, req())
    const m = readPolicyMetrics(db, NOW)
    // This counter is what keeps the migration exemption from rotting: "how much
    // of this gate is still advisory" is a number, not an impression.
    expect(m.totals.identity_resolution_failure).toBeGreaterThanOrEqual(1)
  })

  it('a send WITH an identity does not inflate the failure counter', () => {
    evaluateDispatch(db, req({ identity: identity() }))
    const m = readPolicyMetrics(db, NOW)
    expect(m.totals.identity_resolution_failure ?? 0).toBe(0)
  })

  it('a HIGHLY_SENSITIVE case cannot be sent even by a fully-scoped identity', () => {
    // fromCosSensitivity('HIGHLY_SENSITIVE') === 'SECRET', and SECRET may not
    // leave the machine at all -- fail-closed on the highest tier.
    const d = evaluateDispatch(db, req({
      declaredSensitivity: 'HIGHLY_SENSITIVE',
      identity: identity({ capabilityScope: ['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT', 'MODEL_EGRESS'] }),
    }))
    expect(policyReasons(d).join(' ')).toContain('may not leave the machine')
  })

  it('an unrecognised declared sensitivity fails closed, it does not read as PUBLIC', () => {
    const d = evaluateDispatch(db, req({
      declaredSensitivity: 'NOT_A_TIER',
      identity: identity({ capabilityScope: ['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT'] }),
    }))
    // effectiveSensitivity already fails closed to HIGHLY_SENSITIVE, which maps
    // to SECRET here -- so the two layers agree rather than cancelling out.
    expect(policyReasons(d).join(' ')).toContain('may not leave the machine')
  })
})
