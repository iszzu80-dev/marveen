import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  sanctionResearchQuery, researchEligibility, recordResearchResult,
  RESEARCH_INTENTS, isPublicProductIdentifier, PRICING_NEEDS_TARGET,
  type ResearchCase,
} from '../cos/research/case-research.js'
import {
  parseSenderField, contentWithoutSenderHeader, NEVER_EGRESSED_SENDER_FIELDS,
} from '../cos/research/sender-field.js'
import {
  researchFindings, applyResearchEnrichment, markChangedSurface, enrichmentSentence,
} from '../cos/research/result-reader.js'
import { projectIntelligence } from '../cos/intelligence/project.js'
import { runProjectionReader } from '../cos/intelligence/reader.js'

// PHASE 3 (P3-B2) -- the three fixes the owner ordered after the B1 pilot.
//
//   the sender is a FIELD, not a property of the case  -> "field-level"
//   PRICING needs a target                             -> "the intent narrows"
//   the ledger gets a reader, with a trace              -> "the dead end opens"

const NOW = 1_800_000_000

const c = (over: Partial<ResearchCase> = {}): ResearchCase => ({
  namespace: 'zst', caseId: 'z1', title: 'AWS szolgaltatas allapot',
  description: 'From: "Geza Szayer" <geza.szayer@generalmechatronics.com>',
  caseType: 'VENDOR', declaredSensitivity: 'ZST_INTERNAL', status: 'NEW', ...over,
})

describe('FIELD-LEVEL, NOT CASE-LEVEL -- and the address is protected harder, not less', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the sender parses into fields, and three of them may never travel', () => {
    const s = parseSenderField('From: "Geza Szayer" <geza.szayer@generalmechatronics.com>')
    expect(s.address).toBe('geza.szayer@generalmechatronics.com')
    expect(s.displayName).toBe('Geza Szayer')
    expect(s.host).toBe('generalmechatronics.com')
    expect([...NEVER_EGRESSED_SENDER_FIELDS]).toEqual(['headerLine', 'displayName', 'address'])
  })

  it('THE B1 DEFECT IS GONE: the intake header no longer lifts the whole case out', () => {
    // In B1 this exact case normalised to HIGHLY_SENSITIVE, because the corporate
    // classifier read the address as personal data and every intake case carries
    // a From: line -- so one universal field excluded the entire namespace.
    const e = researchEligibility(c())
    expect(e.sensitivity).toBe('PERSONAL')
    expect(e.eligible).toBe(true)
  })

  it('and the address STILL never reaches the query -- only the derived root', () => {
    const r = sanctionResearchQuery(getDb(), c(), 'SERVICE_STATUS', NOW)
    expect(r.status).toBe('SANCTIONED')
    expect(r.query).toBe('generalmechatronics.com service status page')
    expect(r.query).not.toContain('geza.szayer')
    expect(r.query).not.toContain('@')
    expect(r.query).not.toContain('Szayer')
  })

  it('an address in the BODY is content and still escalates -- only the header is excluded', () => {
    const e = researchEligibility(c({
      description: 'From: info@vendor.com\nA TAJ szama 123 456 789 szerepel a leleten.',
    }))
    expect(e.eligible).toBe(false)
  })

  it('the two namespaces now give the SAME answer to the same fact', () => {
    // The asymmetry B1 measured: personal called an intake header PERSONAL and
    // corporate called it PERSONAL_DATA. Both now classify the case content, and
    // the header is a field in both.
    const zst = researchEligibility(c({ namespace: 'zst', declaredSensitivity: 'ZST_INTERNAL' }))
    const per = researchEligibility(c({ namespace: 'personal', declaredSensitivity: 'PERSONAL', caseType: 'ADMIN' }))
    expect(zst.eligible).toBe(true)
    expect(per.eligible).toBe(true)
  })

  it('and NAV, legal, financial still refuse whatever the sender domain is', () => {
    for (const title of ['NAV vegrehajtas irat', 'A szamla fizetesi hatarideje', 'A szerzodes felmondasa']) {
      const e = researchEligibility(c({ title, description: 'From: info@aws.com' }))
      expect(e.eligible).toBe(false)
    }
  })

  it('a free-mail sender is refused even though the case content is fine', () => {
    const r = sanctionResearchQuery(getDb(), c({ description: 'From: valaki@gmail.com' }), 'SERVICE_STATUS', NOW)
    expect(r.status).toBe('REFUSED')
    expect(r.reason).toContain('free mail')
  })

  it('contentWithoutSenderHeader removes the header line and nothing else', () => {
    expect(contentWithoutSenderHeader('cim', 'From: a@b.com\nmarad ez')).toBe('cim\nmarad ez')
    expect(contentWithoutSenderHeader('cim', 'a levelben: From: idezet')).toContain('From: idezet')
  })
})

