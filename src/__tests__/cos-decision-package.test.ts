// §20 — the Decision Package.
//
// The spec asks a question to carry seven things:
//
//   Mi az ügy? · Mit intézett Marveen? · Miért állt meg? · Mik az opciók?
//   Mit javasol? · Mi kell Istvántól? · Meddig?
//
// The question carried three. These tests measure the other four, and — more
// importantly — measure the two ways the four could be built WRONG:
//
//   1. built and never called. Every previous round of this review found at
//      least one mechanism that was complete, tested, and had no production
//      caller. So the sweep itself is tested here, not only the composer.
//   2. built by inventing. An element with no source in the stored state must be
//      OMITTED, never filled with a plausible sentence — an owner choosing
//      between options the system made up is worse off than one with no options.

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

import { initDatabase, getDb } from '../db.js'
import { collectDecisionPackage, formatDeadline } from '../cos/decision-package.js'
import { buildOwnerQuestion, askPendingOwnerQuestions } from '../cos/owner-question.js'
import { recordProgressionEvents } from '../cos/progression-events.js'
import type { ReaderEvidencePacket } from '../cos/reader.js'
import type { EvidencePlan } from '../cos/evidence-planner.js'

const T = 1_770_000_000

function freshDb(): Database.Database {
  initDatabase(':memory:')
  return getDb()
}

function seedCase(
  db: Database.Database, caseId: string,
  opts: { dueAt?: number; followUpAt?: number; blockedReason?: string } = {},
): void {
  db.prepare(
    `INSERT INTO personal_cases
       (case_id, title, case_type, status, sensitivity, version,
        due_at, follow_up_at, blocked_reason, created_at, updated_at)
     VALUES (?, 'Ügyvédi szerződés véleményezése', 'LEGAL', 'TRIAGE', 'PERSONAL', 1,
             ?, ?, ?, ?, ?)`,
  ).run(caseId, opts.dueAt ?? null, opts.followUpAt ?? null, opts.blockedReason ?? null, T, T)
}

function seedState(db: Database.Database, caseId: string, nba: unknown): void {
  db.prepare(
    `INSERT INTO case_progression_state
       (domain, case_id, progression_enabled, progression_mode,
        next_best_action_json, created_at, updated_at)
     VALUES ('personal', ?, 1, 'shadow', ?, ?, ?)`,
  ).run(caseId, nba === null ? null : JSON.stringify(nba), T, T)
}

function seedRun(db: Database.Database, caseId: string, decision: string): void {
  db.prepare(
    `INSERT INTO case_progression_runs
       (progression_run_id, domain, case_id, trigger_type, case_version_before,
        case_version_after, goal_version, plan_version_before, plan_version_after,
        decision, reason, status, started_at, completed_at)
     VALUES (?, 'personal', ?, 'MANUAL', 1, 2, 0, 0, 1, ?, 'test', 'COMPLETED', ?, ?)`,
  ).run(`run-${caseId}-${decision}`, caseId, decision, T, T)
}

// ── The four elements ─────────────────────────────────────────────────────

