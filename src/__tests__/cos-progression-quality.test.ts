// §4.2 — the semantic-quality metrics.
//
// THESE TESTS ASSERT THE DEFINITIONS, NOT THE NUMBERS. Every one of these six
// metrics could be computed three defensible ways, and the one a reader assumes
// is rarely the one the code chose. So each test builds a state whose answer is
// obvious by hand — three cases, two sentences between them — and requires the
// number that definition produces. A test written against "whatever it returns
// today" would let the definition drift into whichever reading flatters the
// current state, which is the exact failure §4.2 exists to catch.

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

import { initDatabase, getDb } from '../db.js'
import {
  semanticQualityMetrics, qualityConcerns, QUALITY_THRESHOLDS,
} from '../cos/progression-quality.js'

const T = 1_770_000_000

function freshDb(): Database.Database {
  initDatabase(':memory:')
  return getDb()
}

interface Seed {
  nba?: { description?: string; kind?: string } | null
  plan?: Array<{ step: number; evidenceRefs: string[] }> | null
  provenance?: 'CASE_SPECIFIC' | 'GENERIC_STATUS_TEMPLATE' | null
  planVersion?: number
  status?: string
  packets?: number
}

function seed(db: Database.Database, caseId: string, s: Seed = {}): void {
  db.prepare(
    `INSERT INTO personal_cases (case_id, title, case_type, status, sensitivity, version, created_at, updated_at)
     VALUES (?, 'Teszt ügy', 'ADMIN', ?, 'PERSONAL', 1, ?, ?)`,
  ).run(caseId, s.status ?? 'TRIAGE', T, T)
  db.prepare(
    `INSERT INTO case_progression_state
       (domain, case_id, progression_enabled, progression_mode,
        next_best_action_json, rolling_plan_json, dod_verification_json,
        plan_version, created_at, updated_at)
     VALUES ('personal', ?, 1, 'shadow', ?, ?, ?, ?, ?, ?)`,
  ).run(
    caseId,
    s.nba === undefined || s.nba === null ? null : JSON.stringify(s.nba),
    s.plan === undefined || s.plan === null ? null : JSON.stringify(s.plan),
    s.provenance ? JSON.stringify({ provenance: s.provenance, criteria: [] }) : null,
    s.planVersion ?? 1, T, T,
  )
  for (let i = 0; i < (s.packets ?? 0); i++) {
    db.prepare(
      `INSERT INTO case_evidence_packets (case_id, domain, packet_json, created_at)
       VALUES (?, 'personal', '{}', ?)`,
    ).run(caseId, T + i)
  }
}

