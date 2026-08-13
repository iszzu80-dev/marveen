import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import {
  extractEntities, suggestLinks, linkCases, linkedCases, CARRIERS,
} from '../cos/case-link.js'

// Linking cases across threads.
//
// The tests that matter here are the ones asserting what does NOT link. An
// over-eager linker produces a case graph nobody trusts, and an untrusted graph
// is worse than none — you still have to check every connection by hand, but now
// you also have to disprove the wrong ones.

const NOW = 1_800_000_000

function mkCase(id: string, title: string, description = '') {
  createCase(getDb(), { caseId: id, title, caseType: 'ADMIN', description }, NOW - 1000)
}

describe('COS case linking by entity', () => {
  beforeEach(() => { initDatabase(':memory:') })

  describe('entity extraction', () => {
    it('picks up long numbers as identifiers and ignores short ones', () => {
      const e = extractEntities('A 120001419444 rendelés, 2026, 42 db, ház 12')
      expect(e.identifiers).toContain('120001419444')
      expect(e.identifiers).not.toContain('2026')
      expect(e.identifiers).not.toContain('42')
    })

    it('recognises a merchant regardless of accents and case', () => {
      expect(extractEntities('eCipő ügyfélszolgálat').merchants).toContain('ecipo')
      expect(extractEntities('MODIVO.COM SA megbízásából').merchants).toContain('modivo')
    })

    it('does NOT treat a carrier as a merchant', () => {
      // Half the shopping cases mention GLS. Matching on the carrier would wire
      // unrelated purchases to each other.
      const e = extractEntities('GLS Hungary csomagfelvétel, Foxpost automata')
      for (const c of CARRIERS) expect(e.merchants).not.toContain(c)
    })
  })

  describe('suggestions', () => {
    it('a shared order number is a STRONG candidate', () => {
      mkCase('claim', 'eCipő reklamáció', 'rendelésszám 120001419444')
      const s = suggestLinks(getDb(), 'Csomagfelvétel a 120001419444 rendeléshez')
      expect(s).toHaveLength(1)
      expect(s[0]).toMatchObject({ caseId: 'claim', strength: 'STRONG' })
      expect(s[0].evidence).toContain('120001419444')
    })

    it('a shared merchant alone is only WEAK — a question, not a conclusion', () => {
      mkCase('claim', 'eCipő/Modivo reklamáció', 'visszaküldés')
      const s = suggestLinks(getDb(), 'MODIVO.COM SA megbízásából csomagfelvétel')
      expect(s[0]).toMatchObject({ caseId: 'claim', strength: 'WEAK' })
    })

    it('STRONG sorts before WEAK, so a caller taking the first gets the identifier', () => {
      mkCase('by-id', 'A ügy', 'rendelés 998877665544')
      mkCase('by-brand', 'Modivo B ügy', 'valami más')
      const s = suggestLinks(getDb(), 'Modivo, rendelés 998877665544')
      expect(s.map((x) => x.caseId)).toEqual(['by-id', 'by-brand'])
    })

    it('does not suggest anything for text with no entity at all', () => {
      mkCase('claim', 'eCipő reklamáció', 'rendelés 120001419444')
      expect(suggestLinks(getDb(), 'Köszönöm, rendben.')).toEqual([])
    })

    it('two cases that merely share a carrier do NOT get suggested', () => {
      mkCase('other', 'Alza szállítás', 'GLS futár hozza')
      expect(suggestLinks(getDb(), 'GLS csomagfelvétel')).toEqual([])
    })

    it('closed cases are not offered — a finished matter is not the next step', () => {
      mkCase('done', 'eCipő reklamáció', 'rendelés 120001419444')
      getDb().prepare(`UPDATE personal_cases SET status='COMPLETED' WHERE case_id='done'`).run()
      expect(suggestLinks(getDb(), 'rendelés 120001419444')).toEqual([])
    })

    it('never suggests the case it was asked to exclude', () => {
      mkCase('self', 'eCipő reklamáció', 'rendelés 120001419444')
      expect(suggestLinks(getDb(), 'rendelés 120001419444', 'self')).toEqual([])
    })
  })

  describe('writing the link', () => {
    it('links both directions and records why on each side', () => {
      mkCase('a', 'Reklamáció'); mkCase('b', 'Csomagfelvétel')
      const r = linkCases(getDb(), 'a', 'b', 'azonosító: 120001419444', NOW)
      expect(r.linked).toBe(true)
      expect(linkedCases(getDb(), 'a')).toContain('b')
      expect(linkedCases(getDb(), 'b')).toContain('a')

      const events = getDb().prepare(
        `SELECT case_id, event_type, reason FROM personal_case_events WHERE event_type='CASE_LINKED'`
      ).all() as Array<{ case_id: string; reason: string }>
      expect(events).toHaveLength(2)
      expect(events.every((e) => e.reason.includes('120001419444'))).toBe(true)
    })

    it('is idempotent — linking twice does not duplicate', () => {
      mkCase('a', 'A'); mkCase('b', 'B')
      linkCases(getDb(), 'a', 'b', 'ok', NOW)
      const second = linkCases(getDb(), 'a', 'b', 'ok', NOW + 1)
      expect(second.linked).toBe(false)
      expect(linkedCases(getDb(), 'a')).toEqual(['b'])
    })

    it('a case cannot be linked to itself', () => {
      mkCase('a', 'A')
      expect(linkCases(getDb(), 'a', 'a', 'ok', NOW).linked).toBe(false)
    })

    it('refuses a missing case by name rather than failing silently', () => {
      mkCase('a', 'A')
      const r = linkCases(getDb(), 'a', 'nincs-ilyen', 'ok', NOW)
      expect(r.linked).toBe(false)
      expect(r.reason).toContain('nincs-ilyen')
    })

    // P6 (review 2026-08-13). The UPDATE carried `AND version = @version` and
    // nobody looked at info.changes, then the CASE_LINKED event was inserted
    // unconditionally, stamped version+1. On a stale version that produced an
    // audit row referencing a case version that never existed, describing a link
    // that is not in the store — and, since caseA is written before caseB, a
    // possible one-directional link. transitionCase has always thrown on a
    // 0-row conditional update.
    it('a conditional update that matches nothing writes NO link and NO event', () => {
      const db = getDb()
      mkCase('a', 'A'); mkCase('b', 'B')
      // A BEFORE-UPDATE trigger that silently skips the row is exactly what a
      // stale version looks like to the statement: changes === 0, nothing written.
      db.exec(`CREATE TRIGGER stale_writer BEFORE UPDATE OF related_case_ids ON personal_cases
               BEGIN SELECT RAISE(IGNORE); END`)
      const r = linkCases(db, 'a', 'b', 'azonosító: 120001419444', NOW)
      db.exec(`DROP TRIGGER stale_writer`)

      expect(r.linked).toBe(false)
      expect(r.reason).toMatch(/verzióütközés/)
      expect(linkedCases(db, 'a')).toEqual([])
      expect(linkedCases(db, 'b')).toEqual([])
      const events = db.prepare(
        `SELECT COUNT(*) n FROM personal_case_events WHERE event_type='CASE_LINKED'`,
      ).get() as { n: number }
      expect(events.n, 'the audit log may not claim a link the store does not have').toBe(0)
    })

    it('bumps the version on both cases, so a stale writer loses', () => {
      mkCase('a', 'A'); mkCase('b', 'B')
      const before = getDb().prepare(`SELECT version FROM personal_cases WHERE case_id='a'`).get() as { version: number }
      linkCases(getDb(), 'a', 'b', 'ok', NOW)
      const after = getDb().prepare(`SELECT version FROM personal_cases WHERE case_id='a'`).get() as { version: number }
      expect(after.version).toBe(before.version + 1)
    })
  })

  // P7 (review 2026-08-13). `\b\d{6,}\b` matched phone numbers in footers, dates
  // written 20260809, tracking codes and invoice totals, so two unrelated
  // merchants printing the same courier hotline auto-linked. And the text being
  // scanned is a STRANGER'S EMAIL, so a sender could embed another case's order
  // number and have the graph wired for them.
  describe('what may NOT be treated as an identifier', () => {
    it('rejects a compact date', () => {
      expect(extractEntities('Feladva: 20260809, rendelés 120001419444').identifiers)
        .toEqual(['120001419444'])
    })

    it('rejects a phone number, however it is written', () => {
      expect(extractEntities('Ügyfélszolgálat: +36 1 8888888').identifiers).toEqual([])
      expect(extractEntities('Hívjon: 06301234567').identifiers).toEqual([])
      expect(extractEntities('Tel: 0036 1 8888888').identifiers).toEqual([])
    })

    it('rejects an invoice total', () => {
      expect(extractEntities('Végösszeg: 125000 Ft').identifiers).toEqual([])
      expect(extractEntities('Összesen 349900 HUF').identifiers).toEqual([])
    })

    it('two merchants sharing a courier hotline in their footers do not link', () => {
      mkCase('other', 'Alza rendelés', 'Ügyfélszolgálat: +36 1 8888888')
      expect(suggestLinks(getDb(), 'Notino visszaigazolás. Hotline: +36 1 8888888')).toEqual([])
    })
  })

  describe('auto-linking needs more than a stranger typing a number', () => {
    it('an identifier that appears only in sender-authored text is a SUGGESTION, not a link', () => {
      // The case's title/description came from the correspondent's own mail.
      mkCase('victim', 'eCipő reklamáció 120001419444', 'rendelésszám 120001419444')
      const s = suggestLinks(getDb(), 'Jó napot, a 120001419444 rendelésről írok')
      expect(s[0]).toMatchObject({ caseId: 'victim', strength: 'STRONG' })
      expect(s[0].autoLinkable, 'a sender must not be able to wire the graph').toBe(false)
    })

    it('the same identifier in a TRUSTED case field makes it auto-linkable', () => {
      mkCase('claim', 'eCipő reklamáció', 'részletek')
      // waiting_on is written by the owner / the engine while working the case.
      getDb().prepare(`UPDATE personal_cases SET waiting_on='visszatérítés a 120001419444 rendelésre' WHERE case_id='claim'`).run()
      const s = suggestLinks(getDb(), 'Csomagfelvétel a 120001419444 rendeléshez')
      expect(s[0].autoLinkable).toBe(true)
    })

    it('the caller may vouch for its own side instead', () => {
      mkCase('claim', 'eCipő reklamáció 120001419444', 'rendelésszám 120001419444')
      const s = suggestLinks(getDb(), 'a 120001419444 rendelés', undefined, 'personal_cases',
        { trustedText: 'Istvan: a 120001419444 rendelést reklamáltam' })
      expect(s[0].autoLinkable).toBe(true)
    })

    it('a merchant match is never auto-linkable', () => {
      mkCase('claim', 'Modivo reklamáció', 'valami')
      const s = suggestLinks(getDb(), 'MODIVO.COM SA megbízásából csomagfelvétel')
      expect(s[0]).toMatchObject({ strength: 'WEAK', autoLinkable: false })
    })
  })

  it('reproduces 2026-08-09: the GLS notice and the eCipő claim find each other', () => {
    mkCase('PRI-CLAIM-2026-001', 'eCipő/Modivo HOFF Bangkok reklamáció',
      'A 1294864 számú reklamációt elfogadták; a vételárat a GLS csomagszám beérkezése után térítik vissza.')
    const glsMail = 'Tisztelt István Szabó! Ezúton értesítjük, hogy MODIVO.COM SA megbízásából csomag felvételére teszünk kísérletet.'
    const s = suggestLinks(getDb(), glsMail)
    expect(s[0]?.caseId).toBe('PRI-CLAIM-2026-001')
    expect(s[0]?.strength).toBe('WEAK')      // merchant only — offered as a question
    expect(s[0]?.evidence).toContain('modivo')
  })
})