describe('§20 — collectDecisionPackage', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  describe('20.2 — mit intézett Marveen?', () => {
    it('reads the progression\'s own event history', () => {
      seedCase(db, 'd1')
      recordProgressionEvents(db, {
        domain: 'personal', caseId: 'd1', caseVersion: 2, runId: 'r1', now: T,
        decision: 'WAIT_EXTERNAL', previousDecision: 'CONTINUE_AUTONOMOUSLY',
        planVersion: 1, previousPlanVersion: null,
        goalDefined: true, semanticStatus: 'IN_PROGRESS', previousSemanticStatus: null,
      })
      const pkg = collectDecisionPackage(db, 'personal', 'd1')
      expect(pkg.handled).toContain('Kiolvastam, mi az ügy célja')
      expect(pkg.handled).toContain('Tervet készítettem a lezáráshoz')
      expect(pkg.handled).toContain('Vártam a másik félre')
    })

    it('counts what actually LEFT the machine', () => {
      seedCase(db, 'd2')
      db.prepare(
        `INSERT INTO outbound_ledger
           (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key,
            status, created_at, updated_at)
         VALUES ('l1', 'd2', 'EMAIL_SEND', 1, 'k1', 'VERIFIED', ?, ?)`,
      ).run(T, T)
      expect(collectDecisionPackage(db, 'personal', 'd2').handled)
        .toContain('Kiküldtem 1 levelet az ügyben')
    })

    it('a PLANNED action is not something that was done', () => {
      seedCase(db, 'd3')
      db.prepare(
        `INSERT INTO outbound_ledger
           (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key,
            status, created_at, updated_at)
         VALUES ('l2', 'd3', 'EMAIL_SEND', 1, 'k2', 'PLANNED', ?, ?)`,
      ).run(T, T)
      expect(collectDecisionPackage(db, 'personal', 'd3').handled).toEqual([])
    })

    it('does not repeat itself when the history repeats', () => {
      seedCase(db, 'd4')
      for (let i = 0; i < 4; i++) {
        recordProgressionEvents(db, {
          domain: 'personal', caseId: 'd4', caseVersion: 2, runId: `r${i}`, now: T + i,
          decision: 'WAIT_EXTERNAL', previousDecision: 'CONTINUE_AUTONOMOUSLY',
          planVersion: 1, previousPlanVersion: null,
          goalDefined: false, semanticStatus: null, previousSemanticStatus: null,
        })
      }
      const handled = collectDecisionPackage(db, 'personal', 'd4').handled
      expect(handled.filter(h => h === 'Vártam a másik félre').length).toBe(1)
    })

    it('an unknown event type produces NO line rather than a raw enum name', () => {
      seedCase(db, 'd5')
      db.prepare(
        `INSERT INTO personal_case_events
           (case_id, case_version, actor, event_type, source_system, source_reference, created_at)
         VALUES ('d5', 1, 'marveen', 'SOMETHING_NEW', 'progression', 'r9', ?)`,
      ).run(T)
      const handled = collectDecisionPackage(db, 'personal', 'd5').handled
      expect(handled.join(' ')).not.toMatch(/SOMETHING_NEW/)
    })
  })

  describe('20.3 — miért állt meg?', () => {
    it('prefers the engine\'s own decision', () => {
      seedCase(db, 'w1', { blockedReason: 'valami régi megjegyzés' })
      seedRun(db, 'w1', 'REQUEST_APPROVAL')
      expect(collectDecisionPackage(db, 'personal', 'w1').stoppedBecause)
        .toBe('jóváhagyás kell, mielőtt bármi kimegy')
    })

    it('falls back to the case\'s own blocked_reason', () => {
      seedCase(db, 'w2', { blockedReason: 'a bank nem válaszol' })
      expect(collectDecisionPackage(db, 'personal', 'w2').stoppedBecause).toBe('a bank nem válaszol')
    })

    it('says nothing when nothing said why', () => {
      seedCase(db, 'w3')
      expect(collectDecisionPackage(db, 'personal', 'w3').stoppedBecause).toBeNull()
    })
  })

  describe('20.5 / 20.4 — mit javasol, és mit lehet válaszolni', () => {
    it('the recommendation is the engine\'s own next best action', () => {
      seedCase(db, 'p1')
      seedState(db, 'p1', { description: 'Kérj be egy pontosított árajánlatot', canProceedAutonomously: false })
      const pkg = collectDecisionPackage(db, 'personal', 'p1')
      expect(pkg.recommendation).toBe('Kérj be egy pontosított árajánlatot')
    })

    // THE STEP THAT NEEDS NO DECISION IS NOT A QUESTION. Proposing something the
    // engine would do anyway is how a channel becomes noise.
    it('an autonomous step is not proposed to the owner', () => {
      seedCase(db, 'p2')
      seedState(db, 'p2', { description: 'Elolvasom a mellékletet', canProceedAutonomously: true })
      expect(collectDecisionPackage(db, 'personal', 'p2').recommendation).toBeNull()
    })

    // THE ELEMENT MOST EASILY FAKED. Options exist only where there is something
    // to say yes or no TO; listing "igen/nem" under an open question would be a
    // lie about what the answer parser understands.
    it('options appear ONLY alongside a recommendation', () => {
      seedCase(db, 'p3')
      seedState(db, 'p3', null)
      const pkg = collectDecisionPackage(db, 'personal', 'p3')
      expect(pkg.recommendation).toBeNull()
      expect(pkg.options).toEqual([])
    })

    it('the options are the ones the answer parser can actually distinguish', () => {
      seedCase(db, 'p4')
      seedState(db, 'p4', { description: 'Írjak a bérbeadónak', canProceedAutonomously: false })
      const opts = collectDecisionPackage(db, 'personal', 'p4').options
      expect(opts.some(o => o.includes('igen'))).toBe(true)
      expect(opts.some(o => o.includes('nem'))).toBe(true)
      expect(opts.some(o => /szabadon/.test(o))).toBe(true)
    })
  })

  describe('20.7 — meddig?', () => {
    it('a real due date beats a follow-up reminder', () => {
      seedCase(db, 'z1', { dueAt: T + 86_400 * 3, followUpAt: T + 86_400 })
      expect(collectDecisionPackage(db, 'personal', 'z1').deadline)
        .toEqual({ at: T + 86_400 * 3, kind: 'due' })
    })

    it('a follow-up alone is reported as a reminder, not a deadline', () => {
      seedCase(db, 'z2', { followUpAt: T + 86_400 })
      expect(collectDecisionPackage(db, 'personal', 'z2').deadline?.kind).toBe('follow_up')
    })

    it('no date is null, not a guess', () => {
      seedCase(db, 'z3')
      expect(collectDecisionPackage(db, 'personal', 'z3').deadline).toBeNull()
    })

    it('the wording carries the urgency a bare date does not', () => {
      expect(formatDeadline({ at: T + 86_400 * 2, kind: 'due' }, T)).toMatch(/Határidő.*2 nap múlva/)
      expect(formatDeadline({ at: T + 86_400, kind: 'due' }, T)).toMatch(/holnap/)
      expect(formatDeadline({ at: T - 86_400 * 3, kind: 'due' }, T)).toMatch(/3 napja lejárt/)
      expect(formatDeadline({ at: T, kind: 'follow_up' }, T)).toMatch(/Emlékeztető.*ma/)
    })
  })
})

