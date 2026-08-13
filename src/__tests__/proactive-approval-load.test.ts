// §17.5 / §17.6 / §17.7 / §26(24, 25, 27): the approval-load pipeline.
//
// The three lines this whole module sits between, from §17.6:
//
//     NORMAL CAP protects attention
//     DEADLINE ESCAPE protects outcome
//     AUTHORITY GATE remains unchanged
//
// The cap and the escape pull in opposite directions on purpose, and the third
// line keeps the argument honest: neither of them touches authority. The escape
// changes WHEN something is shown, never what may be done about it.
//
// §17.6.1 is the part most likely to be got wrong by kindness, and the headline
// test for it says why: "he just answered, surely he can look at one more" is a
// genuinely appealing argument, and it is the exact door the cap exists to shut.
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  ensureApprovalLoadSchema, planApprovalQueue, recordDecisions, needsEscape,
  DEFAULT_APPROVAL_BUDGET, COOLDOWN_EXCEPTION_INHERITANCE,
  type ApprovalCandidate,
} from '../cos/proactive/approval-load.js'

const T0 = 1_700_000_000
const DAY = 86400
let db: Database.Database

function candidate(id: string, over: Partial<ApprovalCandidate> = {}): ApprovalCandidate {
  return {
    candidateId: id,
    domain: 'personal',
    caseId: `case-${id}`,
    decisionKey: `decision-${id}`,
    materiality: 'HIGH',
    queueEnteredAt: T0,
    priority: 10,
    factualQualityPassed: true,
    contentDigest: `digest-${id}`,
    ...over,
  }
}

function plan(cands: ApprovalCandidate[], now = T0) {
  const r = planApprovalQueue(db, cands, now)
  recordDecisions(db, cands, r, now)
  return r
}

const dispositionOf = (r: ReturnType<typeof planApprovalQueue>, id: string): string =>
  r.decisions.find(d => d.candidateId === id)!.disposition

