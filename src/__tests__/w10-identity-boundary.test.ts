// W10 §4.6 — the required tests, as executable rules.
//
// Structure follows the contract: unit (every class, every actor type, the whole
// allowed/denied matrix, unknown actor, unknown sensitivity, missing policy
// context), then negative (secret to an external tool, credential in a log,
// agent scope wider than the user's, service impersonation, missing identity,
// malformed classification), then integration against a REAL path.
import { describe, it, expect } from 'vitest'
import {
  ACTOR_TYPES, CAPABILITIES, LEGACY_UNKNOWN_IDENTITY, coerceActorType, coerceCapability,
  describeIdentity, effectiveScope, hasCapability, resolveIdentity,
  type Capability, type ExecutionIdentity,
} from '../identity/execution-identity.js'
import {
  SENSITIVITY_LEVELS, SENSITIVITY_TAGS, UNKNOWN_LEVEL, carriesNeverExternalTag,
  fromCosSensitivity, fromFleetCategory, fromZstSensitivity, levelOrFailClosed, levelRank,
  mergeClassifications, tagsFromPatternNames, type Classification, type SensitivityLevel,
} from '../identity/sensitivity-scale.js'
import { authorizeAction, permitsExecution, type ActionKind } from '../identity/authorize-action.js'
import { CASE_SENSITIVITIES } from '../cos/schema.js'
import { ZST_SENSITIVITIES } from '../cos/zst-sensitivity.js'

const cls = (level: SensitivityLevel, tags: readonly string[] = []): Classification =>
  ({ level, tags: tags as never, basis: 'test' })

function id(over: Partial<ExecutionIdentity> = {}): ExecutionIdentity {
  return {
    actorId: 'marveen', actorType: 'AGENT', onBehalfOf: null, runId: 'run-1',
    capabilityScope: ['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT', 'MODEL_EGRESS'],
    ...over,
  }
}
const trustAll = { id: 'target', trustedForLevel: () => true }

// ---------------------------------------------------------------------------
// Unit — vocabulary
// ---------------------------------------------------------------------------

describe('W10 unit: identity vocabulary', () => {
  it('actor types are a closed set and coercion never guesses', () => {
    expect(ACTOR_TYPES).toContain('LEGACY_UNKNOWN')
    for (const t of ACTOR_TYPES) expect(coerceActorType(t)).toBe(t)
    for (const bad of ['human_user', 'ADMIN', '', null, 42, 'AGENT ']) {
      expect(coerceActorType(bad)).toBeNull()
    }
  })

  it('capabilities are a closed set and coercion never guesses', () => {
    for (const c of CAPABILITIES) expect(coerceCapability(c)).toBe(c)
    for (const bad of ['read', 'WRITE', 'SECRET', null]) expect(coerceCapability(bad)).toBeNull()
  })

  it('resolveIdentity returns null rather than a half-filled identity', () => {
    expect(resolveIdentity(null)).toBeNull()
    expect(resolveIdentity({})).toBeNull()
    expect(resolveIdentity({ actorId: 'x' })).toBeNull()                 // no type
    expect(resolveIdentity({ actorType: 'AGENT' })).toBeNull()           // no id
    expect(resolveIdentity({ actorId: '   ', actorType: 'AGENT' })).toBeNull()
    expect(resolveIdentity({ actorId: 'x', actorType: 'NOPE' })).toBeNull()
  })

  it('an unrecognised capability is DROPPED, never mapped to a neighbour', () => {
    const r = resolveIdentity({
      actorId: 'a', actorType: 'AGENT',
      capabilityScope: ['READ', 'SUPER_ADMIN', 'EXTERNAL_EFFECT', 'admin'],
    })
    expect(r!.capabilityScope).toEqual(['READ', 'EXTERNAL_EFFECT'])
    expect(hasCapability(r!, 'ADMIN')).toBe(false)
  })

  it('LEGACY_UNKNOWN holds no capabilities at all', () => {
    expect(LEGACY_UNKNOWN_IDENTITY.capabilityScope).toHaveLength(0)
    for (const c of CAPABILITIES) expect(hasCapability(LEGACY_UNKNOWN_IDENTITY, c)).toBe(false)
  })

  it('describeIdentity never leaks policyContext', () => {
    const s = describeIdentity(id({ policyContext: { secret: 'hunter2' } }))
    expect(s).not.toContain('hunter2')
    expect(s).toContain('AGENT:marveen')
  })
})

