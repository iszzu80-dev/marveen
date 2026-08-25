// W10 — the external action broker.
//
// The claim under test is narrow and structural: when the broker refuses, the
// effect thunk is NEVER invoked. Every denial test therefore asserts on a spy
// counter, not on the returned verdict alone -- a verdict is what the broker
// SAYS, and the counter is what the outside world SAW.

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  brokerExternalAction, readExternalActionLog, requiredCapabilityFor,
  type ApprovalEvidence, type ExternalActionRequest,
} from '../identity/action-broker.js'
import {
  EXTERNAL_CAPABILITIES, isHighRisk, lookupExternalCapability,
  mutatingConnectors, readOnlyConnectors, RISK_CLASSES,
} from '../identity/external-capability-inventory.js'
import type { ExecutionIdentity } from '../identity/execution-identity.js'
import { readPolicyMetrics } from '../identity/policy-metrics.js'

const PUBLIC = { level: 'PUBLIC', tags: [], basis: 'test' } as const
const SECRET_TOKEN = { level: 'SECRET', tags: ['AUTH_TOKEN'], basis: 'test' } as const

function identity(over: Partial<ExecutionIdentity> = {}): ExecutionIdentity {
  return {
    actorId: 'marveen',
    actorType: 'AGENT',
    onBehalfOf: 'istvan',
    runId: 'run-1',
    capabilityScope: ['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT'],
    ...over,
  }
}

const approval: ApprovalEvidence = {
  approvalId: 'appr-1', approvedBy: 'istvan', approvedAt: 1_700_000_000,
  scopeDescription: 'send the quote reply to Sallai',
}

function req(over: Partial<ExternalActionRequest> = {}): ExternalActionRequest {
  return {
    connector: 'telegram.cos',
    operation: 'sendMessage',
    mutating: true,
    riskClass: 'ROUTINE',
    identity: identity(),
    classification: PUBLIC,
    targetId: 'chat-1',
    ...over,
  }
}

describe('external action broker — the effect only runs when permitted', () => {
  let calls: number
  const effect = () => { calls += 1; return 'sent' }
  beforeEach(() => { calls = 0 })

  it('executes a routine, fully identified, low-sensitivity external write', async () => {
    const r = await brokerExternalAction(req(), effect)
    expect(r.outcome).toBe('EXECUTED')
    expect(r.value).toBe('sent')
    expect(calls).toBe(1)
  })

  it('denies an undeclared connector, and does not call the effect', async () => {
    const r = await brokerExternalAction(req({ connector: 'slack.webhook' }), effect)
    expect(r.outcome).toBe('DENIED')
    expect(calls).toBe(0)
    expect(r.reasons.join(' ')).toMatch(/not in the external capability inventory/)
  })

  it('denies a mutating call on a connector whose credential is declared read-only', async () => {
    const r = await brokerExternalAction(
      req({ connector: 'gmail.read', operation: 'messages.modify' }), effect)
    expect(r.outcome).toBe('DENIED')
    expect(calls).toBe(0)
    expect(r.reasons.join(' ')).toMatch(/declared read-only/)
  })

  it('allows a READ on a read-only connector', async () => {
    const r = await brokerExternalAction(
      req({ connector: 'gmail.read', operation: 'messages.get', mutating: false }), effect)
    expect(r.outcome).toBe('EXECUTED')
    expect(calls).toBe(1)
  })

  it('denies a mutating action with no identity at all', async () => {
    const r = await brokerExternalAction(req({ identity: null }), effect)
    expect(r.outcome).toBe('DENIED')
    expect(calls).toBe(0)
    expect(r.reasons.join(' ')).toMatch(/without a resolved identity/)
  })

  it('denies a mutating action whose identity carries no run id', async () => {
    const r = await brokerExternalAction(req({ identity: identity({ runId: null }) }), effect)
    expect(r.outcome).toBe('DENIED')
    expect(calls).toBe(0)
    expect(r.reasons.join(' ')).toMatch(/without a run id/)
  })

  it('denies an auth-token payload even with a full capability scope', async () => {
    const r = await brokerExternalAction(
      req({
        classification: SECRET_TOKEN,
        identity: identity({ capabilityScope: ['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT', 'MODEL_EGRESS', 'SECRET_READ', 'ADMIN'] }),
      }),
      effect,
    )
    expect(r.outcome).toBe('DENIED')
    expect(calls).toBe(0)
  })

  it('denies a caller lacking EXTERNAL_EFFECT', async () => {
    const r = await brokerExternalAction(
      req({ identity: identity({ capabilityScope: ['READ', 'WRITE_LOCAL'] }) }), effect)
    expect(r.outcome).toBe('DENIED')
    expect(calls).toBe(0)
  })
})

