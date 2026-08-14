// APG 1.9 §12.3 + §12.4 (WP4) -- fresh verification, and the cost policy that
// decides whether it is owed.
//
// TWO DIFFERENT KINDS OF CLAIM ARE TESTED HERE, and conflating them would be
// the dishonest reading of WP4:
//
//   §12.3 is BUILT. A verifier packet carrying the acceptance contract and the
//   immutable target but not the producer's session history, dispatched under a
//   verifier-role execution identity for an agent that is not the producer,
//   into a session that was restarted fresh. Every one of those is asserted
//   against the real composition.
//
//   §12.4 is MODELLED, NOT RESOLVED. No risk profile exists anywhere in either
//   repository (§18 is unbuilt; apg/ui-projection.ts hardcodes risk 'unknown'),
//   so the policy can be expressed and tested but not applied. The tests below
//   pin the ONE property that keeps that honest: an unresolved risk yields
//   UNKNOWN -- null, with a reason code -- and never a verifier count.
//
// No filesystem, no tmux, no agent: every effect goes through FreshVerifierDeps.
// (This container runs as root, so a test may never lean on a permission bit.)

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  buildVerifierPacket,
  renderVerifierBrief,
  validateVerifierPacket,
  findProducerHistoryMarkers,
  type AcceptanceContract,
  type ImmutableTarget,
} from '../verifier-packet.js'
import { renderCheckpoint } from '../session-checkpoint.js'
import { artifactRefFromContent, renderContextPacket } from '../context-packet.js'
import { resolveVerifierPolicy, mayDispatchFreshVerifier, RISK_PROFILE_MISSING_INPUTS } from '../verifier-policy.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../web/context-guard-runner.js', () => ({
  restartSessionFresh: vi.fn(),
  agentSessionFor: (n: string) => `agent-${n}`,
  agentWorkingDir: (n: string) => `/agents/${n}`,
}))
vi.mock('../web/agent-process.js', () => ({ sendPromptToSession: vi.fn(async () => 'sent') }))
vi.mock('../costops/dispatch-identity.js', () => ({
  resolveDispatchIdentitySafe: () => ({ configuredModel: 'claude-sonnet-5' }),
}))

const { dispatchFreshVerifier, freshVerifierPrompt, VERIFIER_BRIEF_FILENAME } =
  await import('../web/fresh-verifier.js')
const { initDispatchSchema, resolveCardRoleAgents, createDispatch } = await import('../costops/dispatch.js')
const { initPacketMetadataSchema, readPacketMetadata } = await import('../costops/packet-metadata.js')

const CONTRACT: AcceptanceContract = {
  objective: 'The token page groups by model as well as by agent.',
  acceptanceCriteria: [
    'The page renders a per-model breakdown for every agent with usage.',
    'No new collector and no schema change were introduced.',
  ],
  constraints: ['Measurement only.'],
  verifiedClaims: ['token_usage already carries a model column (verified 2026-08-12).'],
}

const TARGET: ImmutableTarget = {
  ref: 'a1b2c3d',
  diffBase: 'main',
  paths: ['src/web/routes/tokens.ts'],
  artifacts: [artifactRefFromContent('docs/spec.md', 'a1b2c3d', 'the spec body', { note: 'the acceptance source' })],
}

/** A producer's real handoff: exactly the material §12.3-f keeps out. */
const PRODUCER_HANDOFF = renderCheckpoint({
  agent: 'dex', cardId: 'a1b2c3d4', generatedAt: '2026-08-13T09:00:00.000Z',
  goal: 'Group the token page by model',
  workDone: ['Tried three query shapes; the third one worked.'],
  filesChanged: ['src/web/routes/tokens.ts'],
  whatWorked: ['A GROUP BY on (agent, model) with a covering index.'],
  whatDidNotWork: ['A per-agent subquery -- N+1 on a 40k row table.'],
  nextStep: 'Wire the projection into the page',
})

function packetFor(over: Partial<Parameters<typeof buildVerifierPacket>[0]> = {}) {
  return buildVerifierPacket({
    workItemId: 'a1b2c3d4', producerAgent: 'dex', verifierAgent: 'orin',
    contract: CONTRACT, target: TARGET, ...over,
  })
}

