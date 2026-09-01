import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  sanctionResearchQuery, researchEligibility, recordResearchResult, pilotMetrics,
  looksSecretShaped, scopeOf, PILOT_REQUIRED_FIELDS, RESEARCHABLE_TIERS, RESEARCH_INTENTS,
  ResearchAuthorizationError, type ResearchCase,
} from '../cos/research/case-research.js'
import { publicVendorIdentifier } from '../cos/research/public-identifier.js'
import { excludedTopicOf, EXCLUDED_TOPICS } from '../cos/research/topic-exclusion.js'

// PHASE 3 (P3-B) -- case-level web research, limited pilot, under the owner's
// policy of 2026-09-01.
//
//   public vendor domain may go out, narrowly  -> "what may leave"
//   ZST_INTERNAL normalised, never loosened    -> "the tier is translated"
//   the classifier may only tighten            -> "the subject, not the tier"
//   UNKNOWN / HIGH still refuse                -> "fail-closed"
//   durable provenance per query               -> "the ledger"
//   research authorizes nothing                -> "a result is evidence"

const NOW = 1_800_000_000

const c = (over: Partial<ResearchCase> = {}): ResearchCase => ({
  namespace: 'personal', caseId: 'p1', title: 'Kerekpar szerviz',
  description: 'From: info@bikeshop.hu', caseType: 'SHOPPING',
  declaredSensitivity: 'PUBLIC', status: 'READY', ...over,
})

describe('WHAT IS A PUBLIC IDENTIFIER, AND WHAT ONLY LOOKS LIKE ONE', () => {
  it('a registrable root is one', () => {
    expect(publicVendorIdentifier('info@bikeshop.hu').value).toBe('bikeshop.hu')
    expect(publicVendorIdentifier('www.acme.co.uk').value).toBe('acme.co.uk')
  })

  it('a customer-specific host is REFUSED, not quietly reduced to its root', () => {
    // Reducing would turn "the portal we were handed" into "the vendor's public
    // site" and lose the distinction the policy draws.
    for (const h of ['portal.acme.com', 'my.acme.com', 'acme-1234567.vendor.com', 'tenant.acme.com']) {
      const v = publicVendorIdentifier(h)
      expect(v.ok).toBe(false)
      expect(v.value).toBeNull()
    }
  })

  it('AND SO IS A PLAIN SUBDOMAIN, with no suspicious label at all', () => {
    // The mutation run found this gap: every subdomain case above also trips the
    // customer-specific WORD list or the digit rule, so disarming the general
    // "a subdomain is not automatically public" rule changed nothing and the
    // mutant survived. `sales.acme.com` can only be refused by that rule.
    const v = publicVendorIdentifier('sales.acme.com')
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('subdomain')
  })

  it('a URL, a path, a query string, a port or an IP is refused', () => {
    for (const h of ['https://acme.com', 'acme.com/u/42', 'acme.com?token=abc', 'acme.com:8443', '10.0.0.1']) {
      expect(publicVendorIdentifier(h).ok).toBe(false)
    }
  })

  it('free mail is refused: it identifies a person, not a vendor', () => {
    expect(publicVendorIdentifier('someone@gmail.com').ok).toBe(false)
    expect(publicVendorIdentifier('x@freemail.hu').reason).toContain('free mail')
  })

  it('AN AUTHORITY ROOT is refused by the authority rule, not by anything else', () => {
    // Same gap, other rule: `tarhely.gov.hu` is ALSO a subdomain, so the
    // authority check could be disarmed and the test would still pass. A bare
    // authority root can only be refused by the authority rule.
    const bare = publicVendorIdentifier('info@kormany.hu')
    expect(bare.ok).toBe(false)
    expect(bare.reason).toContain('authority')
    expect(publicVendorIdentifier('ertesites@tarhely.gov.hu').ok).toBe(false)
  })

  it('every refusal says why -- a refusal that cannot is not a decision', () => {
    for (const h of ['', 'nodomain', 'acme.com/x', 'portal.acme.com']) {
      expect(publicVendorIdentifier(h).reason.length).toBeGreaterThan(0)
    }
  })
})