describe('high-risk external actions are default DENY', () => {
  let calls: number
  const effect = () => { calls += 1; return 'ok' }
  beforeEach(() => { calls = 0 })

  const highRisk = () => req({
    connector: 'gmail.send', operation: 'messages.send', riskClass: 'CONTRACTUAL',
    targetId: 'sallai@example.com',
  })

  it('denies without approval evidence', async () => {
    const r = await brokerExternalAction(highRisk(), effect, { readback: () => 'marker-1' })
    expect(r.outcome).toBe('DENIED')
    expect(calls).toBe(0)
    expect(r.reasons.join(' ')).toMatch(/without an authorisation basis/)
  })

  it('denies without a readback, because the result would not be verifiable', async () => {
    const r = await brokerExternalAction({ ...highRisk(), approval }, effect)
    expect(r.outcome).toBe('DENIED')
    expect(calls).toBe(0)
    expect(r.reasons.join(' ')).toMatch(/without a readback/)
  })

  it('denies without an on_behalf_of principal', async () => {
    const r = await brokerExternalAction(
      { ...highRisk(), approval, identity: identity({ onBehalfOf: null }) },
      effect, { readback: () => 'marker-1' },
    )
    expect(r.outcome).toBe('DENIED')
    expect(calls).toBe(0)
    expect(r.reasons.join(' ')).toMatch(/attributable to no human/)
  })

  it('executes when actor, principal, run, approval and readback are all present', async () => {
    const r = await brokerExternalAction(
      { ...highRisk(), approval }, effect, { readback: () => 'COS-Ref: marker-1' })
    expect(r.outcome).toBe('EXECUTED')
    expect(calls).toBe(1)
    expect(r.readback).toBe('COS-Ref: marker-1')
  })

  it('a caller cannot downgrade risk to skip approval: the inventory ceiling wins', async () => {
    // gmail.send is CONTRACTUAL in the inventory. Declaring ROUTINE must not
    // buy an exemption from the approval requirement.
    const r = await brokerExternalAction(
      req({ connector: 'gmail.send', operation: 'messages.send', riskClass: 'ROUTINE', targetId: 'x@example.com' }),
      effect, { readback: () => 'm' },
    )
    expect(r.outcome).toBe('DENIED')
    expect(calls).toBe(0)
    expect(r.reasons.join(' ')).toMatch(/risk raised to CONTRACTUAL by the inventory ceiling/)
  })
})

describe('failure and readback are recorded honestly', () => {
  it('reports FAILED, not DENIED, when the effect itself throws', async () => {
    const r = await brokerExternalAction(req(), () => { throw new Error('provider 503') })
    expect(r.outcome).toBe('FAILED')
    expect(r.error).toMatch(/provider 503/)
  })

  it('a throwing readback does not turn a landed effect into a failure', async () => {
    const r = await brokerExternalAction(
      { ...req({ connector: 'gmail.send', operation: 'messages.send', riskClass: 'CONTRACTUAL', targetId: 'x@e.com' }), approval },
      () => 'sent',
      { readback: () => { throw new Error('search timed out') } },
    )
    expect(r.outcome).toBe('EXECUTED')
    expect(r.readback).toMatch(/readback failed: search timed out/)
  })
})

