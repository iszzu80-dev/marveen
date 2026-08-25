// W10 — the dashboard principal -> execution identity mapping.
//
// The property under test is narrow and load-bearing: this mapping may only ever
// produce a scope narrower than or equal to what the credential already permits.
// It is an adapter, not a grant.
import { describe, it, expect } from 'vitest'
import { identityFromPrincipal, scheduledTaskIdentity, type PrincipalLike } from '../identity/principal-adapter.js'
import { authorizeAction } from '../identity/authorize-action.js'
import type { Classification } from '../identity/sensitivity-scale.js'

const p = (over: Partial<PrincipalLike>): PrincipalLike => ({
  class: 'fleet', kind: 'token', attribution: 'fleet:shared-token', ...over,
})
const pub: Classification = { level: 'PUBLIC', tags: [], basis: 'test' }
const conf: Classification = { level: 'CONFIDENTIAL', tags: [], basis: 'test' }
const trustAll = { id: 't', trustedForLevel: () => true }

describe('W10 principal adapter', () => {
  it('anonymous maps to NULL, not to an empty-scoped identity', () => {
    // "nobody authenticated" and "an authenticated party with no permissions"
    // are different facts, and only the first is a resolution failure.
    expect(identityFromPrincipal(p({ class: 'anonymous', kind: 'none' }))).toBeNull()
    expect(identityFromPrincipal(null)).toBeNull()
    expect(identityFromPrincipal(undefined)).toBeNull()
  })

  it('the shared fleet token is an AGENT and does NOT get EXTERNAL_EFFECT or ADMIN', () => {
    // Every dispatched agent holds this token. A token that can open a case must
    // not, by the same act, be able to mail someone or change policy.
    const i = identityFromPrincipal(p({}))!
    expect(i.actorType).toBe('AGENT')
    expect(i.capabilityScope).toContain('WRITE_LOCAL')
    expect(i.capabilityScope).not.toContain('EXTERNAL_EFFECT')
    expect(i.capabilityScope).not.toContain('ADMIN')
    expect(i.capabilityScope).not.toContain('SECRET_READ')
  })

  it('an operator credential gets ADMIN but still not SECRET_READ', () => {
    for (const kind of ['session', 'device'] as const) {
      const i = identityFromPrincipal(p({ class: 'operator', kind, attribution: `user:istvan` }))!
      expect(i.actorType).toBe('HUMAN_USER')
      expect(i.capabilityScope).toContain('ADMIN')
      expect(i.capabilityScope).not.toContain('SECRET_READ')
    }
  })

  it('a federation peer gets READ and nothing else', () => {
    const i = identityFromPrincipal(p({ class: 'peer', kind: 'federation', attribution: 'peer:x' }))!
    expect(i.actorType).toBe('SERVICE')
    expect([...i.capabilityScope]).toEqual(['READ'])
  })

  // REWRITTEN 2026-08-25, and the change is a real narrowing of the claim.
  //
  // This used to assert that NO principal class could reach EXTERNAL_EFFECT --
  // "HTTP is not a send surface". That was already false when it was written:
  // /api/cos/outbound/approve is the button labelled "Elkuldom", and it has sent
  // mail since 2026-08-10. The assertion passed because the send path did not
  // consult the boundary yet, so nothing measured the contradiction. Wiring the
  // broker into the send is what made the test fail, which is the test doing its
  // job -- late.
  //
  // The true claim, and the one worth protecting, is narrower: a SHARED
  // credential cannot send. Every dispatched agent in this fleet holds the fleet
  // token; a peer holds federation. Neither may cause an effect outside this
  // machine. A human's own session or device credential may, because a human
  // approving a specific rendered payload is what authorises a send.
  it('no SHARED credential can reach EXTERNAL_EFFECT — only a human operator can', () => {
    for (const cls of ['fleet', 'peer'] as const) {
      const i = identityFromPrincipal(p({ class: cls, attribution: `x:${cls}` }))!
      const d = authorizeAction({
        action: 'EXTERNAL_EFFECT', identity: i, classification: pub, target: trustAll,
      })
      expect(d.verdict, cls).toBe('DENY')
    }
    const op = identityFromPrincipal(p({ class: 'operator', kind: 'session', attribution: 'user:istvan' }))!
    expect(authorizeAction({
      action: 'EXTERNAL_EFFECT', identity: op, classification: pub, target: trustAll,
    }).verdict).toBe('ALLOW')
  })

  it('the operator scope is the ONLY one that gained EXTERNAL_EFFECT', () => {
    // Guards the widening: if a future edit hands EXTERNAL_EFFECT to the shared
    // token, this goes red rather than the fleet quietly gaining a send.
    const withEffect = (['operator', 'fleet', 'peer'] as const).filter(cls =>
      identityFromPrincipal(p({ class: cls, attribution: `x:${cls}` }))!
        .capabilityScope.includes('EXTERNAL_EFFECT'))
    expect(withEffect).toEqual(['operator'])
  })

  it('the adapter never invents a delegation relationship', () => {
    const i = identityFromPrincipal(p({ class: 'operator', kind: 'session', attribution: 'user:istvan' }))!
    expect(i.onBehalfOf).toBeNull()
  })

  it('a scheduled task is SYSTEM_AUTOMATION and needs approval for confidential egress', () => {
    const t = scheduledTaskIdentity('personal-case-wake', 'run-9')
    expect(t.actorType).toBe('SYSTEM_AUTOMATION')
    expect(t.onBehalfOf).toBeNull()
    // Unattended + confidential + leaving the machine = approval, not a silent send.
    const d = authorizeAction({
      action: 'EXTERNAL_EFFECT',
      identity: { ...t, capabilityScope: [...t.capabilityScope, 'EXTERNAL_EFFECT'] },
      classification: conf, target: trustAll,
    })
    expect(d.verdict).toBe('REQUIRE_APPROVAL')
  })

  it('a scheduled task acting FOR the owner is a visible choice, not a default', () => {
    const alone = scheduledTaskIdentity('t', null)
    const forOwner = scheduledTaskIdentity('t', null, 'istvan')
    expect(alone.onBehalfOf).toBeNull()
    expect(forOwner.onBehalfOf).toBe('istvan')
  })

  it('a scheduled task holds no ADMIN and no EXTERNAL_EFFECT by default', () => {
    const t = scheduledTaskIdentity('t', null)
    expect(t.capabilityScope).not.toContain('ADMIN')
    expect(t.capabilityScope).not.toContain('EXTERNAL_EFFECT')
    expect(t.capabilityScope).not.toContain('SECRET_READ')
  })
})