describe('THE SUBJECT, NOT THE TIER -- the classifier may only tighten', () => {
  it('the owner named eight classes and all eight are wired', () => {
    expect(new Set(EXCLUDED_TOPICS).size).toBe(8)
  })

  it('legal, financial, contract, security, credentials, personal, HR, commercial', () => {
    expect(excludedTopicOf('NAV vegrehajtas irat')!.topic).toBe('LEGAL_OR_AUTHORITY')
    expect(excludedTopicOf('a szamla fizetesi hatarideje')!.topic).toBe('FINANCIAL_BANKING_PAYMENT')
    expect(excludedTopicOf('a szerzodes 4. pontja')!.topic).toBe('CONTRACT')
    expect(excludedTopicOf('suspicious sign-in detected')!.topic).toBe('SECURITY')
    expect(excludedTopicOf('itt az api_key')!.topic).toBe('CREDENTIALS_OR_SECRETS')
    expect(excludedTopicOf('a TAJ szama')!.topic).toBe('PERSONAL_DATA')
    expect(excludedTopicOf('munkaszerzodes tervezet')!.topic).toBe('HR_PERSONNEL')
    expect(excludedTopicOf('bizalmas arres adatok')!.topic).toBe('CONFIDENTIAL_COMMERCIAL')
  })

  it('and it never lets anything IN -- an ordinary subject returns null', () => {
    expect(excludedTopicOf('mikor van nyitva a bolt')).toBeNull()
  })
})

describe('THE TIER IS TRANSLATED, NOT COERCED -- and translation is not permission', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('ZST_INTERNAL normalises into the canonical vocabulary instead of failing to the top', () => {
    // Before the owner's ruling this was HIGHLY_SENSITIVE and the whole corporate
    // namespace was out of the pilot for a vocabulary reason dressed as a policy.
    const e = researchEligibility(c({
      namespace: 'zst', declaredSensitivity: 'ZST_INTERNAL', caseType: 'VENDOR',
      title: 'AWS szolgaltatas allapot', description: 'a szolgaltatas akadozik',
    }))
    expect(e.sensitivity).toBe('PERSONAL')
    expect(e.declaredRaw).toBe('ZST_INTERNAL')      // the source survives the translation
    expect(e.eligible).toBe(true)
  })

  it('AND THE TIGHTENING IS REAL: the intake From: line alone lifts a ZST case out', () => {
    // MEASURED, and it is the finding that decided the pilot's shape. The
    // corporate content classifier reads an email address as ZST_PERSONAL_DATA,
    // which maps to HIGHLY_SENSITIVE. Every case the intake creates carries a
    // `From:` line, so on the corporate side that lifts ALL of them out.
    //
    // The two classifiers disagree about the same fact: the personal one calls
    // an address PERSONAL (inside the pilot), the corporate one calls it
    // PERSONAL_DATA (outside). That asymmetry is not worked around here --
    // loosening it is the owner's call, not a convenience the pilot may take.
    const withHeader = researchEligibility(c({
      namespace: 'zst', declaredSensitivity: 'ZST_INTERNAL', caseType: 'VENDOR',
      title: 'AWS szolgaltatas allapot', description: 'From: support@aws.amazon.com',
    }))
    expect(withHeader.sensitivity).toBe('HIGHLY_SENSITIVE')
    expect(withHeader.eligible).toBe(false)

    const personal = researchEligibility(c({ description: 'From: info@bikeshop.hu' }))
    expect(personal.sensitivity).toBe('PERSONAL')
    expect(personal.eligible).toBe(true)
  })

  it('but a NAV case on the same internal tier is still refused, by SUBJECT', () => {
    const e = researchEligibility(c({
      namespace: 'zst', declaredSensitivity: 'ZST_INTERNAL', caseType: 'VENDOR',
      title: 'NAV vegrehajtas irat a cegkapun', description: 'a hatarido kozeleg',
    }))
    expect(e.sensitivity).toBe('PERSONAL')          // the tier permits it
    expect(e.eligible).toBe(false)                  // and the subject does not
    expect(e.excludedTopic!.topic).toBe('LEGAL_OR_AUTHORITY')
  })

  it('and so is an invoice, and a contract', () => {
    for (const t of ['A szamla fizetesi hatarideje lejart', 'A szerzodes megujitasa']) {
      const e = researchEligibility(c({ namespace: 'zst', declaredSensitivity: 'ZST_INTERNAL', title: t }))
      expect(e.eligible).toBe(false)
    }
  })

  it('UNKNOWN and HIGH still refuse', () => {
    expect([...RESEARCHABLE_TIERS].sort()).toEqual(['PERSONAL', 'PUBLIC'])
    expect(researchEligibility(c({ declaredSensitivity: undefined })).sensitivity).toBe('HIGHLY_SENSITIVE')
    expect(researchEligibility(c({ declaredSensitivity: undefined })).eligible).toBe(false)
    expect(researchEligibility(c({ declaredSensitivity: 'SENSITIVE_PERSONAL' })).eligible).toBe(false)
  })

  it('a case DECLARED public whose content is not gets escalated, not believed', () => {
    const e = researchEligibility(c({
      declaredSensitivity: 'PUBLIC',
      description: 'From: info@bikeshop.hu\nA TAJ szama 123 456 789 es a lelet szerint cukorbeteg.',
    }))
    expect(e.eligible).toBe(false)
  })

  it('the scope is an allowlist, so an unlisted case type is out by default', () => {
    expect(scopeOf('SHOPPING')).toBe('PRODUCT_PRICE_COMMERCIAL')
    expect(scopeOf('A_CASE_TYPE_INVENTED_NEXT_YEAR')).toBeNull()
  })
})

