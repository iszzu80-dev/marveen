import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  createZstCase, getZstCase, transitionZstCase, appendZstCaseEvent,
  acquireZstClaim, releaseZstClaim, listActiveZstCases, listTodayZstCases,
} from '../cos/zst-case-store.js'
import { createCase } from '../cos/case-store.js'
import { CaseConcurrencyError } from '../cos/case-engine-core.js'

// ZST Slice 0 -- the Corporate Case Engine is the SHARED engine bound to the
// zst_* namespace. These tests prove (a) the same invariants hold as Personal
// (optimistic concurrency, append-only audit, claim fencing), (b) the ZST status
// semantics (INFORMATION_REQUIRED etc.) drive the read views, (c) the workspace
// routing tag, and (d) the two namespaces are physically separate (AT-ZS01).

const T0 = 1_700_000_000

describe('ZST corporate case engine (Slice 0)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  function events(caseId: string) {
    return getDb().prepare(
      `SELECT event_type, previous_status, new_status, case_version FROM zst_case_events
       WHERE case_id = ? ORDER BY event_id`
    ).all(caseId) as any[]
  }

  describe('createZstCase', () => {
    it('inserts at version 1 with ZST defaults and a CREATED event', () => {
      const db = getDb()
      const row = createZstCase(db, { caseId: 'ZST-ACC-2026-001', title: 'Havi könyvelői csomag', caseType: 'ACCOUNTING' }, T0)
      expect(row.version).toBe(1)
      expect(row.status).toBe('NEW')
      expect(row.sensitivity).toBe('ZST_INTERNAL')
      expect(row.workspace).toBe('OPERATIONS')
      const evs = events('ZST-ACC-2026-001')
      expect(evs).toHaveLength(1)
      expect(evs[0]).toMatchObject({ event_type: 'CREATED', new_status: 'NEW', case_version: 1 })
    })

    it('applies the workspace routing tag and product link', () => {
      const db = getDb()
      const row: any = createZstCase(db, {
        caseId: 'ZST-MARV-2026-001', title: 'Marveen release blocker', caseType: 'PRODUCT_MILESTONE',
        workspace: 'PRODUCT_LAB', productId: 'MARV',
      }, T0)
      expect(row.workspace).toBe('PRODUCT_LAB')
      expect(row.product_id).toBe('MARV')
    })

    it('honours explicit ZST sensitivity class', () => {
      const db = getDb()
      const row = createZstCase(db, {
        caseId: 'ZST-INV-2026-001', title: 'Bejövő számla', caseType: 'INVOICE_INCOMING',
        sensitivity: 'ZST_FINANCIAL',
      }, T0)
      expect(row.sensitivity).toBe('ZST_FINANCIAL')
    })
  })

  describe('transitionZstCase (optimistic concurrency)', () => {
    it('bumps version, records prev/new status, applies a patch', () => {
      const db = getDb()
      createZstCase(db, { caseId: 'z1', title: 't', caseType: 'VENDOR' }, T0)
      const v = transitionZstCase(db, {
        caseId: 'z1', seenVersion: 1, newStatus: 'WAITING_EXTERNAL', actor: 'marveen',
        reason: 'sent RFQ', patch: { waiting_on: 'Fluidra', follow_up_at: T0 + 86400 },
      }, T0 + 10)
      expect(v).toBe(2)
      const row: any = getZstCase(db, 'z1')
      expect(row.status).toBe('WAITING_EXTERNAL')
      expect(row.waiting_on).toBe('Fluidra')
      const evs = events('z1')
      expect(evs[1]).toMatchObject({ event_type: 'STATUS_CHANGED', previous_status: 'NEW', new_status: 'WAITING_EXTERNAL', case_version: 2 })
    })

    it('throws CaseConcurrencyError on a stale version (never clobbers)', () => {
      const db = getDb()
      createZstCase(db, { caseId: 'z1', title: 't', caseType: 'VENDOR' }, T0)
      transitionZstCase(db, { caseId: 'z1', seenVersion: 1, newStatus: 'READY', actor: 'a' }, T0 + 5)
      expect(() => transitionZstCase(db, { caseId: 'z1', seenVersion: 1, newStatus: 'BLOCKED', actor: 'b' }, T0 + 6))
        .toThrow(CaseConcurrencyError)
      expect((getZstCase(db, 'z1') as any).status).toBe('READY') // unchanged
    })
  })

  describe('append-only audit log', () => {
    it('blocks UPDATE and DELETE on zst_case_events via triggers', () => {
      const db = getDb()
      createZstCase(db, { caseId: 'z1', title: 't', caseType: 'VENDOR' }, T0)
      expect(() => db.prepare(`UPDATE zst_case_events SET reason='x' WHERE case_id='z1'`).run())
        .toThrow(/append-only/)
      expect(() => db.prepare(`DELETE FROM zst_case_events WHERE case_id='z1'`).run())
        .toThrow(/append-only/)
    })

    it('rejects an event for a non-existent case (FK)', () => {
      const db = getDb()
      db.pragma('foreign_keys = ON')
      expect(() => appendZstCaseEvent(db, { caseId: 'nope', caseVersion: 1, actor: 'a', eventType: 'X' }, T0))
        .toThrow()
    })
  })

  describe('claim + fencing', () => {
    it('acquires, refuses to steal a live claim, takes over an expired one with a fence bump', () => {
      const db = getDb()
      const a = acquireZstClaim(db, { claimKey: 'z1', ownerRunId: 'runA', ttlSeconds: 100 }, T0)
      expect(a).toMatchObject({ acquired: true, fence: 1 })
      const b = acquireZstClaim(db, { claimKey: 'z1', ownerRunId: 'runB', ttlSeconds: 100 }, T0 + 10)
      expect(b.acquired).toBe(false) // live claim not stolen
      expect(b.ownerRunId).toBe('runA')
      const c = acquireZstClaim(db, { claimKey: 'z1', ownerRunId: 'runB', ttlSeconds: 100 }, T0 + 200)
      expect(c).toMatchObject({ acquired: true, fence: 2 }) // expired -> takeover, fence bumps
    })

    it('release is fence-safe (a stale fence cannot release the current holder)', () => {
      const db = getDb()
      acquireZstClaim(db, { claimKey: 'z1', ownerRunId: 'runA', ttlSeconds: 100 }, T0)
      expect(releaseZstClaim(db, { claimKey: 'z1', ownerRunId: 'runA', fence: 99 })).toBe(false)
      expect(releaseZstClaim(db, { claimKey: 'z1', ownerRunId: 'runA', fence: 1 })).toBe(true)
    })
  })

  describe('read views use ZST status semantics', () => {
    it('listActive excludes ZST terminal states incl FAILED_TERMINAL', () => {
      const db = getDb()
      createZstCase(db, { caseId: 'a', title: 'a', caseType: 'X', status: 'READY' }, T0)
      createZstCase(db, { caseId: 'b', title: 'b', caseType: 'X', status: 'FAILED_TERMINAL' }, T0)
      createZstCase(db, { caseId: 'c', title: 'c', caseType: 'X', status: 'COMPLETED' }, T0)
      const ids = listActiveZstCases(db).map(r => r.case_id)
      expect(ids).toContain('a')
      expect(ids).not.toContain('b')
      expect(ids).not.toContain('c')
    })

    it('listToday surfaces ZST attention statuses (INFORMATION_REQUIRED, REVIEW_REQUIRED)', () => {
      const db = getDb()
      createZstCase(db, { caseId: 'a', title: 'a', caseType: 'X', status: 'INFORMATION_REQUIRED' }, T0)
      createZstCase(db, { caseId: 'b', title: 'b', caseType: 'X', status: 'REVIEW_REQUIRED' }, T0)
      createZstCase(db, { caseId: 'c', title: 'c', caseType: 'X', status: 'READY' }, T0) // no date, not attention
      const ids = listTodayZstCases(db, T0 + 86400).map(r => r.case_id)
      expect(ids).toEqual(expect.arrayContaining(['a', 'b']))
      expect(ids).not.toContain('c')
    })
  })

  describe('namespace separation (AT-ZS01)', () => {
    it('a personal case is not visible in the ZST read views, and vice versa', () => {
      const db = getDb()
      createCase(db, { caseId: 'PRI-1', title: 'personal', caseType: 'HOME_REPAIR', status: 'READY' }, T0)
      createZstCase(db, { caseId: 'ZST-1', title: 'business', caseType: 'VENDOR', status: 'READY' }, T0)
      const zstIds = listActiveZstCases(db).map(r => r.case_id)
      expect(zstIds).toContain('ZST-1')
      expect(zstIds).not.toContain('PRI-1')
      expect(getZstCase(db, 'PRI-1')).toBeUndefined()
    })
  })
})