describe('the audit log records what happened, never the content', () => {
  it('persists a row and bumps a counter for a denial and for an execution', async () => {
    const db = new Database(':memory:')
    const at = 1_700_000_000
    await brokerExternalAction(req(), () => 'sent', { db, now: () => at, surface: 'test_broker' })
    await brokerExternalAction(req({ identity: null }), () => 'sent', { db, now: () => at, surface: 'test_broker' })

    const rows = readExternalActionLog(db, 0)
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.outcome).sort()).toEqual(['DENIED', 'EXECUTED'])

    const executed = rows.find(r => r.outcome === 'EXECUTED')!
    expect(executed.actorId).toBe('marveen')
    expect(executed.onBehalfOf).toBe('istvan')
    expect(executed.runId).toBe('run-1')
    expect(executed.connector).toBe('telegram.cos')

    const metrics = readPolicyMetrics(db, at)
    expect(metrics.totals.policy_allow).toBe(1)
    expect(metrics.totals.policy_deny).toBe(1)
    expect(metrics.bySurface.test_broker).toBeGreaterThan(0)
    db.close()
  })

  it('the audit row contains no message body', async () => {
    const db = new Database(':memory:')
    const secretBody = 'Kedves Sallai Ur, a 3 200 000 Ft-os ajanlatot elfogadom'
    await brokerExternalAction(
      req({ context: { messageLength: secretBody.length } }),
      () => secretBody,
      { db, surface: 'test_broker' },
    )
    const row = readExternalActionLog(db, 0)[0]
    expect(JSON.stringify(row)).not.toContain('Sallai')
    expect(JSON.stringify(row)).not.toContain('3 200 000')
    db.close()
  })

  it('counts an identity resolution failure separately from the denial', async () => {
    const db = new Database(':memory:')
    await brokerExternalAction(req({ identity: null }), () => 'x', { db, surface: 'test_broker' })
    const metrics = readPolicyMetrics(db, Math.floor(Date.now() / 1000))
    expect(metrics.totals.identity_resolution_failure).toBe(1)
    db.close()
  })
})

describe('the inventory is a closed, checkable set', () => {
  it('every entry declares where its scope claim can be checked', () => {
    for (const e of EXTERNAL_CAPABILITIES) {
      expect(e.scopeEvidence.length, `${e.id} has no scope evidence`).toBeGreaterThan(10)
      expect(e.auditSurface.length, `${e.id} names no audit surface`).toBeGreaterThan(5)
      // An entry MAY declare zero granted scopes -- that is what a measured
      // scope GAP looks like, and gmail.send / gmail.label on the private
      // account are exactly that today. What is not allowed is an empty list
      // with no explanation: a capability the provider does not grant and
      // nobody has written down is indistinguishable from an oversight.
      if (e.grantedScopes.length === 0) {
        expect(e.scopeGap, `${e.id} grants nothing and explains nothing`).toBeTruthy()
      }
    }
  })

  it('every read-only connector demands only READ', () => {
    for (const e of readOnlyConnectors()) expect(e.requiredCapability).toBe('READ')
  })

  it('every declared scope gap names what is missing, not just that something is', () => {
    for (const e of EXTERNAL_CAPABILITIES.filter(x => x.scopeGap)) {
      expect(e.scopeGap!.length, `${e.id}`).toBeGreaterThan(40)
    }
  })

  it('every mutating connector demands EXTERNAL_EFFECT', () => {
    for (const e of mutatingConnectors()) expect(e.requiredCapability).toBe('EXTERNAL_EFFECT')
  })

  it('no read-only connector can be used for a write, whoever asks', async () => {
    const god = identity({ capabilityScope: ['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT', 'MODEL_EGRESS', 'SECRET_READ', 'ADMIN'] })
    for (const e of readOnlyConnectors()) {
      let called = 0
      const r = await brokerExternalAction(
        req({ connector: e.id, mutating: true, identity: god, approval: approval as never }),
        () => { called += 1 },
      )
      expect(r.outcome, `${e.id} allowed a write`).toBe('DENIED')
      expect(called, `${e.id} invoked the effect`).toBe(0)
    }
  })

  it('ids are unique, so a lookup cannot silently resolve to the wrong entry', () => {
    const ids = EXTERNAL_CAPABILITIES.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('lookup of an unknown id returns null rather than a permissive default', () => {
    expect(lookupExternalCapability('does.not.exist')).toBeNull()
    expect(requiredCapabilityFor('does.not.exist')).toBeNull()
  })

  it('ROUTINE is the only class that is not high-risk', () => {
    for (const r of RISK_CLASSES) expect(isHighRisk(r)).toBe(r !== 'ROUTINE')
  })
})