// ── The composed question ─────────────────────────────────────────────────

const PACKET: ReaderEvidencePacket = {
  caseId: 'q1', domain: 'personal',
  readSources: ['email:1'], unreadableSources: [],
  facts: [{ statement: 'Az ügyvéd elküldte a szerződéstervezetet.', sourceRef: 'email:1' }] as never,
  missingRequirements: [{ what: 'jóváhagyás a 3. pontra', whoHasIt: 'István', why: 'ez zárja le az ügyet' }] as never,
  ballHolder: 'ISTVAN', candidateDecision: 'REQUEST_DECISION', confidence: 0.8, uncertainty: [],
}

const PLAN: EvidencePlan = {
  steps: [{ step: 1, label: 'jóváhagyás bekérése', kind: 'ASK_OWNER', evidenceRefs: ['email:1'], needsExternal: false, blockedBy: 'István' }],
  nextBestAction: null, rationale: 'teszt',
}

describe('§20 — the question carries all seven elements', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('without a package the question is exactly what it was', () => {
    const q = buildOwnerQuestion({ caseId: 'q1', domain: 'personal', title: 'Szerződés', packet: PACKET, plan: PLAN })
    expect(q).not.toBeNull()
    expect(q?.text).not.toMatch(/Amit eddig elintéztem/)
    expect(q?.text).not.toMatch(/Javaslatom/)
  })

  it('with one, all seven are on the page', () => {
    const q = buildOwnerQuestion({
      caseId: 'q1', domain: 'personal', title: 'Szerződés', packet: PACKET, plan: PLAN, now: T,
      pkg: {
        handled: ['Tervet készítettem a lezáráshoz', 'Kiküldtem 1 levelet az ügyben'],
        stoppedBecause: 'döntést kell hozni, ami nem az enyém',
        options: ['„igen" — csináljam így', '„nem" — ne ezt csináljam'],
        recommendation: 'Fogadd el a 3. pontot a jelenlegi szövegezéssel',
        deadline: { at: T + 86_400 * 2, kind: 'due' },
      },
    })
    const t = q?.text ?? ''
    expect(t).toMatch(/Szerződés/)                        // 1. mi az ügy
    expect(t).toMatch(/Amit eddig elintéztem/)            // 2. mit intézett
    expect(t).toMatch(/Miért állt meg/)                   // 3. miért állt meg
    expect(t).toMatch(/Válaszolhatsz/)                    // 4. opciók
    expect(t).toMatch(/Javaslatom/)                       // 5. mit javasol
    expect(t).toMatch(/Ami Tőled kell/)                   // 6. mi kell tőle
    expect(t).toMatch(/Határidő.*2 nap múlva/)            // 7. meddig
  })

  it('an element with no source produces no empty heading', () => {
    const q = buildOwnerQuestion({
      caseId: 'q1', domain: 'personal', title: 'Szerződés', packet: PACKET, plan: PLAN, now: T,
      pkg: { handled: [], stoppedBecause: null, options: [], recommendation: null, deadline: null },
    })
    const t = q?.text ?? ''
    expect(t).not.toMatch(/Amit eddig elintéztem/)
    expect(t).not.toMatch(/Miért állt meg/)
    expect(t).not.toMatch(/Válaszolhatsz/)
    expect(t).not.toMatch(/Határidő/)
  })

  // THE HASH IS THE IDENTITY OF THE ASK, AND §20 MUST NOT CHANGE THAT.
  //
  // The first version of this change put the recommendation into the hash, on
  // the reasoning that "Javaslatom: X" and "Javaslatom: Y" are different
  // questions. The regression test below is why that reasoning lost: a changed
  // hash makes `replacesOwn` true, which exempts the question from BOTH the
  // six-hour cooldown and the outstanding ceiling.
  it('NOTHING in the Decision Package changes the question\'s identity', () => {
    const base = { caseId: 'q1', domain: 'personal', title: 'Szerződés', packet: PACKET, plan: PLAN, now: T }
    const empty = { handled: [], stoppedBecause: null, options: [], recommendation: null, deadline: null }
    const a = buildOwnerQuestion({ ...base, pkg: empty })
    const full = buildOwnerQuestion({
      ...base,
      pkg: {
        handled: ['Kiküldtem 1 levelet az ügyben'],
        stoppedBecause: 'döntést kell hozni, ami nem az enyém',
        options: ['„igen"'], recommendation: 'Fogadd el a 3. pontot',
        deadline: { at: T + 500, kind: 'due' as const },
      },
    })
    expect(full?.hash).toBe(a?.hash)
    // …but the TEXT does change, which is the whole point of §20.
    expect(full?.text).not.toBe(a?.text)
  })
})