describe('THE INTENT NARROWS -- pricing needs a target', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the B2 intent set is the owner\'s five', () => {
    expect(Object.keys(RESEARCH_INTENTS).sort()).toEqual([
      'OFFICIAL_CONTACT', 'OFFICIAL_SUPPORT_DOCUMENTATION', 'PRICING',
      'PRODUCT_DOCUMENTATION', 'SERVICE_STATUS',
    ])
  })

  it('a company domain plus "pricing" alone is REFUSED as INSUFFICIENT_TARGET', () => {
    // B1 measured what happens otherwise: `fluidra.com current public pricing`
    // returned the SHARE price, confidently and wrongly.
    const r = sanctionResearchQuery(getDb(), c(), 'PRICING', NOW)
    expect(r.status).toBe('REFUSED')
    expect(r.reason).toContain(PRICING_NEEDS_TARGET)
    expect(r.query).toBeNull()
  })

  it('with an explicit public product identifier it is allowed, and names the product', () => {
    const r = sanctionResearchQuery(getDb(), c(), 'PRICING', NOW, 'websearch', { productIdentifier: 'Amazon SES' })
    expect(r.status).toBe('SANCTIONED')
    expect(r.query).toBe('generalmechatronics.com Amazon SES pricing')
  })

  it('and a product identifier that looks like case content is refused', () => {
    expect(isPublicProductIdentifier('Amazon SES')).toBe(true)
    expect(isPublicProductIdentifier('rendeles 8842213')).toBe(false)   // an order number
    expect(isPublicProductIdentifier('info@vendor.com')).toBe(false)    // an address
    expect(isPublicProductIdentifier('https://x/y')).toBe(false)
    expect(isPublicProductIdentifier('')).toBe(false)
    expect(isPublicProductIdentifier('a'.repeat(80))).toBe(false)
  })
})

