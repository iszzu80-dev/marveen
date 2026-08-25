// W10 — scheduled task identity, and the property that makes it worth having.
//
// The interesting assertions here are the NEGATIVE ones. An identity that
// crosses a process boundary is only useful if the receiving process cannot
// widen it, and the only way to know that is to try.

import { describe, it, expect } from 'vitest'
import {
  SCHEDULED_IDENTITY_ENV, SCHEDULED_TASK_GRANTS, UNKNOWN_TASK_CAPABILITIES,
  declaredScheduledIdentity, lookupScheduledGrant, scheduledIdentityEnv,
  scheduledIdentityFromEnv,
} from '../identity/scheduled-task-identity.js'
import { authorizeAction } from '../identity/authorize-action.js'
import { CAPABILITIES } from '../identity/execution-identity.js'

const pub = { level: 'PUBLIC', tags: [], basis: 'test' } as const
const conf = { level: 'CONFIDENTIAL', tags: [], basis: 'test' } as const
const trustAll = { id: 'chat', trustedForLevel: () => true }

describe('the declaration is the authority, not the environment', () => {
  it('a spawned step rebuilds its own identity from the env', () => {
    const parent = declaredScheduledIdentity('cos-channel-send', 'run-7')
    const env = { ...scheduledIdentityEnv(parent) } as NodeJS.ProcessEnv
    const child = scheduledIdentityFromEnv(env)!
    expect(child.actorId).toBe('schedule:cos-channel-send')
    expect(child.runId).toBe('run-7')
    expect(child.onBehalfOf).toBe('istvan')
    expect([...child.capabilityScope]).toContain('EXTERNAL_EFFECT')
  })

  it('the env carries identifiers only — no capability list travels in it', () => {
    const env = scheduledIdentityEnv(declaredScheduledIdentity('cos-channel-send', 'run-7'))
    const blob = JSON.stringify(env)
    for (const cap of CAPABILITIES) expect(blob, `${cap} leaked into the env`).not.toContain(cap)
    expect(Object.keys(env).sort()).toEqual(
      [SCHEDULED_IDENTITY_ENV.onBehalfOf, SCHEDULED_IDENTITY_ENV.runId, SCHEDULED_IDENTITY_ENV.task].sort())
  })

  it('a forged task name gets the unknown-task scope, not a guess at a neighbour', () => {
    const forged = scheduledIdentityFromEnv({
      [SCHEDULED_IDENTITY_ENV.task]: 'cos-channel-send-EVIL',
      [SCHEDULED_IDENTITY_ENV.runId]: 'r',
      [SCHEDULED_IDENTITY_ENV.onBehalfOf]: 'istvan',
    } as NodeJS.ProcessEnv)!
    expect([...forged.capabilityScope]).toEqual([...UNKNOWN_TASK_CAPABILITIES])
    expect(forged.capabilityScope).not.toContain('EXTERNAL_EFFECT')
  })

  it('a child cannot promote itself by claiming a principal the declaration withheld', () => {
    // `cos-fetch-threads` is declared for istvan but holds no EXTERNAL_EFFECT.
    // Claiming a different principal must not change what it may do.
    const forged = scheduledIdentityFromEnv({
      [SCHEDULED_IDENTITY_ENV.task]: 'cos-fetch-threads',
      [SCHEDULED_IDENTITY_ENV.onBehalfOf]: 'someone-else',
    } as NodeJS.ProcessEnv)!
    expect(forged.onBehalfOf).toBeNull()
    expect(forged.capabilityScope).not.toContain('EXTERNAL_EFFECT')
  })

  it('no environment at all means NO identity, not a plausible one', () => {
    expect(scheduledIdentityFromEnv({} as NodeJS.ProcessEnv)).toBeNull()
  })
})

describe('the grant table is closed and fail-closed', () => {
  it('an unlisted task gets READ and WRITE_LOCAL only', () => {
    const i = declaredScheduledIdentity('a-task-nobody-declared', 'r')
    expect([...i.capabilityScope]).toEqual([...UNKNOWN_TASK_CAPABILITIES])
    expect(lookupScheduledGrant('a-task-nobody-declared')).toBeNull()
  })

  it('no task holds ADMIN or SECRET_READ', () => {
    for (const g of SCHEDULED_TASK_GRANTS) {
      expect(g.capabilities, g.task).not.toContain('ADMIN')
      expect(g.capabilities, g.task).not.toContain('SECRET_READ')
    }
  })

  it('every task that can reach outside says why, in more than a word', () => {
    for (const g of SCHEDULED_TASK_GRANTS.filter(g => g.capabilities.includes('EXTERNAL_EFFECT'))) {
      expect(g.rationale.length, `${g.task} has no stated reason for EXTERNAL_EFFECT`).toBeGreaterThan(30)
    }
  })

  it('task names are unique', () => {
    const names = SCHEDULED_TASK_GRANTS.map(g => g.task)
    expect(new Set(names).size).toBe(names.length)
  })

  it('the drafting step cannot send, which is what makes draft-then-send a boundary', () => {
    const draft = declaredScheduledIdentity('cos-draft-followups', 'r')
    expect(authorizeAction({
      action: 'EXTERNAL_EFFECT', identity: draft, classification: pub, target: trustAll,
    }).verdict).toBe('DENY')
  })
})

describe('acting for the owner is what separates ALLOW from REQUIRE_APPROVAL', () => {
  it('a declared step acting for Istvan may send confidential content', () => {
    const i = declaredScheduledIdentity('cos-channel-send', 'r')
    expect(authorizeAction({
      action: 'EXTERNAL_EFFECT', identity: i, classification: conf, target: trustAll,
    }).verdict).toBe('ALLOW')
  })

  it('the same step acting for NOBODY needs approval instead', () => {
    const i = declaredScheduledIdentity('cos-channel-send', 'r', false)
    const d = authorizeAction({
      action: 'EXTERNAL_EFFECT', identity: i, classification: conf, target: trustAll,
    })
    expect(d.verdict).toBe('REQUIRE_APPROVAL')
    expect(d.reasons.join(' ')).toMatch(/acting for nobody/)
  })
})

describe('the cycle and the grant table cannot drift apart', () => {
  // The failure this prevents is dull and expensive: someone renames a step or
  // adds one, the grant lookup misses, the step silently drops to the
  // unknown-task scope, and the CoS stops delivering owner questions with no
  // error anywhere. A cycle step with no declared grant is a bug, not a default.
  it('every step in scripts/cos-cycle.ts has a declared grant', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('scripts/cos-cycle.ts', 'utf8')
    const tasks = [...src.matchAll(/task: '([a-z0-9-]+)'/g)].map(m => m[1])
    expect(tasks.length, 'no steps found — the parse broke, not the cycle').toBeGreaterThan(5)
    const undeclared = tasks.filter(t => !lookupScheduledGrant(t))
    expect(undeclared).toEqual([])
  })

  it('the steps that actually send hold EXTERNAL_EFFECT', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('scripts/cos-cycle.ts', 'utf8')
    const tasks = [...src.matchAll(/task: '([a-z0-9-]+)'/g)].map(m => m[1])
    for (const t of ['cos-channel-send', 'cos-planned-digest', 'cos-wake-alert']) {
      expect(tasks, `${t} is no longer a cycle step`).toContain(t)
      expect(lookupScheduledGrant(t)!.capabilities, t).toContain('EXTERNAL_EFFECT')
    }
  })
})
