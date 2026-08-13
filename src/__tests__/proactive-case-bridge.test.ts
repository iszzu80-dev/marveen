// §8 / §14 / §26(11, 12, 19): the Proactive Core ↔ Case store bridge.
//
// §8's ordering is the point: existing Case first, new Case LAST. A proactive
// layer that opens a Case per signal produces a board nobody can read within a
// week — and every one of those Cases looks like work.
//
// §14's ordering is its sibling: every internal source, in order, and the owner
// strictly last. The condition people skip is the second one — a resolver with
// no probes wired resolves nothing, and "nothing resolved it" would otherwise
// read as permission to ask.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { initProgressionSchema } from '../cos/schema.js'
import { createCase, transitionCase } from '../cos/case-store.js'
import { createZstCase } from '../cos/zst-case-store.js'
import { ensureProactiveSchema } from '../cos/proactive/schema.js'
import { recordSignal } from '../cos/proactive/signal-store.js'
import { qualifySignal } from '../cos/proactive/qualification.js'
import {
  matchCase, attachToCase, newCaseRefusal, caseExplosionMetrics,
  resolveBeforeAsk, mayAskOwner, RESOLVE_SOURCE_ORDER, REOPEN_WINDOW_SEC,
  type ResolveProbe, type ResolveSource,
} from '../cos/proactive-case-bridge.js'
import type { ProactiveSignal } from '../cos/proactive/types.js'

const T0 = 1_700_000_000
const DAY = 86400

function setup(): void {
  initDatabase(':memory:')
  initProgressionSchema(getDb())
  ensureProactiveSchema(getDb())
}

function signal(over: Partial<Parameters<typeof recordSignal>[1]> = {}): ProactiveSignal {
  const r = recordSignal(getDb(), {
    domain: 'personal',
    signalType: 'DEADLINE',
    sourceRefs: ['doc-1'],
    subjectRef: 'Berleti szerzodes',
    summary: 'A hatarido kozeledik.',
    evidenceClaims: [{ statement: 'A hatarido 2026-09-01.', sourceRef: 'doc-1' }],
    estimatedMateriality: 'HIGH',
    estimatedUrgency: 'HIGH',
    estimatedActionability: 'HIGH',
    confidence: 0.9,
    ...over,
  }, T0)
  if (r.outcome !== 'RECORDED') throw new Error(JSON.stringify(r))
  return r.signal
}

describe('§8 the Case matching order — existing first, new last', () => {
  beforeEach(setup)

  it('HEADLINE: a named, living Case wins outright', () => {
    createCase(getDb(), { caseId: 'c1', title: 'Valami mas', caseType: 'ADMIN' }, T0)
    const m = matchCase(getDb(), signal({ candidateCaseId: 'c1' }), T0)
    expect(m).toMatchObject({ tier: 'ACTIVE_EXACT', caseId: 'c1' })
  })

  it('a named case that is CLOSED does not win the exact tier', () => {
    createCase(getDb(), { caseId: 'c1', title: 'X', caseType: 'ADMIN' }, T0)
    transitionCase(getDb(), { caseId: 'c1', seenVersion: 1, newStatus: 'COMPLETED', actor: 't' }, T0)
    expect(matchCase(getDb(), signal({ candidateCaseId: 'c1' }), T0).tier).toBe('NO_CASE')
  })

  it('HEADLINE: the subject match folds accents', () => {
    // `foldName` exists in this codebase because the model writes "István" with
    // the accent roughly as often as without, and an exact comparison sorted the
    // same case into two buckets depending on which spelling arrived. A title
    // match has exactly the same exposure.
    createCase(getDb(), { caseId: 'c1', title: 'Bérleti szerződés', caseType: 'ADMIN' }, T0)
    const m = matchCase(getDb(), signal({ subjectRef: 'Berleti szerzodes' }), T0)
    expect(m).toMatchObject({ tier: 'ACTIVE_SUBJECT', caseId: 'c1' })
  })

  it('a recently completed case is RE-OPENED rather than duplicated', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'Berleti szerzodes', caseType: 'ADMIN' }, T0 - 10 * DAY)
    transitionCase(db, { caseId: 'c1', seenVersion: 1, newStatus: 'COMPLETED', actor: 't' }, T0 - 5 * DAY)
    const m = matchCase(db, signal(), T0)
    expect(m).toMatchObject({ tier: 'RECENTLY_COMPLETED_REOPEN', caseId: 'c1' })
  })

  it('a LONG-completed case is not re-opened — that would resurrect, not continue', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'Berleti szerzodes', caseType: 'ADMIN' }, T0 - 400 * DAY)
    transitionCase(db, { caseId: 'c1', seenVersion: 1, newStatus: 'COMPLETED', actor: 't' },
      T0 - REOPEN_WINDOW_SEC - DAY)
    expect(matchCase(db, signal(), T0).tier).toBe('NO_CASE')
  })

  it('the two domains never match each other', () => {
    createZstCase(getDb(), { caseId: 'z1', title: 'Berleti szerzodes', caseType: 'ADMIN' }, T0)
    expect(matchCase(getDb(), signal({ domain: 'personal' }), T0).tier).toBe('NO_CASE')
  })
})