describe('§17.5 the pipeline order', () => {
  beforeEach(() => { db = new Database(':memory:'); ensureApprovalLoadSchema(db) })

  it('HEADLINE: a draft that failed §15.5 never occupies a budget slot', () => {
    // Quality first, so a draft that could never be approved does not displace
    // one that could.
    const r = plan([
      candidate('bad', { factualQualityPassed: false, priority: 1 }),
      candidate('good', { priority: 5 }),
    ])
    expect(dispositionOf(r, 'bad')).toBe('SUPPRESS')
    expect(dispositionOf(r, 'good')).toBe('PRESENT')
  })

  it('the per-user cap is 2 in 24 hours, and it holds across calls', () => {
    const first = plan([candidate('a'), candidate('b'), candidate('c')])
    expect(first.presentedCount).toBe(2)
    expect(first.deferredCount).toBe(1)
    // A second sweep the same day finds the budget already spent.
    const second = plan([candidate('d')], T0 + 3600)
    expect(second.presentedCount).toBe(0)
  })

  it('the budget refills after 24 hours', () => {
    plan([candidate('a'), candidate('b')])
    const later = plan([candidate('c')], T0 + DAY + 1)
    expect(later.presentedCount).toBe(1)
  })

  it('the per-CASE cap is 1 in 24 hours, even when the user budget is free', () => {
    const r = plan([
      candidate('a', { caseId: 'shared', decisionKey: 'd1' }),
      candidate('b', { caseId: 'shared', decisionKey: 'd2' }),
    ])
    expect(r.presentedCount).toBe(1)
    expect(r.deferredCount).toBe(1)
  })

  it('a DEFER consumes no budget — it never reached the owner', () => {
    plan([candidate('a'), candidate('b'), candidate('c')])
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM proactive_approval_presentations WHERE presented_at IS NOT NULL`,
    ).get() as { n: number }
    expect(row.n).toBe(2)
  })
})

describe('§17.7 approval-fatigue safeguards', () => {
  beforeEach(() => { db = new Database(':memory:'); ensureApprovalLoadSchema(db) })

  it('HEADLINE: drafts about one decision coalesce into one package', () => {
    const r = plan([
      candidate('a', { decisionKey: 'felmondas', materiality: 'MEDIUM' }),
      candidate('b', { decisionKey: 'felmondas', materiality: 'HIGH' }),
    ])
    // The most material one carries the package...
    expect(dispositionOf(r, 'b')).toBe('PRESENT')
    // ...and the other is BUNDLE, not SUPPRESS. "Folded into another ask" and
    // "dropped" are different facts, and only one of them is recoverable.
    expect(dispositionOf(r, 'a')).toBe('BUNDLE')
    expect(r.decisions.find(d => d.candidateId === 'a')?.bundleId).toBeTruthy()
  })

  it('a low-materiality draft may not ask for approval on its own', () => {
    const r = plan([candidate('low', { materiality: 'LOW' })])
    expect(dispositionOf(r, 'low')).toBe('SUPPRESS')
  })

  it('HEADLINE: an unchanged redraft is not a new approval request', () => {
    // §17.6.1's `approval_rephrase_does_not_create_new_approval_candidate`.
    // Without it the cap is a formality — anyone can re-render a draft.
    plan([candidate('a', { contentDigest: 'same' })])
    const again = plan([candidate('a2', { contentDigest: 'same' })], T0 + 100)
    expect(dispositionOf(again, 'a2')).toBe('SUPPRESS')
  })

  it('a CHANGED redraft is a new request', () => {
    plan([candidate('a', { contentDigest: 'v1' })])
    const changed = plan([candidate('a2', { contentDigest: 'v2', caseId: 'other' })], T0 + 100)
    expect(dispositionOf(changed, 'a2')).toBe('PRESENT')
  })

  it('backlog age is measured', () => {
    // The old one shares a case with `a` and sorts behind it on priority, so it
    // defers on the per-case cap — and its age is what the backlog metric has to
    // report. (Among equals the queue is oldest-first, which is why the priority
    // has to differ for the old one to be the deferred one at all.)
    const r = plan([
      candidate('a', { caseId: 'shared', priority: 1 }),
      candidate('old', { caseId: 'shared', decisionKey: 'other', priority: 99, queueEnteredAt: T0 - 5 * DAY }),
    ])
    expect(r.deferredCount).toBe(1)
    expect(r.oldestDeferredAgeSec).toBe(5 * DAY)
  })
})

describe('§17.6 the deadline escape hatch', () => {
  beforeEach(() => { db = new Database(':memory:'); ensureApprovalLoadSchema(db) })

  it('HEADLINE: the budget cannot override the deadline engine', () => {
    // The cap protects attention; the escape protects outcome. Computing the
    // escape AFTER the cap would make it a special case of the cap, which is the
    // opposite relationship to the one §17.6 states.
    const r = plan([
      candidate('a'), candidate('b'),                                  // fill the budget
      candidate('urgent', { internalSafeDeadline: T0 + 3600 }),         // and then some
    ])
    expect(dispositionOf(r, 'urgent')).toBe('DEADLINE_ESCALATED_APPROVAL')
    expect(r.escalatedCount).toBe(1)
  })

  it('past latest_present_by also escapes', () => {
    const r = plan([candidate('late', { latestPresentBy: T0 - 1 })])
    expect(dispositionOf(r, 'late')).toBe('DEADLINE_ESCALATED_APPROVAL')
    expect(r.decisions[0].reason).toMatch(/legkésőbbi előterjesztési idő/)
  })

  it('a distant deadline does not escape', () => {
    expect(needsEscape(candidate('x', { internalSafeDeadline: T0 + 30 * DAY }), T0, DEFAULT_APPROVAL_BUDGET))
      .toBe(false)
  })

  it('HEADLINE: several simultaneous escapes become ONE bundled P0, not a burst', () => {
    // §17.6: they must not be hidden — but neither may they arrive as a burst of
    // separate prompts, which is the very thing the cap protects against.
    const r = plan([
      candidate('u1', { internalSafeDeadline: T0 + 3600 }),
      candidate('u2', { internalSafeDeadline: T0 + 3600 }),
      candidate('u3', { internalSafeDeadline: T0 + 3600 }),
    ])
    expect(r.escalatedCount).toBe(3)
    expect(r.burstBundleId).toBeTruthy()
    const bundles = new Set(r.decisions
      .filter(d => d.disposition === 'DEADLINE_ESCALATED_APPROVAL')
      .map(d => d.bundleId))
    expect(bundles.size).toBe(1)
  })

  it('a single escape is NOT bundled — a bundle of one is a prompt with extra words', () => {
    const r = plan([candidate('u1', { internalSafeDeadline: T0 + 3600 })])
    expect(r.burstBundleId).toBeNull()
  })

  it('the escape is audited by reason, every time', () => {
    const r = plan([candidate('u1', { internalSafeDeadline: T0 + 3600 })])
    const row = db.prepare(`SELECT reason, disposition FROM proactive_approval_presentations`)
      .get() as { reason: string; disposition: string }
    expect(row.disposition).toBe('DEADLINE_ESCALATED_APPROVAL')
    expect(row.reason).toMatch(/§17\.6/)
  })

  it('HEADLINE: the escape does NOT approve anything — it only changes when it is shown', () => {
    // §17.6, twice and in bold: "not auto-approval, not an action-authority
    // escalation, purely a presentation/escalation override". The strongest
    // available form of that here: this module produces dispositions, and not
    // one of them is an approval.
    const r = plan([candidate('u1', { internalSafeDeadline: T0 + 3600 })])
    const dispositions = new Set(r.decisions.map(d => d.disposition))
    for (const d of dispositions) {
      expect(['PRESENT', 'DEFER', 'BUNDLE', 'SUPPRESS', 'DEADLINE_ESCALATED_APPROVAL']).toContain(d)
      expect(d).not.toMatch(/APPROVE|AUTHORIZ/i)
    }
  })

  it('a failed quality gate is NOT rescued by an imminent deadline', () => {
    // The escape overrides the presentation cap. It does not override §15.5 —
    // a draft that cannot be trusted does not become trustworthy by being late.
    const r = plan([candidate('bad', {
      factualQualityPassed: false, internalSafeDeadline: T0 + 3600,
    })])
    expect(dispositionOf(r, 'bad')).toBe('SUPPRESS')
  })
})

describe('§17.6.1 cooldown exception inheritance is explicit', () => {
  it('HEADLINE: owner_response_releases_approval_budget is FALSE, normatively', () => {
    // The appealing wrong answer: "he just answered, surely he can look at one
    // more". Answering a question is not the same act as approving an action —
    // and if one released the other, a single "yes" to an unrelated question
    // would let a whole held-back queue through at once.
    expect(DEFAULT_APPROVAL_BUDGET.ownerResponseReleasesApprovalBudget).toBe(false)
  })

  it('every known interruption exception carries an explicit decision and a reason', () => {
    // §17.6.1 requires the decision to be explicit precisely because the default
    // reading is inheritance: the two channels look alike, and "it works for
    // interruptions" is a sentence nobody argues with.
    expect(COOLDOWN_EXCEPTION_INHERITANCE.length).toBeGreaterThanOrEqual(2)
    for (const e of COOLDOWN_EXCEPTION_INHERITANCE) {
      expect(['INHERIT', 'DO_NOT_INHERIT', 'ADAPT']).toContain(e.approvalDecision)
      expect(e.rationale.length).toBeGreaterThan(60)
    }
    const owner = COOLDOWN_EXCEPTION_INHERITANCE.find(e => e.exception === 'owner_response_releases_cooldown')
    expect(owner?.approvalDecision).toBe('DO_NOT_INHERIT')
  })

  it('the rephrase rule is ADAPTed, not inherited — the mechanism differs', () => {
    // The principle carries over; the mechanism does not. On the interruption
    // side the QUESTION's hash decides; here it is the draft CONTENT's digest,
    // because a reworded approval request is the same request when the content
    // is the same, and a different one when it is not.
    const rephrase = COOLDOWN_EXCEPTION_INHERITANCE.find(e => e.exception.includes('rephrase'))
    expect(rephrase?.approvalDecision).toBe('ADAPT')
  })
})