describe('§4.2 — semantic quality metrics', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('an empty store reports zeroes, not NaN', () => {
    const m = semanticQualityMetrics(db, 'personal')
    expect(m.sampleSize).toBe(0)
    for (const v of Object.values(m)) expect(Number.isFinite(v)).toBe(true)
    expect(qualityConcerns(m)).toEqual([])
  })

  describe('distinct_value_ratio', () => {
    it('every case with its own sentence is 1.0', () => {
      seed(db, 'a1', { nba: { description: 'Kérj árajánlatot', kind: 'OBTAIN' } })
      seed(db, 'a2', { nba: { description: 'Hívd fel a bankot', kind: 'EXECUTE' } })
      expect(semanticQualityMetrics(db, 'personal').distinctValueRatio).toBe(1)
    })

    // THE LIVE SHAPE. 101 cases, 11 distinct values: the metric's whole reason
    // for existing is that the dashboards said "populated" throughout.
    it('four cases sharing one sentence is 0.25', () => {
      for (const id of ['b1', 'b2', 'b3', 'b4']) {
        seed(db, id, { nba: { description: 'Következő lépés meghatározása', kind: 'OBTAIN' } })
      }
      expect(semanticQualityMetrics(db, 'personal').distinctValueRatio).toBe(0.25)
    })

    it('a case with NO next best action is not counted as a distinct one', () => {
      seed(db, 'c1', { nba: { description: 'Kérj árajánlatot', kind: 'OBTAIN' } })
      seed(db, 'c2', { nba: null })
      // 1 distinct over 1 case that HAS one — not 1 over 2. A missing value is a
      // different defect and must not read as diversity.
      expect(semanticQualityMetrics(db, 'personal').distinctValueRatio).toBe(1)
    })
  })

  describe('template_reuse_rate', () => {
    // The reason this is not simply 1 − distinctValueRatio: a value shared by
    // two cases and a value shared by sixty are one distinct value each.
    it('counts CASES on a shared sentence, not the sentences', () => {
      seed(db, 'd1', { nba: { description: 'közös', kind: 'OBTAIN' } })
      seed(db, 'd2', { nba: { description: 'közös', kind: 'OBTAIN' } })
      seed(db, 'd3', { nba: { description: 'közös', kind: 'OBTAIN' } })
      seed(db, 'd4', { nba: { description: 'saját', kind: 'OBTAIN' } })
      const m = semanticQualityMetrics(db, 'personal')
      expect(m.templateReuseRate).toBe(0.75)      // 3 of 4 cases share a sentence
      expect(m.distinctValueRatio).toBe(0.5)      // but there are 2 distinct ones
    })

    it('all-distinct is 0', () => {
      seed(db, 'e1', { nba: { description: 'egy', kind: 'OBTAIN' } })
      seed(db, 'e2', { nba: { description: 'kettő', kind: 'OBTAIN' } })
      expect(semanticQualityMetrics(db, 'personal').templateReuseRate).toBe(0)
    })
  })

  describe('case_specificity_score', () => {
    it('reads the RECORDED provenance rather than guessing', () => {
      seed(db, 'f1', { provenance: 'CASE_SPECIFIC' })
      seed(db, 'f2', { provenance: 'GENERIC_STATUS_TEMPLATE' })
      seed(db, 'f3', { provenance: 'GENERIC_STATUS_TEMPLATE' })
      expect(semanticQualityMetrics(db, 'personal').caseSpecificityScore).toBeCloseTo(1 / 3, 5)
    })

    it('a case with no DoD at all is outside the denominator', () => {
      seed(db, 'g1', { provenance: 'CASE_SPECIFIC' })
      seed(db, 'g2', { provenance: null })
      expect(semanticQualityMetrics(db, 'personal').caseSpecificityScore).toBe(1)
    })
  })

  describe('next_action_executability', () => {
    it('an actionable kind with text counts', () => {
      seed(db, 'h1', { nba: { description: 'Kérd be a számlát', kind: 'OBTAIN' } })
      expect(semanticQualityMetrics(db, 'personal').nextActionExecutability).toBe(1)
    })

    // WAITING IS THE ABSENCE OF AN ACTION. Counting it as executable is how a
    // queue of blocked cases reports as a healthy pipeline.
    it('AWAIT_EXTERNAL does not count', () => {
      seed(db, 'i1', { nba: { description: 'Várunk a bankra', kind: 'AWAIT_EXTERNAL' } })
      expect(semanticQualityMetrics(db, 'personal').nextActionExecutability).toBe(0)
    })

    it('an empty description does not count whatever the kind says', () => {
      seed(db, 'j1', { nba: { description: '   ', kind: 'EXECUTE' } })
      const m = semanticQualityMetrics(db, 'personal')
      expect(m.nextActionExecutability).toBe(0)
    })
  })

  describe('plan_step_evidence_linkage', () => {
    // Over STEPS, not over cases: a case with one linked step and a case with
    // six are not equally evidence-grounded.
    it('measures steps, not cases', () => {
      seed(db, 'k1', { plan: [{ step: 1, evidenceRefs: ['email:1'] }] })
      seed(db, 'k2', {
        plan: [
          { step: 1, evidenceRefs: [] }, { step: 2, evidenceRefs: [] },
          { step: 3, evidenceRefs: [] },
        ],
      })
      // 1 linked of 4 steps — not "one case of two is fully linked".
      expect(semanticQualityMetrics(db, 'personal').planStepEvidenceLinkage).toBe(0.25)
    })

    it('no plans at all is 0, not a division by zero', () => {
      seed(db, 'l1', { plan: null })
      expect(semanticQualityMetrics(db, 'personal').planStepEvidenceLinkage).toBe(0)
    })
  })

  describe('replan_on_new_evidence_rate', () => {
    // Only cases that GOT new evidence can be asked whether they re-planned; the
    // first packet produced the first plan.
    it('a case read once is outside the denominator', () => {
      seed(db, 'm1', { packets: 1, planVersion: 1 })
      const m = semanticQualityMetrics(db, 'personal')
      expect(m.replanDenominator).toBe(0)
      expect(m.replanOnNewEvidenceRate).toBe(0)
    })

    it('read twice and never re-planned is 0 over 1', () => {
      seed(db, 'n1', { packets: 2, planVersion: 1 })
      const m = semanticQualityMetrics(db, 'personal')
      expect(m.replanDenominator).toBe(1)
      expect(m.replanOnNewEvidenceRate).toBe(0)
    })

    it('read twice and re-planned is 1 over 1', () => {
      seed(db, 'o1', { packets: 2, planVersion: 3 })
      const m = semanticQualityMetrics(db, 'personal')
      expect(m.replanDenominator).toBe(1)
      expect(m.replanOnNewEvidenceRate).toBe(1)
    })
  })

  // A CLOSED CASE'S PLAN IS HISTORY. Including terminal cases means the score
  // improves every time something closes, and a metric that rewards the passage
  // of time is not measuring quality.
  it('terminal cases are excluded', () => {
    seed(db, 'p1', { nba: { description: 'egyedi', kind: 'OBTAIN' }, status: 'TRIAGE' })
    for (const id of ['p2', 'p3', 'p4']) {
      seed(db, id, { nba: { description: 'sablon', kind: 'OBTAIN' }, status: 'COMPLETED' })
    }
    const m = semanticQualityMetrics(db, 'personal')
    expect(m.sampleSize).toBe(1)
    expect(m.distinctValueRatio).toBe(1)
  })

  describe('the concerns are what make the numbers readable', () => {
    it('the live 2026-08 shape trips distinct_value_ratio and template_reuse_rate', () => {
      for (let i = 0; i < 10; i++) {
        seed(db, `q${i}`, {
          nba: { description: 'Következő lépés meghatározása', kind: 'OBTAIN' },
          provenance: 'GENERIC_STATUS_TEMPLATE',
        })
      }
      const concerns = qualityConcerns(semanticQualityMetrics(db, 'personal'))
      expect(concerns.join('\n')).toMatch(/distinct_value_ratio/)
      expect(concerns.join('\n')).toMatch(/template_reuse_rate/)
      expect(concerns.join('\n')).toMatch(/case_specificity_score/)
    })

    it('a healthy store raises none of them', () => {
      for (let i = 0; i < 5; i++) {
        seed(db, `r${i}`, {
          nba: { description: `Egyedi lépés ${i}`, kind: 'OBTAIN' },
          plan: [{ step: 1, evidenceRefs: [`email:${i}`] }],
          provenance: 'CASE_SPECIFIC',
        })
      }
      expect(qualityConcerns(semanticQualityMetrics(db, 'personal'))).toEqual([])
    })

    it('template_reuse_rate is a CEILING, and is compared as one', () => {
      // Two cases, one shared sentence -> reuse 1.0, which is ABOVE the
      // threshold and therefore a concern. A metric compared in the wrong
      // direction is silently always-green, which is worse than absent.
      seed(db, 's1', { nba: { description: 'közös', kind: 'OBTAIN' } })
      seed(db, 's2', { nba: { description: 'közös', kind: 'OBTAIN' } })
      const m = semanticQualityMetrics(db, 'personal')
      expect(m.templateReuseRate).toBeGreaterThan(QUALITY_THRESHOLDS.templateReuseRate)
      expect(qualityConcerns(m).join('\n')).toMatch(/template_reuse_rate/)
    })
  })
})