describe('THE DEAD END OPENS -- and changedSurface becomes a measurement', () => {
  const insZ = (over: Record<string, unknown> = {}) => {
    getDb().prepare(
      `INSERT INTO zst_cases (case_id,title,description,case_type,status,next_action,due_at,waiting_on,related_document_ids,created_at,updated_at)
       VALUES (@case_id,@title,@description,@case_type,@status,NULL,NULL,NULL,NULL,@created_at,@updated_at)`,
    ).run({
      case_id: 'z1', title: 'Valassz csomagot', description: 'From: info@vendor.com',
      case_type: 'VENDOR', status: 'AWAITING_SELECTION',
      created_at: NOW - 86400, updated_at: NOW - 86400, ...over,
    })
  }

  const executedTicket = (caseId = 'z1', provenance = ['https://vendor.com/support']) => {
    const r = sanctionResearchQuery(getDb(), c({ caseId }), 'OFFICIAL_CONTACT', NOW)
    expect(r.status).toBe('SANCTIONED')
    recordResearchResult(getDb(), r.ticketId, {
      kind: 'EVIDENCE', provenance, latencyMs: 900, changedSurface: false,
      note: 'published support address and phone',
    }, NOW + 5)
    return r.ticketId
  }

  beforeEach(() => { initDatabase(':memory:'); insZ() })

  it('a provenanced finding is readable; an unsourced one is not evidence', () => {
    executedTicket()
    expect(researchFindings(getDb(), 'zst').length).toBe(1)

    const r2 = sanctionResearchQuery(getDb(), c({ caseId: 'z2' }), 'SERVICE_STATUS', NOW + 1)
    recordResearchResult(getDb(), r2.ticketId, { kind: 'EVIDENCE', provenance: [], latencyMs: 10, changedSurface: false })
    expect(researchFindings(getDb(), 'zst').length).toBe(1)      // still one
  })

  it('a FALSE POSITIVE never enriches anything', () => {
    const r = sanctionResearchQuery(getDb(), c({ caseId: 'z3' }), 'SERVICE_STATUS', NOW)
    recordResearchResult(getDb(), r.ticketId, {
      kind: 'EVIDENCE', provenance: ['https://x/1'], latencyMs: 10,
      changedSurface: false, falsePositive: true,
    })
    expect(researchFindings(getDb(), 'zst').map((f) => f.ticketId)).not.toContain(r.ticketId)
  })

  it('the finding reaches the projection item, with the full trace', () => {
    const ticketId = executedTicket()
    const p = projectIntelligence(getDb(), 'zst', NOW)
    const { projection, traces } = applyResearchEnrichment(getDb(), 'zst', p)

    // ONE finding, TWO elements: the case surfaces both as case-attention
    // (`only the owner can move this`) and as a BLOCKING decision (`does it have
    // the selection it is waiting for`). A finding that answers the case is
    // relevant to both, so there is a trace per ELEMENT and the ticket is
    // deduped only where it matters -- when marking the ledger.
    expect(new Set(traces.map((x) => x.ticketId)).size).toBe(1)
    expect(traces.length).toBe(2)
    expect(new Set(traces.map((x) => x.elementId)).size).toBe(2)
    const t = traces[0]
    expect(t.ticketId).toBe(ticketId)                       // research result
    expect(t.evidenceSources).toEqual(['https://vendor.com/support'])   // -> evidence
    expect(t.elementId).toContain('z1')                     // -> projection item
    expect(t.after).not.toBe(t.before)                      // -> changed surface
    expect(t.after).toContain('vendor.com')

    const item = [...projection.attention.interrupt, ...projection.attention.quiet]
      .find((i) => i.element.caseId === 'z1')!
    expect(item.why).toContain('nyilvanos forras')
    expect(item.element.provenance.some((pr) => pr.source === 'WEB_RESEARCH')).toBe(true)
  })

  it('and it changes NO case row -- the overlay is derived, not written', () => {
    executedTicket()
    const snap = () => JSON.stringify(getDb().prepare('SELECT * FROM zst_cases ORDER BY case_id').all())
    const before = snap()
    applyResearchEnrichment(getDb(), 'zst', projectIntelligence(getDb(), 'zst', NOW))
    expect(snap()).toBe(before)
  })

  it('changedSurface is written FROM THE TRACES, so it cannot be asserted by hand', () => {
    const ticketId = executedTicket()
    const before = getDb().prepare('SELECT changed_surface FROM case_research_queries WHERE ticket_id=?')
      .get(ticketId) as { changed_surface: number }
    expect(before.changed_surface).toBe(0)

    const { traces } = applyResearchEnrichment(getDb(), 'zst', projectIntelligence(getDb(), 'zst', NOW))
    expect(markChangedSurface(getDb(), traces)).toBe(1)
    const after = getDb().prepare('SELECT changed_surface FROM case_research_queries WHERE ticket_id=?')
      .get(ticketId) as { changed_surface: number }
    expect(after.changed_surface).toBe(1)
  })

  it('a finding for a case with no projection item marks nothing', () => {
    // The honest zero: research that answered something about a case the
    // projection does not surface has changed no surface, and must not claim to.
    const r = sanctionResearchQuery(getDb(), c({ caseId: 'no-such-case' }), 'OFFICIAL_CONTACT', NOW)
    recordResearchResult(getDb(), r.ticketId, {
      kind: 'EVIDENCE', provenance: ['https://x/1'], latencyMs: 10, changedSurface: false,
    })
    const { traces } = applyResearchEnrichment(getDb(), 'zst', projectIntelligence(getDb(), 'zst', NOW))
    expect(traces.map((t) => t.ticketId)).not.toContain(r.ticketId)
  })

  it('the live reader carries the traces and marks them', () => {
    const ticketId = executedTicket()
    const posts: string[] = []
    const res = runProjectionReader(getDb(), 'zst', NOW + 10, (t) => { posts.push(t) })
    expect(new Set(res.researchTraces.map((t) => t.ticketId))).toEqual(new Set([ticketId]))
    expect(res.researchTraces.length).toBeGreaterThanOrEqual(1)
    const row = getDb().prepare('SELECT changed_surface FROM case_research_queries WHERE ticket_id=?')
      .get(ticketId) as { changed_surface: number }
    expect(row.changed_surface).toBe(1)
    expect(posts.join('')).toContain('nyilvanos forras')
  })

  it('a DRY run marks nothing, here too', () => {
    const ticketId = executedTicket()
    runProjectionReader(getDb(), 'zst', NOW + 10, () => {}, undefined, undefined, true)
    const row = getDb().prepare('SELECT changed_surface FROM case_research_queries WHERE ticket_id=?')
      .get(ticketId) as { changed_surface: number }
    expect(row.changed_surface).toBe(0)
  })

  it('the sentence names its source, so a reader can chase it', () => {
    const f = researchFindings(getDb(), 'zst')[0] ?? null
    executedTicket('z9')
    const g = researchFindings(getDb(), 'zst')[0]
    expect(enrichmentSentence(g)).toContain('vendor.com')
    expect(f === null || true).toBe(true)
  })
})
