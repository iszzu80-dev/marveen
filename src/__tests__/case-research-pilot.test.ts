import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  sanctionResearchQuery, researchEligibility, recordResearchResult, pilotMetrics,
  looksSecretShaped, scopeOf, PILOT_REQUIRED_FIELDS, RESEARCHABLE_TIERS,
  ResearchAuthorizationError, type ResearchCase,
} from '../cos/research/case-research.js'

// PHASE 3 (P3-B) -- case-level web research, limited pilot.
//
// Owner ruling 2026-09-01. The clauses, and where each is defended:
//   LOW/NORMAL only, UNKNOWN -> no research  -> "the tier gate"
//   minimum necessary, never the case text   -> "what may leave"
//   durable evidence per query               -> "the ledger"
//   sensitivity gate fail-closed             -> "each guard alone"
//   research cannot authorize anything       -> "a result is evidence"
//   cost measurable                          -> "the numbers before it widens"

const NOW = 1_800_000_000

const c = (over: Partial<ResearchCase> = {}): ResearchCase => ({
  namespace: 'personal', caseId: 'p1', title: 'Kerekpar szerviz arak Budapesten',
  description: 'From: info@bikeshop.hu', caseType: 'SHOPPING',
  declaredSensitivity: 'PUBLIC', status: 'READY', ...over,
})

describe('THE TIER GATE -- low and normal only, and unknown means no', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('PUBLIC and PERSONAL are the whole allowlist', () => {
    expect([...RESEARCHABLE_TIERS].sort()).toEqual(['PERSONAL', 'PUBLIC'])
  })

  it('a sensitive case is refused before a query is built', () => {
    const r = sanctionResearchQuery(getDb(), c({ declaredSensitivity: 'SENSITIVE_PERSONAL' }), 'arak', NOW)
    expect(r.status).toBe('REFUSED')
    expect(r.query).toBeNull()
    expect(r.reason).toContain('outside the pilot')
  })

  it('an UNKNOWN tier is not a gap -- it arrives as the most sensitive one', () => {
    const r = sanctionResearchQuery(getDb(), c({ declaredSensitivity: undefined }), 'arak', NOW)
    expect(r.status).toBe('REFUSED')
    expect(r.sensitivity).toBe('HIGHLY_SENSITIVE')
  })

  it('a case DECLARED public whose content is not gets escalated, not believed', () => {
    // The failure this closes: reading the declared column alone would let a
    // case somebody marked PUBLIC through on the strength of the label.
    const e = researchEligibility(c({
      declaredSensitivity: 'PUBLIC',
      description: 'A TAJ szama 123 456 789 es a lelet szerint cukorbeteg.',
    }))
    expect(e.eligible).toBe(false)
    expect(e.sensitivity).not.toBe('PUBLIC')
  })

  it('the scope is an allowlist, so an unlisted case type is out by default', () => {
    expect(scopeOf('SHOPPING')).toBe('PRODUCT_PRICE_COMMERCIAL')
    expect(scopeOf('CONTRACT')).toBeNull()
    expect(scopeOf('A_CASE_TYPE_INVENTED_NEXT_YEAR')).toBeNull()
    const r = sanctionResearchQuery(getDb(), c({ caseType: 'INVOICE_INCOMING' }), 'x', NOW)
    expect(r.status).toBe('REFUSED')
    expect(r.reason).toContain('allowlist')
  })
})