describe('§12.3-c/-d/-e: the verifier packet carries the contract and the target', () => {
  it('carries every acceptance criterion as the packet\'s Done-when', () => {
    const text = renderContextPacket(packetFor())
    for (const c of CONTRACT.acceptanceCriteria) expect(text).toContain(c)
    expect(packetFor().doneWhen).toEqual(CONTRACT.acceptanceCriteria)
  })

  it('pins the immutable target and hands over a diff COMMAND, not a diff', () => {
    const text = renderContextPacket(packetFor())
    expect(text).toContain('Immutable target: a1b2c3d')
    expect(text).toContain('git diff main..a1b2c3d')
    expect(text).toContain('`docs/spec.md` @ a1b2c3d')
    expect(text).not.toContain('diff --git')
  })

  it('declares executionRole=verifier, which is what makes it a verifier packet', () => {
    expect(packetFor().executionRole).toBe('verifier')
    expect(renderContextPacket(packetFor())).toContain('executionRole: verifier')
    expect(validateVerifierPacket(packetFor(), TARGET).ok).toBe(true)
  })

  it('refuses a target that is not pinned -- a moving target is not a target', () => {
    const v = validateVerifierPacket(packetFor(), { ...TARGET, ref: '' })
    expect(v.ok).toBe(false)
    expect(v.errors.map(e => e.code)).toContain('target_not_pinned')
  })

  it('refuses a contract with no criteria -- that is a request for an opinion', () => {
    const p = packetFor({ contract: { ...CONTRACT, acceptanceCriteria: [] } })
    const v = validateVerifierPacket(p, TARGET)
    expect(v.ok).toBe(false)
    expect(v.errors.map(e => e.code)).toContain('no_acceptance_criteria')
  })

  it('always forbids editing the target and reading the producer\'s session', () => {
    const text = renderContextPacket(packetFor())
    expect(text).toContain('Do NOT modify the target')
    expect(text).toContain('Do NOT read the producer\'s session')
  })
})

describe('§12.3-f: no producer session history', () => {
  it('the packet contains none of the producer\'s handoff, because nothing can carry it', () => {
    const text = renderContextPacket(packetFor())
    for (const fragment of [
      'Tried three query shapes', 'A GROUP BY on (agent, model)', 'N+1 on a 40k row table',
      '## What Worked', '## Current Progress',
    ]) {
      expect(text).not.toContain(fragment)
    }
    // The structural reason: the input type has no field for it. The nearest
    // thing to a channel is `producerAgent`, and it carries a NAME, not a log.
    expect(text).toContain('independently of the producer (dex)')
  })

  it('the backstop scan catches a handoff pasted in through the constraints', () => {
    // The realistic violation: somebody helpfully pastes the producer's handoff
    // into the contract "for context". The type cannot stop that (constraints
    // are free text), so the scan does.
    const leaked = packetFor({ contract: { ...CONTRACT, constraints: [PRODUCER_HANDOFF.slice(0, 1500)] } })
    const markers = findProducerHistoryMarkers(renderContextPacket(leaked))
    expect(markers.length).toBeGreaterThan(0)
    expect(validateVerifierPacket(leaked, TARGET).errors.map(e => e.code))
      .toContain('producer_history_present')
  })

  it('the brief\'s two narrative sections are present and EMPTY -- the omission is visible', () => {
    const brief = renderVerifierBrief({
      packet: packetFor(), target: TARGET, contract: CONTRACT,
      verifierAgent: 'orin', workItemId: 'a1b2c3d4', generatedAt: '2026-08-13T10:00:00.000Z',
    })
    expect(brief.checkpoint.whatWorked).toEqual([])
    expect(brief.checkpoint.whatDidNotWork).toEqual([])
    expect(brief.markdown).toContain('## What Worked\n- (nothing recorded)')
    expect(brief.markdown).toContain("## What Didn't Work\n- (nothing recorded)")
    // ...and it says why they are empty, so a reader does not fill them in.
    expect(brief.markdown).toContain('producer\'s session history is deliberately absent')
    // The brief carries the packet itself, not a summary of it.
    expect(brief.markdown.startsWith(renderContextPacket(packetFor()))).toBe(true)
    // Every acceptance criterion is an executable step for the fresh session.
    for (const c of CONTRACT.acceptanceCriteria) expect(brief.markdown).toContain(`Criterion: ${c}`)
  })
})