describe('WHAT MAY LEAVE -- a public root and one of five fixed phrasings', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the pilot asks for two field kinds, and neither is a subject or a body', () => {
    expect([...PILOT_REQUIRED_FIELDS]).toEqual(['SENDER_ROLE_OR_DOMAIN', 'LANGUAGE'])
    for (const forbidden of ['SUBJECT', 'BODY_FULL', 'BODY_EXCERPT', 'AMOUNT', 'ACCOUNT_IDENTIFIER', 'SENDER_EXACT']) {
      expect(PILOT_REQUIRED_FIELDS).not.toContain(forbidden)
    }
  })

  it('the query is EXACTLY the root domain plus the fixed intent', () => {
    const r = sanctionResearchQuery(getDb(), c({ title: 'Kerekpar szerviz Budapesten, 240 000 Ft' }), 'PUBLIC_PRICING', NOW)
    expect(r.status).toBe('SANCTIONED')
    expect(r.query).toBe('bikeshop.hu current public pricing')
  })

  it('so no case title, person, amount or ticket id can reach it', () => {
    const r = sanctionResearchQuery(getDb(), c({
      title: 'Kovacs Bela ajanlata, 240 000 Ft, ticket INV-88213',
      description: 'From: info@bikeshop.hu',
    }), 'PUBLIC_SUPPORT_DOCS', NOW)
    expect(r.status).toBe('SANCTIONED')
    expect(r.query).toBe('bikeshop.hu public support documentation')
    for (const leak of ['Kovacs', '240', 'INV-88213', 'p1']) {
      expect(r.query).not.toContain(leak)
    }
  })

  it('and a body carrying an address does not get a trimmed query -- it is REFUSED', () => {
    // Two different guarantees: "nothing leaked" and "nothing was sent". This is
    // the second, and it is the stronger one.
    const r = sanctionResearchQuery(getDb(), c({
      description: 'From: info@bikeshop.hu\nA lakcimem Kossuth utca 3.',
    }), 'PUBLIC_SUPPORT_DOCS', NOW)
    expect(r.status).toBe('REFUSED')
    expect(r.query).toBeNull()
  })

  it('the intent is a closed set -- five phrasings, no free text', () => {
    expect(Object.keys(RESEARCH_INTENTS).length).toBe(5)
  })

  it('a case whose sender is not a public identifier is refused, not trimmed', () => {
    const r = sanctionResearchQuery(getDb(), c({ description: 'From: sales@portal.acme.com' }), 'PUBLIC_PRICING', NOW)
    expect(r.status).toBe('REFUSED')
    expect(r.reason).toContain('no public vendor identifier')
    expect(r.query).toBeNull()
  })

  it('the ledger records the query, the released kinds, the tier and the gate record', () => {
    const r = sanctionResearchQuery(getDb(), c(), 'PUBLIC_PRICING', NOW)
    const row = getDb().prepare('SELECT * FROM case_research_queries WHERE ticket_id=?').get(r.ticketId) as Record<string, unknown>
    expect(row.status).toBe('SANCTIONED')
    expect(row.query).toBe(r.query)
    expect(JSON.parse(String(row.disclosed_fields))).toContain('SENDER_ROLE_OR_DOMAIN')
    expect(row.disclosure_record_id).toBeTruthy()
    expect(row.provider).toBe('websearch')
    const d = getDb().prepare('SELECT * FROM cos_disclosure_records WHERE record_id=?')
      .get(String(row.disclosure_record_id)) as Record<string, unknown>
    expect(d.destination).toBe('web:websearch')
    expect(d.trust_class).toBe('UNKNOWN_UNTRUSTED')
  })
})