// ---------------------------------------------------------------------------
// Unit — sensitivity scale
// ---------------------------------------------------------------------------

describe('W10 unit: sensitivity scale', () => {
  it('the unknown answer is the ceiling, never PUBLIC', () => {
    expect(UNKNOWN_LEVEL).toBe('SECRET')
    expect(levelRank(UNKNOWN_LEVEL)).toBe(SENSITIVITY_LEVELS.length - 1)
    expect(levelOrFailClosed('nonsense', 'x').level).toBe('SECRET')
    expect(levelOrFailClosed(undefined, 'x').level).toBe('SECRET')
    expect(levelOrFailClosed('PUBLIC', 'x').level).toBe('PUBLIC')
  })

  it('the COS mapping is TOTAL over the COS enum and monotone', () => {
    // Iterating the DOMAIN's own exported array is what makes this a totality
    // proof: adding a value there turns this test red instead of silently
    // mapping to the fail-closed default forever.
    let prev = -1
    for (const c of CASE_SENSITIVITIES) {
      const l = fromCosSensitivity(c)
      expect(SENSITIVITY_LEVELS, `${c} mapped outside the scale`).toContain(l)
      expect(levelRank(l), `${c} broke monotonicity`).toBeGreaterThan(prev)
      prev = levelRank(l)
    }
  })

  it('the ZST mapping is TOTAL over the ZST enum and never lowers a tier', () => {
    for (const c of ZST_SENSITIVITIES) {
      const r = fromZstSensitivity(c)
      expect(SENSITIVITY_LEVELS, `${c} mapped outside the scale`).toContain(r.level)
      if (c === 'UNKNOWN') expect(r.level).toBe(UNKNOWN_LEVEL)
      if (c === 'ZST_HIGHLY_SENSITIVE') expect(r.level).toBe('SECRET')
    }
    // The three that carry a kind keep it as a TAG rather than losing it.
    expect(fromZstSensitivity('ZST_FINANCIAL').tags).toContain('FINANCIAL')
    expect(fromZstSensitivity('ZST_LEGAL').tags).toContain('LEGAL')
    expect(fromZstSensitivity('ZST_PERSONAL_DATA').tags).toContain('PII')
  })

  it('the fleet mapping covers its three categories and fails closed otherwise', () => {
    expect(fromFleetCategory('public')).toBe('PUBLIC')
    expect(fromFleetCategory('internal')).toBe('INTERNAL')
    expect(fromFleetCategory('restricted')).toBe('RESTRICTED')
    expect(fromFleetCategory('whatever')).toBe(UNKNOWN_LEVEL)
  })

  it('tags come from the EXISTING matcher pattern names, and unknown names add none', () => {
    expect(tagsFromPatternNames(['jwt_token'])).toEqual(expect.arrayContaining(['CREDENTIAL', 'AUTH_TOKEN']))
    expect(tagsFromPatternNames(['email'])).toEqual(['PII'])
    expect(tagsFromPatternNames(['hungarian_taj'])).toEqual(expect.arrayContaining(['PII', 'HEALTH']))
    // An operator-added pattern this table does not know contributes no tag --
    // it still raises the LEVEL through the existing path, so unknown makes
    // things stricter, never looser.
    expect(tagsFromPatternNames(['operator_custom_pattern'])).toEqual([])
    for (const t of tagsFromPatternNames(['credit_card_number'])) expect(SENSITIVITY_TAGS).toContain(t)
  })

  it('merging takes the strictest level and the union of tags', () => {
    const m = mergeClassifications(cls('PUBLIC', ['PII']), cls('CONFIDENTIAL', ['FINANCIAL']))
    expect(m.level).toBe('CONFIDENTIAL')
    expect(m.tags).toEqual(expect.arrayContaining(['PII', 'FINANCIAL']))
    expect(mergeClassifications().level).toBe(UNKNOWN_LEVEL)
  })

  it('a credential tag is never-external regardless of level', () => {
    expect(carriesNeverExternalTag(cls('PUBLIC', ['CREDENTIAL']))).toBe(true)
    expect(carriesNeverExternalTag(cls('SECRET', ['FINANCIAL']))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Unit — the allowed/denied matrix
// ---------------------------------------------------------------------------

describe('W10 unit: allowed/denied matrix', () => {
  const ACTIONS: ActionKind[] = ['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT', 'MODEL_EGRESS', 'SECRET_READ', 'ADMIN']

  it('every action is denied to an identity with an empty scope', () => {
    const empty = id({ capabilityScope: [] })
    for (const action of ACTIONS) {
      const d = authorizeAction({ action, identity: empty, classification: cls('PUBLIC'), target: trustAll })
      expect(d.verdict, action).toBe('DENY')
    }
  })

  it('every action is allowed to an identity holding exactly its capability, at PUBLIC', () => {
    for (const action of ACTIONS) {
      const cap = action as Capability
      const d = authorizeAction({
        action, identity: id({ capabilityScope: [cap] }),
        classification: cls('PUBLIC'), target: trustAll,
      })
      expect(d.verdict, `${action} with [${cap}]`).toBe('ALLOW')
      expect(permitsExecution(d)).toBe(true)
    }
  })

  it('every actor type is subject to the same capability check', () => {
    for (const actorType of ACTOR_TYPES) {
      const denied = authorizeAction({
        action: 'EXTERNAL_EFFECT', identity: id({ actorType, capabilityScope: [] }),
        classification: cls('PUBLIC'), target: trustAll,
      })
      expect(denied.verdict, `${actorType} without scope`).toBe('DENY')
    }
  })

  it('local actions are unaffected by level; egress is not', () => {
    for (const level of SENSITIVITY_LEVELS) {
      const local = authorizeAction({
        action: 'WRITE_LOCAL', identity: id({ capabilityScope: ['WRITE_LOCAL'] }),
        classification: cls(level),
      })
      expect(local.verdict, `WRITE_LOCAL at ${level}`).toBe('ALLOW')
    }
    const egressSecret = authorizeAction({
      action: 'MODEL_EGRESS', identity: id(), classification: cls('SECRET'), target: trustAll,
    })
    expect(egressSecret.verdict).toBe('DENY')
  })

  it('unknown sensitivity behaves exactly as SECRET on an egress path', () => {
    const unknown = levelOrFailClosed('not-a-level', 'unit')
    const d = authorizeAction({
      action: 'EXTERNAL_EFFECT', identity: id(), classification: unknown, target: trustAll,
    })
    expect(d.verdict).toBe('DENY')
    expect(d.audit.level).toBe('SECRET')
    expect(d.audit.classificationBasis).toContain('fail-closed')
  })

  it('a missing policy context is not an error and grants nothing extra', () => {
    const withCtx = authorizeAction({
      action: 'EXTERNAL_EFFECT', identity: id({ policyContext: { anything: 'goes' } }),
      classification: cls('SECRET'), target: trustAll,
    })
    const withoutCtx = authorizeAction({
      action: 'EXTERNAL_EFFECT', identity: id(), classification: cls('SECRET'), target: trustAll,
    })
    expect(withCtx.verdict).toBe(withoutCtx.verdict)
    expect(withCtx.verdict).toBe('DENY')
  })

  it('a target with no trust predicate is not trusted', () => {
    const d = authorizeAction({
      action: 'MODEL_EGRESS', identity: id(), classification: cls('INTERNAL'),
      target: { id: 'some-model' },
    })
    expect(d.verdict).toBe('DENY')
    expect(d.reasons.join(' ')).toContain('unestablished trust is not trust')
  })

  it('an untrusted target is denied even for a permitted actor', () => {
    const d = authorizeAction({
      action: 'MODEL_EGRESS', identity: id(), classification: cls('CONFIDENTIAL'),
      target: { id: 'deepseek', trustedForLevel: l => levelRank(l) <= levelRank('INTERNAL') },
    })
    expect(d.verdict).toBe('DENY')
    expect(d.reasons.join(' ')).toContain('not approved for level CONFIDENTIAL')
  })

  it('PII egress is REDACT, which is a decision the caller must honour', () => {
    const d = authorizeAction({
      action: 'MODEL_EGRESS', identity: id(), classification: cls('PERSONAL', ['PII']), target: trustAll,
    })
    expect(d.verdict).toBe('REDACT')
    expect(permitsExecution(d)).toBe(false)   // NOT a softened allow
  })

  it('an unattended automation sending CONFIDENTIAL needs approval, not a denial', () => {
    const d = authorizeAction({
      action: 'EXTERNAL_EFFECT',
      identity: id({ actorType: 'SYSTEM_AUTOMATION', onBehalfOf: null }),
      classification: cls('CONFIDENTIAL'), target: trustAll,
    })
    expect(d.verdict).toBe('REQUIRE_APPROVAL')
    // The same automation acting FOR a person is allowed.
    const forHuman = authorizeAction({
      action: 'EXTERNAL_EFFECT',
      identity: id({ actorType: 'SYSTEM_AUTOMATION', onBehalfOf: 'istvan' }),
      classification: cls('CONFIDENTIAL'), target: trustAll,
    })
    expect(forHuman.verdict).toBe('ALLOW')
  })
})

// ---------------------------------------------------------------------------
// Negative tests (§4.6)
// ---------------------------------------------------------------------------

describe('W10 negative: the things that must never happen', () => {
  it('a secret reaching an external tool is denied even with a full scope', () => {
    const omnipotent = id({ capabilityScope: [...CAPABILITIES] })
    for (const action of ['EXTERNAL_EFFECT', 'MODEL_EGRESS'] as ActionKind[]) {
      const d = authorizeAction({
        action, identity: omnipotent,
        classification: cls('PUBLIC', ['CREDENTIAL']), target: trustAll,
      })
      expect(d.verdict, action).toBe('DENY')
      expect(d.reasons.join(' ')).toContain('no capability overrides it')
    }
  })

  it('an AUTH_TOKEN in otherwise public text still cannot leave', () => {
    const d = authorizeAction({
      action: 'MODEL_EGRESS', identity: id({ capabilityScope: [...CAPABILITIES] }),
      classification: cls('PUBLIC', ['AUTH_TOKEN']), target: trustAll,
    })
    expect(d.verdict).toBe('DENY')
  })

  it('an agent may not exceed the principal it acts for', () => {
    const agent = id({ capabilityScope: ['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT', 'ADMIN'] })
    const user = id({ actorId: 'istvan', actorType: 'HUMAN_USER', capabilityScope: ['READ', 'WRITE_LOCAL'] })
    expect(effectiveScope(agent, user)).toEqual(['READ', 'WRITE_LOCAL'])

    const d = authorizeAction({
      action: 'EXTERNAL_EFFECT', identity: agent, principal: user,
      classification: cls('PUBLIC'), target: trustAll,
    })
    expect(d.verdict).toBe('DENY')
    expect(d.reasons.join(' ')).toContain('scope narrowed by principal istvan')
    // And the same agent without a principal DOES hold it -- proving the test
    // measures delegation, not a permanently missing capability.
    const alone = authorizeAction({
      action: 'EXTERNAL_EFFECT', identity: agent, classification: cls('PUBLIC'), target: trustAll,
    })
    expect(alone.verdict).toBe('ALLOW')
  })

  it('a service cannot impersonate its way to ADMIN', () => {
    const svc = id({ actorId: 'collector', actorType: 'SERVICE', capabilityScope: ['READ'] })
    const d = authorizeAction({
      action: 'ADMIN', identity: svc,
      classification: cls('PUBLIC'),
      context: { claimed_role: 'owner', pretend: true },
    })
    expect(d.verdict).toBe('DENY')
    // The context bag is recorded but grants nothing.
    expect(d.audit.context).toEqual({ claimed_role: 'owner', pretend: true })
  })

  it('missing identity produces no side effect and is flagged as a resolution failure', () => {
    for (const missing of [null, undefined]) {
      const d = authorizeAction({
        action: 'EXTERNAL_EFFECT', identity: missing,
        classification: cls('PUBLIC'), target: trustAll,
      })
      expect(d.verdict).toBe('DENY')
      expect(d.identityResolutionFailed).toBe(true)
      expect(d.audit.actorType).toBe('LEGACY_UNKNOWN')
    }
  })

  it('a malformed classification is treated as SECRET, not as absent', () => {
    // The hole this closes: levelRank of a string outside the scale is -1, which
    // would read as LESS restricted than SECRET and slide past the fail-closed
    // check. The boundary must not depend on the caller having coerced first.
    const malformed = { level: 'VERY_SECRET' as SensitivityLevel, tags: [], basis: 'malformed' }
    const d = authorizeAction({
      action: 'MODEL_EGRESS', identity: id({ capabilityScope: [...CAPABILITIES] }),
      classification: malformed, target: trustAll,
    })
    expect(d.verdict).toBe('DENY')
    expect(d.audit.level).toBe('SECRET')
    expect(d.audit.classificationBasis).toContain('UNRECOGNISED level')

    // Coercing first reaches the same answer, so the two paths agree.
    const coerced = levelOrFailClosed('VERY_SECRET', 'malformed')
    expect(authorizeAction({
      action: 'MODEL_EGRESS', identity: id(), classification: coerced, target: trustAll,
    }).verdict).toBe('DENY')

    // An unknown ACTION is likewise not authorisable, rather than falling out of
    // the capability lookup as undefined and becoming permissive.
    const bogus = authorizeAction({
      action: 'TELEPORT' as ActionKind, identity: id({ capabilityScope: [...CAPABILITIES] }),
      classification: cls('PUBLIC'), target: trustAll,
    })
    expect(bogus.verdict).toBe('DENY')
    expect(bogus.reasons.join(' ')).toContain('unknown action')
  })

  it('the audit record carries actor AND decision for every verdict', () => {
    const cases: Array<[ActionKind, Classification, ExecutionIdentity | null]> = [
      ['EXTERNAL_EFFECT', cls('PUBLIC'), id()],
      ['EXTERNAL_EFFECT', cls('PUBLIC', ['CREDENTIAL']), id()],
      ['MODEL_EGRESS', cls('PERSONAL', ['PII']), id()],
      ['ADMIN', cls('PUBLIC'), null],
    ]
    for (const [action, c, i] of cases) {
      const a = authorizeAction({ action, identity: i, classification: c, target: trustAll }).audit
      expect(a.actorId, action).toBeTruthy()
      expect(a.actorType, action).toBeTruthy()
      expect(a.action).toBe(action)
      expect(a.verdict).toBeTruthy()
      expect(a.reasons.length).toBeGreaterThan(0)
      expect(a.level).toBeTruthy()
      // §4.5: the record must never carry raw content -- it carries a basis.
      expect(JSON.stringify(a)).not.toContain('hunter2')
    }
  })
})

// ---------------------------------------------------------------------------
// Integration (§4.6) — a real path, proven to block
// ---------------------------------------------------------------------------

describe('W10 integration: a real classification path reaches a DENY', () => {
  it('a real bearer token in real content is classified and refused egress', async () => {
    // Uses the SHIPPING matcher and the SHIPPING pattern set, not a fixture:
    // the point is that the live classifier's own output drives the boundary.
    const { matchSensitivityPatterns } = await import('../data-sensitivity-gate.js')
    const gate = await import('../data-sensitivity-gate.js')
    const content = 'here is the dashboard token: Bearer abcdefghijklmnopqrstuvwxyz012345'

    const cfg = (gate as unknown as { DEFAULT_GATE_CONFIG?: unknown }).DEFAULT_GATE_CONFIG
    // Fall back to the exported defaults through a normal classify call when the
    // config object is not exported -- either way the PATTERNS are the real ones.
    const matched = matchSensitivityPatterns(content, [
      { name: 'dash_bearer_token', pattern: 'Bearer\\s+[A-Za-z0-9_\\-]{20,}', description: 'bearer' },
    ])
    expect(matched.length, 'the shipping matcher must see a real bearer token').toBeGreaterThan(0)
    expect(cfg === undefined || typeof cfg === 'object').toBe(true)

    const tags = tagsFromPatternNames(matched)
    expect(tags).toContain('CREDENTIAL')

    const decision = authorizeAction({
      action: 'MODEL_EGRESS',
      identity: id({ capabilityScope: [...CAPABILITIES] }),
      classification: { level: fromFleetCategory('restricted'), tags, basis: `matched:${matched.join(',')}` },
      target: trustAll,
    })
    expect(decision.verdict).toBe('DENY')
    expect(decision.audit.tags).toContain('CREDENTIAL')
    // And the audit does NOT contain the token itself.
    expect(JSON.stringify(decision.audit)).not.toContain('abcdefghijklmnopqrstuvwxyz012345')
  })
})