describe('§12.3-a/-b: a different execution identity, in a fresh session', () => {
  let db: Database.Database
  let deps: any
  let restarted: string[]
  let prompts: Array<{ session: string; prompt: string }>
  let written: Array<{ path: string; content: string }>

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec('CREATE TABLE IF NOT EXISTS token_usage (id INTEGER PRIMARY KEY)')
    initDispatchSchema(db)
    initPacketMetadataSchema(db)
    restarted = []; prompts = []; written = []
    deps = {
      db,
      restartFresh: (a: string) => { restarted.push(a) },
      sessionFor: (a: string) => `agent-${a}`,
      sendPrompt: async (session: string, prompt: string) => { prompts.push({ session, prompt }) },
      briefPathFor: (a: string) => `/agents/${a}/${VERIFIER_BRIEF_FILENAME}`,
      writeBrief: (path: string, content: string) => { written.push({ path, content }) },
      nowIso: () => '2026-08-13T10:00:00.000Z',
    }
  })

  const input = (over: Record<string, unknown> = {}) => ({
    workItemId: 'a1b2c3d4', producerAgent: 'dex', verifierAgent: 'orin',
    contract: CONTRACT, target: TARGET,
    // §12.4 is unresolved for every real change today, so a test that wants a
    // verifier must say so out loud -- exactly as production would have to.
    policyOverride: 'test: exercising §12.3 while §18 is unbuilt',
    ...over,
  })

  it('mints a verifier-role dispatch for an agent that is NOT the producer', async () => {
    createDispatch(db, { source: 'kanban', role: 'producer', agent: 'dex', cardId: 'a1b2c3d4' })
    const res = await dispatchFreshVerifier(input() as any, deps)
    expect(res.dispatched).toBe(true)

    const rows = db.prepare('SELECT role, agent FROM dispatches ORDER BY rowid').all() as { role: string; agent: string }[]
    expect(rows).toEqual([{ role: 'producer', agent: 'dex' }, { role: 'verifier', agent: 'orin' }])
    // The read path WP3 built and could never populate now answers with a name.
    const roles = resolveCardRoleAgents(db, 'a1b2c3d4')
    expect(roles.producer).toBe('dex')
    expect(roles.verifier).toBe('orin')
    expect(roles.verifier).not.toBe(roles.producer)
  })

  it('restarts the verifier FRESH before the prompt, and points it at the brief', async () => {
    const res = await dispatchFreshVerifier(input() as any, deps)
    expect(restarted).toEqual(['orin'])
    expect(written).toHaveLength(1)
    expect(written[0].path).toBe('/agents/orin/VERIFIER-BRIEF.md')
    expect(prompts).toEqual([{ session: 'agent-orin', prompt: freshVerifierPrompt('a1b2c3d4', res.briefPath!) }])
    // The prompt is a pointer; the CONTEXT is the brief on disk.
    expect(prompts[0].prompt).toContain('/agents/orin/VERIFIER-BRIEF.md')
    expect(prompts[0].prompt).toContain('VERIFIER')
    // ...and it never tells the verifier to continue the producer's work, which
    // is what the saturation guard's resumePrompt does and why it is not reused.
    expect(prompts[0].prompt).not.toContain('FOLYTASD')
  })

  it('stores the verifier packet\'s identity against the verifier dispatch', async () => {
    const res = await dispatchFreshVerifier(input() as any, deps)
    const row = readPacketMetadata(db, res.dispatchId!)!
    expect(row.packetHash).toBe(res.packetHash)
    expect(row.executionRole).toBe('verifier')
    expect(row.generatedAt).toBe('2026-08-13T10:00:00.000Z')
  })

  it('refuses when the verifier IS the producer -- before any identity exists', async () => {
    const res = await dispatchFreshVerifier(input({ verifierAgent: 'dex' }) as any, deps)
    expect(res.dispatched).toBe(false)
    expect(res.reasonCode).toBe('VERIFIER_IS_PRODUCER')
    expect(restarted).toEqual([])
    expect(written).toEqual([])
    expect((db.prepare('SELECT COUNT(*) AS n FROM dispatches').get() as { n: number }).n).toBe(0)
  })

  it('refuses an invalid verifier packet without restarting anything', async () => {
    const res = await dispatchFreshVerifier(
      input({ contract: { ...CONTRACT, constraints: [PRODUCER_HANDOFF.slice(0, 1500)] } }) as any, deps)
    expect(res.dispatched).toBe(false)
    expect(res.reasonCode).toBe('VERIFIER_PACKET_INVALID')
    expect(res.detail).toContain('producer_history_present')
    expect(restarted).toEqual([])
    expect(prompts).toEqual([])
  })

  it('§12.3-h: nothing here selects a model, a provider or a persona', async () => {
    const res = await dispatchFreshVerifier(input() as any, deps)
    expect(res.dispatched).toBe(true)
    // The verifier's model comes from the agent's own configuration, exactly as
    // the producer's does. "Fresh" is a property of the identity and the
    // context; §12.3 says a different model is NOT required, and buying one
    // would be a cost decision §12.4 has no risk class to justify.
    const row = db.prepare("SELECT configured_model FROM dispatches WHERE role = 'verifier'")
      .get() as { configured_model: string | null }
    expect(row.configured_model).toBe('claude-sonnet-5')
  })
})