describe('§8.1 a NEW Case needs all five conditions', () => {
  beforeEach(setup)

  it('HEADLINE: an informational signal never becomes a Case', () => {
    // The condition that carries the weight. Everything else on §8.1's list is
    // satisfiable by a signal that is simply information — and a board full of
    // FYIs is a board that stops being read.
    const s = signal({ estimatedActionability: 'LOW' })
    const q = qualifySignal(s, T0)
    const r = attachToCase(getDb(), s, q, {
      title: 'X', caseType: 'ADMIN', desiredOutcomeTargetState: 'Y', nextAction: 'Z',
    }, T0)
    expect(r.ok).toBe(false)
  })

  it('HEADLINE: the FYI guard bites even on a hand-built PROMOTE verdict', () => {
    // The route the qualification path never takes. Through `qualifySignal` a
    // low-actionability signal is already ANNOTATE, so the earlier check catches
    // it — which makes this guard look redundant right up to the moment a caller
    // constructs a verdict itself. §8.1 lists the condition, so it is checked
    // where a Case is actually created, not only where the verdict is formed.
    expect(newCaseRefusal({
      signalId: 'x', decision: 'PROMOTE', reasonCodes: [],
      materialityScore: 0.8, urgencyScore: 0.5, actionabilityScore: 0.2,
      interruptionScore: 0.5, confidence: 0.9,
    }, 'Y', 'Z')).toMatch(/tájékoztatás/)
  })

  it('refuses without a target state or a next action', () => {
    const s = signal()
    const q = qualifySignal(s, T0)
    expect(newCaseRefusal(q, '', 'Z')).toMatch(/célállapot/)
    expect(newCaseRefusal(q, 'Y', '  ')).toMatch(/cselekvés/)
  })

  it('refuses when a matching Case already exists', () => {
    const s = signal({ candidateCaseId: 'c1' })
    createCase(getDb(), { caseId: 'c1', title: 'X', caseType: 'ADMIN' }, T0)
    const q = qualifySignal(s, T0, { activeCases: [{ caseId: 'c1' }] })
    expect(newCaseRefusal(q, 'Y', 'Z')).toMatch(/meglévő ügy/)
  })

  it('creates one when all five conditions hold, and says it created it', () => {
    const s = signal()
    const q = qualifySignal(s, T0)
    const r = attachToCase(getDb(), s, q, {
      title: 'Berleti szerzodes felmondasa', caseType: 'ADMIN',
      desiredOutcomeTargetState: 'Dontes szuletett', nextAction: 'Dontes elokeszitese',
    }, T0)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.created).toBe(true)
    expect(r.tier).toBe('NEW_CASE_JUSTIFIED')
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM personal_cases`).get()).toEqual({ n: 1 })
  })

  it('HEADLINE: reuse does not create — and the metric says so', () => {
    // §8.2's `reused_existing_case_rate` needs the distinction, and
    // reconstructing it later from timestamps is right until the day a case is
    // created by two paths at once.
    createCase(getDb(), { caseId: 'c1', title: 'Berleti szerzodes', caseType: 'ADMIN' }, T0)
    const s = signal()
    const r = attachToCase(getDb(), s, qualifySignal(s, T0), {
      title: 'X', caseType: 'ADMIN', desiredOutcomeTargetState: 'Y', nextAction: 'Z',
    }, T0)
    expect(r.ok && r.created).toBe(false)
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM personal_cases`).get()).toEqual({ n: 1 })
  })
})