// ── The regression the Decision Package nearly caused ─────────────────────
//
// MEASURED, NOT REASONED. With the recommendation in the question hash, one case
// sent FOUR questions in thirty minutes with its reading completely unchanged —
// because the next best action is re-planned whenever the case's status moves,
// and a changed hash bypasses the cooldown by looking like a rewording.
//
// That is the failure ASK_COOLDOWN_SEC was built for, live on 2026-08-11: "ONE
// case produced THREE questions in twenty minutes." §20 re-opened it through a
// new door within the hour, and this is the door closed.

describe('§20 does not re-open the ask-storm the cooldown closed', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('a re-planned recommendation does NOT produce a second question', () => {
    seedCase(db, 'storm')
    seedState(db, 'storm', { description: 'Kérd be az árajánlatot', canProceedAutonomously: false })
    db.prepare(
      `INSERT INTO case_evidence_packets (case_id, domain, packet_json, plan_json, created_at)
       VALUES ('storm', 'personal', ?, ?, ?)`,
    ).run(JSON.stringify({ ...PACKET, caseId: 'storm' }), JSON.stringify(PLAN), T)

    const proposals = [
      'Kérd be az árajánlatot',
      'Kérd be a pontosított árajánlatot',
      'Vedd fel a kapcsolatot az ügyvéddel',
      'Kérj határidő-hosszabbítást',
    ]
    let asked = 0
    for (let i = 0; i < proposals.length; i++) {
      db.prepare(`UPDATE case_progression_state SET next_best_action_json = ? WHERE case_id = 'storm'`)
        .run(JSON.stringify({ description: proposals[i], canProceedAutonomously: false }))
      asked += askPendingOwnerQuestions(db, { now: T + i * 600, limit: 5 }).asked
    }

    expect(asked).toBe(1)
    const rows = db.prepare(`SELECT question_text FROM cos_owner_questions WHERE case_id = 'storm'`)
      .all() as Array<{ question_text: string }>
    expect(rows.length).toBe(1)

    // AND THE STORED TEXT IS CURRENT. Suppressing the notification must not
    // freeze the question at its first version — the dashboard and the eventual
    // answer would then be looking at a proposal the engine no longer makes.
    expect(rows[0].question_text).toMatch(/Javaslatom: Kérj határidő-hosszabbítást/)
  })

  // The suppression must not swallow a genuinely NEW ask. Change the reading —
  // which is what a real development does — and the question goes out.
  it('a changed ASK still reaches him', () => {
    seedCase(db, 'moved')
    seedState(db, 'moved', null)
    db.prepare(
      `INSERT INTO case_evidence_packets (case_id, domain, packet_json, plan_json, created_at)
       VALUES ('moved', 'personal', ?, ?, ?)`,
    ).run(JSON.stringify({ ...PACKET, caseId: 'moved' }), JSON.stringify(PLAN), T)
    expect(askPendingOwnerQuestions(db, { now: T, limit: 5 }).asked).toBe(1)

    db.prepare(
      `INSERT INTO case_evidence_packets (case_id, domain, packet_json, plan_json, created_at)
       VALUES ('moved', 'personal', ?, ?, ?)`,
    ).run(
      JSON.stringify({
        ...PACKET, caseId: 'moved',
        missingRequirements: [{ what: 'a NAV határozat másolata', whoHasIt: 'István', why: 'e nélkül nem megy tovább' }],
      }),
      JSON.stringify(PLAN), T + 600,
    )
    expect(askPendingOwnerQuestions(db, { now: T + 600, limit: 5 }).asked).toBe(1)
  })
})