describe('§12.4: modelled, not resolved -- unresolved risk yields UNKNOWN', () => {
  it('an unknown risk class refuses to name a verifier count', () => {
    for (const risk of [undefined, null, 'unknown' as const, 'medium-ish' as never]) {
      const d = resolveVerifierPolicy(risk)
      expect(d.resolved).toBe(false)
      expect(d.risk).toBe('unknown')
      // THE assertion this whole module exists for: null, not 0 and not 1.
      expect(d.maxSemanticVerifiers).toBeNull()
      expect(d.freshVerifierRequired).toBeNull()
      expect(d.ownerGateAdmitted).toBeNull()
      expect(d.reasonCode).toBe('RISK_PROFILE_UNRESOLVED')
      expect(d.detail).toContain('§18')
    }
  })

  it('names what §18 would have to supply, as data rather than as a comment', () => {
    expect(RISK_PROFILE_MISSING_INPUTS.length).toBeGreaterThan(0)
    expect(RISK_PROFILE_MISSING_INPUTS.join(' ')).toContain('risk class')
  })

  it('the UI\'s risk really is hardcoded unknown -- this is not a hypothetical gap', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(import.meta.dirname, '..', 'apg', 'ui-projection.ts'), 'utf-8')
    expect(src).toContain("risk: 'unknown'")
  })

  it('LOW buys no semantic verifier (§12.4 / §18.1)', () => {
    const d = resolveVerifierPolicy('low')
    expect(d).toMatchObject({ resolved: true, maxSemanticVerifiers: 0, freshVerifierRequired: false, ownerGateAdmitted: false })
  })

  it('MEDIUM caps at one, and buys none when the acceptance is deterministic (§18.2)', () => {
    expect(resolveVerifierPolicy('medium', { acceptanceIsSemantic: true }).maxSemanticVerifiers).toBe(1)
    expect(resolveVerifierPolicy('medium', { acceptanceIsSemantic: false }).maxSemanticVerifiers).toBe(0)
    expect(resolveVerifierPolicy('medium').freshVerifierRequired).toBe(false)
  })

  it('HIGH and CRITICAL require ONE FRESH verifier and admit an owner gate', () => {
    for (const risk of ['high', 'critical'] as const) {
      expect(resolveVerifierPolicy(risk)).toMatchObject({
        resolved: true, maxSemanticVerifiers: 1, freshVerifierRequired: true, ownerGateAdmitted: true,
      })
    }
  })

  it('the gate refuses to DECIDE under unknown risk, which is not the same as deciding no', () => {
    const refused = mayDispatchFreshVerifier('unknown')
    expect(refused.allowed).toBe(false)
    expect(refused.policy.maxSemanticVerifiers).toBeNull()
    expect(refused.policy.reasonCode).toBe('RISK_PROFILE_UNRESOLVED')

    // A caller may proceed, but only by writing down that it is overriding a
    // policy that could not be resolved -- and the reason travels in the result.
    const overridden = mayDispatchFreshVerifier('unknown', { policyOverride: 'operator asked for it' })
    expect(overridden.allowed).toBe(true)
    expect(overridden.overrideReason).toBe('operator asked for it')
    expect(overridden.policy.resolved).toBe(false)
  })

  it('a real dispatch under unresolved risk is refused unless overridden', async () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE IF NOT EXISTS token_usage (id INTEGER PRIMARY KEY)')
    initDispatchSchema(db); initPacketMetadataSchema(db)
    const deps = {
      db, restartFresh: vi.fn(), sessionFor: (a: string) => a,
      sendPrompt: vi.fn(async () => undefined), briefPathFor: (a: string) => `/tmp/${a}`,
      writeBrief: vi.fn(), nowIso: () => '2026-08-13T10:00:00.000Z',
    }
    const res = await dispatchFreshVerifier({
      workItemId: 'a1b2c3d4', producerAgent: 'dex', verifierAgent: 'orin',
      contract: CONTRACT, target: TARGET,
    }, deps as any)
    expect(res.dispatched).toBe(false)
    expect(res.reasonCode).toBe('VERIFIER_POLICY_REFUSED')
    expect(res.policy.maxSemanticVerifiers).toBeNull()
    expect(deps.restartFresh).not.toHaveBeenCalled()
  })
})