describe('§8.2 the case-explosion guard', () => {
  it('with no case created there is NO ratio — null, not zero and not Infinity', () => {
    const m = caseExplosionMetrics([{ created: false }, { created: false }])
    expect(m.signalsPerCaseCreated).toBeNull()
    expect(m.reusedExistingCaseRate).toBe(1)
  })

  it('counts the ratio when there is one', () => {
    const m = caseExplosionMetrics([{ created: true }, { created: false }, { created: false }, { created: false }])
    expect(m.signalsPerCaseCreated).toBe(4)
    expect(m.reusedExistingCaseRate).toBeCloseTo(0.75, 3)
  })
})

describe('§14 resolve-before-ask', () => {
  beforeEach(setup)

  const yes = (refs: string[]): ResolveProbe => () => ({ resolved: true, value: 'x', evidenceRefs: refs })
  const no: ResolveProbe = () => ({ resolved: false, evidenceRefs: [] })

  /** Every §14 source wired, all refusing unless overridden. */
  function allProbes(over: Partial<Record<ResolveSource, ResolveProbe>> = {}): Record<ResolveSource, ResolveProbe> {
    const base = Object.fromEntries(
      RESOLVE_SOURCE_ORDER.map(s => [s, no]),
    ) as Record<ResolveSource, ResolveProbe>
    return { ...base, ...over }
  }

  it('HEADLINE: it stops at the first source that answers', () => {
    // Continuing would produce a second answer to a settled question, and two
    // resolutions that disagree are worse than one that is merely incomplete.
    const a = resolveBeforeAsk(getDb(), 'personal', 'c1', 'req', allProbes({
      case_events: yes(['ev-1']),
    }))
    expect(a.resolved).toBe(true)
    expect(a.attemptedSources).toEqual(['case_data', 'case_events'])
    expect(a.evidenceRefs).toEqual(['ev-1'])
  })

  it('tries every source, in the §14 order, before giving up', () => {
    const a = resolveBeforeAsk(getDb(), 'personal', 'c1', 'req', allProbes())
    expect(a.resolved).toBe(false)
    expect(a.attemptedSources).toEqual([...RESOLVE_SOURCE_ORDER])
  })

  it('a throwing probe does not stop the chain', () => {
    const boom: ResolveProbe = () => { throw new Error('nope') }
    const a = resolveBeforeAsk(getDb(), 'personal', 'c1', 'req', allProbes({
      case_data: boom, domain_safe_memory: yes(['m-1']),
    }))
    expect(a.resolved).toBe(true)
  })

  it('HEADLINE: no probes wired is NOT permission to ask', () => {
    // The condition people skip. A resolver with nothing configured resolves
    // nothing, and "nothing resolved it" reads exactly like "we tried
    // everything" unless the two are distinguished.
    const a = resolveBeforeAsk(getDb(), 'personal', 'c1', 'req', {})
    expect(a.resolved).toBe(false)
    expect(a.unresolvedReason).toMatch(/NEM indokolt/)
    expect(mayAskOwner(a)).toMatchObject({ may: false })
  })

  it('a PARTIALLY wired chain is also not permission to ask', () => {
    const a = resolveBeforeAsk(getDb(), 'personal', 'c1', 'req', { case_data: no })
    expect(mayAskOwner(a).may).toBe(false)
    expect(mayAskOwner(a).reason).toMatch(/nincs bekötve/)
  })

  it('only a fully tried, fully failed chain earns the right to ask', () => {
    const a = resolveBeforeAsk(getDb(), 'personal', 'c1', 'req', allProbes())
    expect(mayAskOwner(a)).toMatchObject({ may: true })
  })

  it('a resolved requirement is never asked about', () => {
    const a = resolveBeforeAsk(getDb(), 'personal', 'c1', 'req', allProbes({ case_data: yes(['c']) }))
    expect(mayAskOwner(a)).toMatchObject({ may: false })
  })
})