describe('EACH GUARD ALONE -- fences that do not lean on each other', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('GUARD 1 refuses on its own, before anything is assembled', () => {
    expect(sanctionResearchQuery(getDb(), c({ caseType: 'CONTRACT' }), 'PUBLIC_PRICING', NOW).status).toBe('REFUSED')
  })

  it('GUARD 2 (the public-identifier check) refuses with eligibility switched off', () => {
    const r = sanctionResearchQuery(
      getDb(), c({ caseType: 'CONTRACT', description: 'From: x@my.acme.com' }), 'PUBLIC_PRICING', NOW,
      'websearch', { skipEligibility: true },
    )
    expect(r.status).toBe('REFUSED')
    expect(r.reason).toContain('no public vendor identifier')
    expect(r.reason).not.toContain('allowlist')
  })

  it('GUARD 3 (the secret sweep) fires with the first two switched off', () => {
    const r = sanctionResearchQuery(
      getDb(),
      c({ description: 'From: sk_live_abcdefghijklmnop@x', caseType: 'CONTRACT', declaredSensitivity: 'HIGHLY_SENSITIVE' }),
      'PUBLIC_PRICING', NOW, 'websearch', { skipEligibility: true, skipGate: true },
    )
    expect(r.status).toBe('REFUSED')
    expect(r.reason).toContain('secret-shaped')
  })

  it('the sweep knows shapes, not a list of strings somebody saw leak', () => {
    expect(looksSecretShaped('ghp_aaaaaaaaaaaaaaaaaaaa')).toBeTruthy()
    expect(looksSecretShaped('4111 1111 1111 1111')).toBeTruthy()
    expect(looksSecretShaped('HU42117730161111101800000000')).toBeTruthy()
    expect(looksSecretShaped('password: hunter2')).toBeTruthy()
    expect(looksSecretShaped('bikeshop.hu current public pricing')).toBeNull()
  })
})

describe('A REFUSAL IS RECORDED, BECAUSE AN UNMEASURED FAIL-CLOSED IS A CLAIM', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a refused query gets a ledger row with its reason', () => {
    const r = sanctionResearchQuery(getDb(), c({ caseType: 'CONTRACT' }), 'PUBLIC_PRICING', NOW)
    const row = getDb().prepare('SELECT * FROM case_research_queries WHERE ticket_id=?').get(r.ticketId) as Record<string, unknown>
    expect(row.status).toBe('REFUSED')
    expect(String(row.refused_reason).length).toBeGreaterThan(0)
    expect(row.query).toBeNull()
  })

  it('and the metrics count how often each reason fired', () => {
    sanctionResearchQuery(getDb(), c({ caseId: 'a', caseType: 'CONTRACT' }), 'PUBLIC_PRICING', NOW)
    sanctionResearchQuery(getDb(), c({ caseId: 'b', declaredSensitivity: 'HIGHLY_SENSITIVE' }), 'PUBLIC_PRICING', NOW + 1)
    sanctionResearchQuery(getDb(), c({ caseId: 'd' }), 'PUBLIC_PRICING', NOW + 2)
    const m = pilotMetrics(getDb())
    expect(m.refused).toBe(2)
    expect(m.sanctioned).toBe(1)
    expect(Object.keys(m.refusedByReason).length).toBe(2)
  })
})