// ── The caller ────────────────────────────────────────────────────────────
//
// Every round of this review found a mechanism with no production caller. This
// is the test that a Decision Package actually reaches Istvan rather than
// existing as a function somebody could have called.

describe('§20 — the sweep composes the package, it is not just available', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('askPendingOwnerQuestions sends a question carrying the new elements', () => {
    seedCase(db, 'live-1', { dueAt: T + 86_400 * 2 })
    seedState(db, 'live-1', { description: 'Fogadd el a 3. pontot', canProceedAutonomously: false })
    seedRun(db, 'live-1', 'REQUEST_DECISION')
    recordProgressionEvents(db, {
      domain: 'personal', caseId: 'live-1', caseVersion: 2, runId: 'r1', now: T,
      decision: 'REQUEST_DECISION', previousDecision: null,
      planVersion: 1, previousPlanVersion: null,
      goalDefined: true, semanticStatus: null, previousSemanticStatus: null,
    })
    db.prepare(
      `INSERT INTO case_evidence_packets (case_id, domain, packet_json, plan_json, created_at)
       VALUES ('live-1', 'personal', ?, ?, ?)`,
    ).run(JSON.stringify({ ...PACKET, caseId: 'live-1' }), JSON.stringify(PLAN), T)

    const r = askPendingOwnerQuestions(db, { now: T, limit: 5 })
    expect(r.asked).toBe(1)

    const sent = db.prepare(
      `SELECT question_text FROM cos_owner_questions WHERE case_id = 'live-1'`,
    ).get() as { question_text: string }
    expect(sent.question_text).toMatch(/Amit eddig elintéztem/)
    expect(sent.question_text).toMatch(/Miért állt meg: döntést kell hozni/)
    expect(sent.question_text).toMatch(/Javaslatom: Fogadd el a 3\. pontot/)
    expect(sent.question_text).toMatch(/Válaszolhatsz/)
    expect(sent.question_text).toMatch(/Határidő.*2 nap múlva/)
  })
})