describe('WHAT MAY LEAVE -- minimum necessary, and never the case text', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the pilot asks for three field kinds, and none of them is a body', () => {
    expect([...PILOT_REQUIRED_FIELDS]).toEqual(['SUBJECT', 'LANGUAGE', 'SENDER_ROLE_OR_DOMAIN'])
    expect(PILOT_REQUIRED_FIELDS).not.toContain('BODY_FULL')
    expect(PILOT_REQUIRED_FIELDS).not.toContain('BODY_EXCERPT')
    expect(PILOT_REQUIRED_FIELDS).not.toContain('AMOUNT')
    expect(PILOT_REQUIRED_FIELDS).not.toContain('ACCOUNT_IDENTIFIER')
  })

  it('THE GATE RELEASES NOTHING CASE-DERIVED TO A SEARCH ENGINE, so the query is refused', () => {
    // The measured consequence of routing this through the real egress gate
    // instead of a bespoke rule: an UNKNOWN_UNTRUSTED destination may receive
    // nothing at the case's tier, whatever the field is. What survives is the
    // language code the caller tagged PUBLIC and the engine's own words -- a
    // query with no term from the case. Sending it would be activity without
    // research, so the pilot refuses and says why.
    const r = sanctionResearchQuery(
      getDb(),
      c({ description: 'From: info@bikeshop.hu\nKerdeztem mar telefonon is, nem vettek fel.' }),
      'nyitvatartas', NOW,
    )
    expect(r.status).toBe('REFUSED')
    expect(r.reason).toContain('released no case-derived field')
    expect(r.query).toBeNull()
  })

  it('and nothing from the case body ever reaches a stored query', () => {
    const rows = getDb().prepare('SELECT query FROM case_research_queries').all() as Array<{ query: string | null }>
    for (const row of rows) {
      expect(row.query ?? '').not.toContain('Kerdeztem')
      expect(row.query ?? '').not.toContain('Kossuth')
    }
  })

  it('and a description that carries an address and a phone is not filtered -- it is REFUSED', () => {
    // The stronger outcome, and the one the escalation rule produces: the case
    // does not get a carefully trimmed query, it gets no query at all, because
    // the content pushed the effective tier past the pilot. "Nothing leaked"
    // and "nothing was sent" are different guarantees and this is the second.
    const r = sanctionResearchQuery(
      getDb(),
      c({ description: 'From: info@bikeshop.hu\nA lakcimem Kossuth utca 3, hivj a 06301234567 szamon.' }),
      'nyitvatartas', NOW,
    )
    expect(r.status).toBe('REFUSED')
    expect(r.sensitivity).toBe('SENSITIVE_PERSONAL')
    expect(r.query).toBeNull()
  })

  it('the ledger records exactly which field kinds left', () => {
    // skipGate ONLY here, to reach the SANCTIONED branch and inspect the ledger
    // shape. The gate's real verdict on a search engine is the test above.
    const r = sanctionResearchQuery(getDb(), c(), 'arak', NOW, 'websearch', { skipGate: true })
    const row = getDb().prepare('SELECT * FROM case_research_queries WHERE ticket_id=?').get(r.ticketId) as Record<string, unknown>
    expect(JSON.parse(String(row.disclosed_fields)).length).toBeGreaterThan(0)
    expect(row.query).toBe(r.query)
    expect(row.disclosure_record_id).toBeTruthy()
    // PERSONAL, not PUBLIC: the sender address in the description escalates the
    // tier, which is the gate working. PERSONAL is still inside the pilot.
    expect(row.sensitivity).toBe('PERSONAL')
    expect(row.provider).toBe('websearch')
  })

  it('the disclosure gate writes its own record even when the query is refused', () => {
    // The refusal happens BECAUSE of the gate, so the gate's reasoning must be
    // on file: a refusal with no record would leave "why did nothing go out"
    // unanswerable.
    sanctionResearchQuery(getDb(), c(), 'arak', NOW)
    const d = getDb().prepare(
      'SELECT * FROM cos_disclosure_records ORDER BY at DESC LIMIT 1',
    ).get() as Record<string, unknown>
    expect(d).toBeTruthy()
    expect(d.destination).toBe('web:websearch')
    expect(d.trust_class).toBe('UNKNOWN_UNTRUSTED')
    expect(d.any_denied).toBe(1)
  })
})

describe('EACH GUARD ALONE -- three fences, none of them leaning on the others', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('GUARD 1 refuses on its own, before anything is assembled', () => {
    const r = sanctionResearchQuery(getDb(), c({ caseType: 'CONTRACT' }), 'x', NOW)
    expect(r.status).toBe('REFUSED')
  })

  it('GUARD 2 refuses on its own, with eligibility switched off', () => {
    // Eligibility disabled, so guard 1 cannot be the reason. The gate still
    // denies every case-derived field to an untrusted destination, and the
    // refusal names the gate rather than the tier.
    const r = sanctionResearchQuery(
      getDb(), c({ caseType: 'CONTRACT', title: 'Nyitvatartas' }), 'mikor', NOW, 'websearch',
      { skipEligibility: true },
    )
    expect(r.status).toBe('REFUSED')
    expect(r.reason).toContain('released no case-derived field')
    expect(r.reason).not.toContain('allowlist')
  })

  it('GUARD 3 fires when the first two are switched off -- and it is not decorative', () => {
    const r = sanctionResearchQuery(
      getDb(),
      c({ title: 'a kulcs sk_live_abcdefghijklmnop', caseType: 'CONTRACT', declaredSensitivity: 'HIGHLY_SENSITIVE' }),
      'mi ez', NOW, 'websearch',
      { skipEligibility: true, skipGate: true },
    )
    expect(r.status).toBe('REFUSED')
    expect(r.reason).toContain('secret-shaped')
  })

  it('the sweep knows shapes, not a list of strings somebody saw leak', () => {
    expect(looksSecretShaped('ghp_aaaaaaaaaaaaaaaaaaaa')).toBeTruthy()
    expect(looksSecretShaped('4111 1111 1111 1111')).toBeTruthy()
    expect(looksSecretShaped('HU42117730161111101800000000')).toBeTruthy()
    expect(looksSecretShaped('password: hunter2')).toBeTruthy()
    expect(looksSecretShaped('nyitvatartas budapest bikeshop.hu')).toBeNull()
  })
})