describe('A RESULT IS EVIDENCE, NEVER PERMISSION', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('an answer with no provenance is recorded as NO_RESULT, not as knowledge', () => {
    const r = sanctionResearchQuery(getDb(), c(), 'PUBLIC_PRICING', NOW)
    recordResearchResult(getDb(), r.ticketId, { kind: 'EVIDENCE', provenance: [], latencyMs: 900, changedSurface: false }, NOW + 5)
    const row = getDb().prepare('SELECT result_kind FROM case_research_queries WHERE ticket_id=?').get(r.ticketId) as { result_kind: string }
    expect(row.result_kind).toBe('NO_RESULT')
  })

  it('a result cannot be attached to a query that was never sanctioned', () => {
    const r = sanctionResearchQuery(getDb(), c({ caseType: 'CONTRACT' }), 'PUBLIC_PRICING', NOW)
    expect(() => recordResearchResult(getDb(), r.ticketId, {
      kind: 'EVIDENCE', provenance: ['https://example.com'], latencyMs: 10, changedSurface: true,
    })).toThrow(ResearchAuthorizationError)
  })

  it('recording a result writes no case fact', () => {
    getDb().prepare(
      `INSERT INTO personal_cases (case_id,title,case_type,status,created_at,updated_at)
       VALUES ('p1','x','SHOPPING','READY',?,?)`,
    ).run(NOW, NOW)
    const snap = () => JSON.stringify(getDb().prepare('SELECT * FROM personal_cases').all())
    const before = snap()
    const r = sanctionResearchQuery(getDb(), c(), 'PUBLIC_PRICING', NOW)
    recordResearchResult(getDb(), r.ticketId, {
      kind: 'RECOMMENDATION', provenance: ['https://bikeshop.hu/arak'],
      latencyMs: 1200, costUsd: 0.002, changedSurface: true, note: 'published price list found',
    }, NOW + 5)
    expect(snap()).toBe(before)
  })
})

describe('THE NUMBERS THE OWNER ASKED FOR BEFORE IT WIDENS', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('queries per case, usefulness, FALSE POSITIVES, latency, cost and what moved', () => {
    const a = sanctionResearchQuery(getDb(), c({ caseId: 'a' }), 'PUBLIC_PRICING', NOW)
    const b = sanctionResearchQuery(getDb(), c({ caseId: 'b' }), 'PUBLIC_SUPPORT_DOCS', NOW + 1)
    recordResearchResult(getDb(), a.ticketId, { kind: 'EVIDENCE', provenance: ['https://x/1'], latencyMs: 800, costUsd: 0.001, changedSurface: true }, NOW + 10)
    recordResearchResult(getDb(), b.ticketId, {
      kind: 'EVIDENCE', provenance: ['https://x/2'], latencyMs: null, costUsd: 0.001,
      changedSurface: false, falsePositive: true,
    }, NOW + 11)
    const m = pilotMetrics(getDb())
    expect(m.cases).toBe(2)
    expect(m.executed).toBe(2)
    expect(m.withResult).toBe(2)
    expect(m.falsePositive).toBe(1)
    expect(m.changedSurface).toBe(1)
    // A null latency does not become a number: the median is over what was timed.
    expect(m.medianLatencyMs).toBe(800)
    expect(m.totalCostUsd).toBeCloseTo(0.002, 6)
  })
})
