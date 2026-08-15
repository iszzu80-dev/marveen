import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { getRadarItem } from '../cos/radar.js'
import { addRadarItem, addRadarItemForCase } from '../cos/radar-intake.js'

/**
 * Two inputs, ONE creator (card D4). The Telegram request and the CoS-case
 * request are two CALLERS of createRadarItem, not two implementations — because
 * the second implementation is where the first one's gate goes missing, which
 * is the failure this codebase produced four times on 2026-08-15 alone.
 *
 * And intake REFUSES IN WORDS. The gate throws, which is right for a
 * programming error and wrong for a chat message: an exception in a log looks,
 * from Istvan's side, exactly like nothing happening.
 */

const NOW = 1_000_000

const HOFF = {
  radarId: 'BUY-HOFF', kind: 'PRODUCT', label: 'HOFF Banks',
  targetPrice: 35000, terms: 'HOFF Banks cipo',
}

describe('radar intake: both inputs, one creator', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a complete Telegram request creates the item', () => {
    const res = addRadarItem(getDb(), HOFF, NOW)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.item.status).toBe('ACTIVE')
    expect(JSON.parse(res.item.query!).terms).toBe('HOFF Banks cipo')
  })

  it('an incomplete request comes back as a REASON, not an exception', () => {
    // The whole point of this layer. If this ever throws again, a chat request
    // fails silently from Istvan's side.
    const noPrice = addRadarItem(getDb(), { ...HOFF, targetPrice: undefined }, NOW)
    expect(noPrice.ok).toBe(false)
    if (noPrice.ok) return
    expect(noPrice.code).toBe('REFUSED')
    expect(noPrice.reason).toMatch(/nincs celar/)
    expect(getRadarItem(getDb(), 'BUY-HOFF')).toBeUndefined()

    const noTerms = addRadarItem(getDb(), { ...HOFF, terms: undefined }, NOW)
    expect(noTerms.ok).toBe(false)
    if (noTerms.ok) return
    expect(noTerms.reason).toMatch(/keresokifejezes/)
  })

  it('the refusal is the GATE\'s own wording, not a second copy of the rule', () => {
    // Two wordings of one rule drift, and then intake says yes while the writer
    // says no. Asserting the shared phrase is what keeps them one rule.
    const res = addRadarItem(getDb(), { ...HOFF, targetPrice: undefined }, NOW)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toContain('sosem tud talalatot adni')
  })

  it('a duplicate id is refused as a DUPLICATE, not as a gate failure', () => {
    expect(addRadarItem(getDb(), HOFF, NOW).ok).toBe(true)
    const again = addRadarItem(getDb(), { ...HOFF, targetPrice: 30000 }, NOW)
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.code).toBe('DUPLICATE')
    // ...and the original is untouched: overwriting would lose the notification
    // history that stops the radar repeating itself.
    expect(getRadarItem(getDb(), 'BUY-HOFF')!.target_price).toBe(35000)
  })

  it('a case-anchored request creates the item and links it to the case', () => {
    const db = getDb()
    createCase(db, { caseId: 'PRI-SHOP-1', title: 'Cipo', caseType: 'SHOPPING' }, NOW)
    const res = addRadarItemForCase(db, 'PRI-SHOP-1', HOFF, NOW)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.item.case_id).toBe('PRI-SHOP-1')
  })

  it('a case-anchored request obeys the SAME gate', () => {
    // The point of "one creator": the second input path cannot be laxer.
    const db = getDb()
    createCase(db, { caseId: 'PRI-SHOP-2', title: 'Cipo', caseType: 'SHOPPING' }, NOW)
    const res = addRadarItemForCase(db, 'PRI-SHOP-2', { ...HOFF, targetPrice: undefined }, NOW)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('REFUSED')
    expect(res.reason).toMatch(/nincs celar/)
  })

  it('refuses to watch for a case that does not exist', () => {
    const res = addRadarItemForCase(getDb(), 'NINCS-ILYEN', HOFF, NOW)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('NO_CASE')
  })

  it('refuses to start watching on an ARCHIVED case', () => {
    const db = getDb()
    createCase(db, { caseId: 'PRI-SHOP-3', title: 'Cipo', caseType: 'SHOPPING' }, NOW)
    // Set directly: case-store exports no archive function. The column is not
    // decorative — measured on the live store, 1 of 79 personal cases carries
    // an archived_at, so this branch is reachable, not defensive dead code.
    db.prepare('UPDATE personal_cases SET archived_at = ? WHERE case_id = ?').run(NOW, 'PRI-SHOP-3')
    const res = addRadarItemForCase(db, 'PRI-SHOP-3', HOFF, NOW)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('CASE_ARCHIVED')
  })

  it('STANDING: intake never invents a target price', () => {
    // No field on personal_cases holds one (measured: title, description,
    // case_type, status, dates, references — nothing about prices). If a
    // default ever appears here, the radar starts watching numbers nobody
    // chose: either permanently silent, or falsely loud every day.
    const db = getDb()
    createCase(db, { caseId: 'PRI-SHOP-4', title: 'Garmin FR255 vasarlas 120000 Ft alatt', caseType: 'SHOPPING' }, NOW)
    const res = addRadarItemForCase(db, 'PRI-SHOP-4', {
      radarId: 'BUY-GARMIN', kind: 'PRODUCT', label: 'Garmin FR255', terms: 'Garmin FR255',
    }, NOW)
    // The price is right there in the title. It is still not read out of it.
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/nincs celar/)
  })
})