describe('A REFUSAL IS RECORDED, BECAUSE AN UNMEASURED FAIL-CLOSED IS A CLAIM', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the refused query gets a ledger row with its reason', () => {
    const r = sanctionResearchQuery(getDb(), c({ caseType: 'CONTRACT' }), 'x', NOW)
    const row = getDb().prepare('SELECT * FROM case_research_queries WHERE ticket_id=?').get(r.ticketId) as Record<string, unknown>
    expect(row.status).toBe('REFUSED')
    expect(String(row.refused_reason)).toContain('allowlist')
    expect(row.query).toBeNull()
  })

  it('and the metrics can count how often the gate actually fired', () => {
    sanctionResearchQuery(getDb(), c({ caseId: 'a', caseType: 'CONTRACT' }), 'x', NOW)
    sanctionResearchQuery(getDb(), c({ caseId: 'b', declaredSensitivity: 'HIGHLY_SENSITIVE' }), 'x', NOW + 1)
    sanctionResearchQuery(getDb(), c({ caseId: 'd' }), 'x', NOW + 2, 'websearch', { skipGate: true })
    const m = pilotMetrics(getDb())
    expect(m.refused).toBe(2)
    expect(m.sanctioned).toBe(1)
    expect(Object.keys(m.refusedByReason).length).toBe(2)
  })
})

describe('A RESULT IS EVIDENCE, NEVER PERMISSION', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('an answer with no provenance is recorded as NO_RESULT, not as knowledge', () => {
    const r = sanctionResearchQuery(getDb(), c(), 'arak', NOW, 'websearch', { skipGate: true })
    recordResearchResult(getDb(), r.ticketId, {
      kind: 'EVIDENCE', provenance: [], latencyMs: 900, changedSurface: false,
    }, NOW + 5)
    const row = getDb().prepare('SELECT * FROM case_research_queries WHERE ticket_id=?').get(r.ticketId) as Record<string, unknown>
    expect(row.result_kind).toBe('NO_RESULT')
  })

  it('a result cannot be attached to a query that was never sanctioned', () => {
    const r = sanctionResearchQuery(getDb(), c({ caseType: 'CONTRACT' }), 'x', NOW)
    expect(() => recordResearchResult(getDb(), r.ticketId, {
      kind: 'EVIDENCE', provenance: ['https://example.com'], latencyMs: 10, changedSurface: true,
    })).toThrow(ResearchAuthorizationError)
  })

  it('recording a result writes no case fact -- the case table is untouched', () => {
    getDb().prepare(
      `INSERT INTO personal_cases (case_id,title,case_type,status,created_at,updated_at)
       VALUES ('p1','x','SHOPPING','READY',?,?)`,
    ).run(NOW, NOW)
    const snap = () => JSON.stringify(getDb().prepare('SELECT * FROM personal_cases').all())
    const before = snap()
    const r = sanctionResearchQuery(getDb(), c(), 'arak', NOW, 'websearch', { skipGate: true })
    recordResearchResult(getDb(), r.ticketId, {
      kind: 'RECOMMENDATION', provenance: ['https://bikeshop.hu/arak'],
      latencyMs: 1200, costUsd: 0.002, changedSurface: true, note: 'published price list found',
    }, NOW + 5)
    expect(snap()).toBe(before)
  })
})

describe('THE NUMBERS THE OWNER ASKED FOR BEFORE IT WIDENS', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('queries per case, usefulness, latency, cost and what actually moved', () => {
    const a = sanctionResearchQuery(getDb(), c({ caseId: 'a' }), 'arak', NOW, 'websearch', { skipGate: true })
    const b = sanctionResearchQuery(getDb(), c({ caseId: 'b' }), 'nyitvatartas', NOW + 1, 'websearch', { skipGate: true })
    recordResearchResult(getDb(), a.ticketId, {
      kind: 'EVIDENCE', provenance: ['https://x/1'], latencyMs: 800, costUsd: 0.001, changedSurface: true,
    }, NOW + 10)
    recordResearchResult(getDb(), b.ticketId, {
      kind: 'EVIDENCE', provenance: [], latencyMs: 1600, costUsd: 0.001, changedSurface: false,
    }, NOW + 11)
    const m = pilotMetrics(getDb())
    expect(m.cases).toBe(2)
    expect(m.executed).toBe(2)
    expect(m.withResult).toBe(1)
    expect(m.noResult).toBe(1)
    expect(m.changedSurface).toBe(1)
    expect(m.medianLatencyMs).not.toBeNull()
    expect(m.totalCostUsd).toBeCloseTo(0.002, 6)
  })
})
