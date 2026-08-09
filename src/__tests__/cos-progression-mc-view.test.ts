/**
 * Mission Control progression view tests (card 969e5c3b).
 *
 * Verifies the /api/cos/progression data rendering on case tiles.
 * Live data fixtures are used where the backend is reachable; the rendering
 * logic is exercised in a minimal jsdom environment with fetch mocked.
 *
 * Gate: every test must be RED on pre-fix code, GREEN after.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const COSCONTROL_SRC = readFileSync(
  join(__dirname, '..', '..', 'web', 'coscontrol.js'), 'utf-8',
)

// --------------- DOM + fetch mock helpers ---------------
function freshDom() {
  const { JSDOM } = require('jsdom')
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="cosBody"></div></body></html>',
    { url: 'http://localhost:3420', runScripts: 'dangerously' },
  )
  return dom
}

function mockAllFetch(dom: ReturnType<typeof freshDom>, responses: Record<string, any>) {
  const fn = vi.fn(async (url: string) => {
    const s = String(url)
    if (responses[s] !== undefined) return { ok: true, json: async () => responses[s] }
    for (const k of Object.keys(responses)) {
      if (s.startsWith(k)) return { ok: true, json: async () => responses[k] }
    }
    return { ok: true, json: async () => ({}) }
  })
  // Set on both the jsdom window (where the IIFE eval sees it) AND
  // globalThis (where vitest/vm may resolve it).
  ;(dom.window as any).fetch = fn
  ;(globalThis as any).fetch = fn
  return fn
}

function loadAndMount(dom: ReturnType<typeof freshDom>) {
  // Synchronously expose window/document globally so bare refs work in eval.
  ;(globalThis as any).window = dom.window
  ;(globalThis as any).document = dom.window.document

  // Eval the coscontrol.js source in the jsdom window so the IIFE attaches
  // CosControl to dom.window.
  dom.window.eval(COSCONTROL_SRC)

  const cc = (dom.window as any).CosControl
  if (!cc) throw new Error('CosControl not found on window after eval')
  cc.mount()
  return cc
}

// Wait for the Promise.all in mount() to settle. In vitest with mocked fetch
// the microtask queue drains after the current synchronous block, so one
// setImmediate or a short setTimeout is enough.
function tick(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// --------------- LIVE FIXTURES ---------------
const PROG_ROW = {
  caseId: 'PRI-ADM-2026-001', domain: 'personal',
  title: 'Anyai halotti anyakönyvi kivonat átvétele',
  status: 'READY',
  goal: 'Elvegezni az adminisztracios feladatot, archiválni a bizonylatokat',
  summary: null,
  semanticCompletionStatus: 'IN_PROGRESS',
  lastDecision: 'CONTINUE_AUTONOMOUSLY',
  lastDecisionReason: 'Next action can be executed autonomously in shadow mode',
  lastProgressedAt: 1786273212,
  planVersion: 3,
  nbaDescription: '{"planStep":2,"description":"Execute the next action in the work plan","kind":"EXECUTE","canProceedAutonomously":true,"estimatedEffortMinutes":15}',
  totalRunCount: 5,
}

const PROG_WAITING = {
  caseId: 'PRI-BILL-2026-001', domain: 'personal',
  title: 'DMRV vízszámlák',
  status: 'WAITING_EXTERNAL',
  goal: 'Rendezni a penzugyi tetelt',
  summary: null,
  semanticCompletionStatus: 'IN_PROGRESS',
  lastDecision: 'WAIT_EXTERNAL',
  lastDecisionReason: 'Case is waiting for external response',
  lastProgressedAt: 1786272636,
  planVersion: 3,
  nbaDescription: '{"planStep":1,"description":"Verify current state and gathered context","kind":"VERIFY","canProceedAutonomously":true,"estimatedEffortMinutes":5}',
  totalRunCount: 3,
}

const CASE_WITH_PROG = {
  case_id: 'PRI-ADM-2026-001',
  title: 'Anyai halotti anyakönyvi kivonat átvétele',
  case_type: 'ADMIN', category: 'Család/admin', status: 'READY',
  priority: 'P2', sensitivity: 'SENSITIVE_PERSONAL',
  next_action: 'Átvételi hely és nyitvatartás ellenőrzése',
  next_action_owner: 'István', waiting_on: null, due_at: null,
  follow_up_at: 1785924000, source_system: 'chatgpt-cos-drive', updated_at: 1786027480,
}

const CASE_NO_PROG = {
  case_id: 'PRI-NO-PROG-001', title: 'Case without progression',
  case_type: 'OTHER', status: 'NEW', priority: 'P3', sensitivity: 'PUBLIC',
  next_action: null, next_action_owner: null, waiting_on: null,
  due_at: null, follow_up_at: null, source_system: 'manual', updated_at: 1785900000,
}

const CASE_WAITING = {
  case_id: 'PRI-BILL-2026-001', title: 'DMRV vízszámlák',
  case_type: 'BILL', status: 'WAITING_EXTERNAL', priority: 'P1',
  sensitivity: 'SENSITIVE_PERSONAL', next_action: 'Fizetési határidő ellenőrzése',
  next_action_owner: 'István', waiting_on: 'DMRV', due_at: null,
  follow_up_at: 1785900000, source_system: 'chatgpt-cos-drive', updated_at: 1786027480,
}

function BASE_RESPONSES(overrides: Record<string, any> = {}) {
  return {
    '/api/cos/today': { cases: [] },
    '/api/cos/cases': { cases: [] },
    '/api/cos/outbound': {},
    '/api/cos/campaigns': {},
    '/api/cos/radar': {},
    '/api/cos/monitoring': {},
    '/api/cos/analytics': {},
    '/api/cos/zst-today': { cases: [] },
    '/api/cos/zst-cases': { cases: [] },
    '/api/cos/progression?domain=personal': [],
    '/api/cos/progression?domain=zst': [],
    '/api/cos/events': { events: [] },
    '/api/cos/documents': { documents: [] },
    ...overrides,
  }
}

describe('Mission Control progression view (card 969e5c3b)', () => {
  // Clean up globals between tests to avoid cross-test leakage.
  beforeEach(() => {
    delete (globalThis as any).window
    delete (globalThis as any).document
    vi.restoreAllMocks()
  })

  // ---- CLOSED TILE TESTS ----
  describe('closed tile', () => {
    it('renders progression badge when case has progression data', async () => {
      const dom = freshDom()
      mockAllFetch(dom, BASE_RESPONSES({
        '/api/cos/today': { cases: [CASE_WITH_PROG] },
        '/api/cos/progression?domain=personal': [PROG_ROW],
      }))
      loadAndMount(dom)
      await tick(100)

      const html = dom.window.document.getElementById('cosBody')?.innerHTML || ''
      expect(html).toContain('cos-prog-badge')
      expect(html).toContain('Folyamatban')
      expect(html).toContain('cos-tile-nba')
      expect(html).toContain('Execute the next action in the work plan')
    })

    it('renders tile WITHOUT progression data exactly as before', async () => {
      const dom = freshDom()
      mockAllFetch(dom, BASE_RESPONSES({
        '/api/cos/today': { cases: [CASE_NO_PROG] },
      }))
      loadAndMount(dom)
      await tick(100)

      const html = dom.window.document.getElementById('cosBody')?.innerHTML || ''
      expect(html).toContain('cos-case-tile')
      expect(html).toContain('Case without progression')
      // No progression artifacts.
      expect(html).not.toContain('cos-prog-badge')
      expect(html).not.toContain('cos-tile-nba')
    })

    it('never emits "undefined" or "null" as literal text', async () => {
      const dom = freshDom()
      mockAllFetch(dom, BASE_RESPONSES({
        '/api/cos/today': { cases: [CASE_WITH_PROG, CASE_NO_PROG, CASE_WAITING] },
        '/api/cos/progression?domain=personal': [PROG_ROW, PROG_WAITING],
      }))
      loadAndMount(dom)
      await tick(100)

      const html = dom.window.document.getElementById('cosBody')?.innerHTML || ''
      expect(html).not.toMatch(/\bundefined\b/)
      expect(html).not.toMatch(/\bnull\b/)
    })

    it('coexists with existing ball-holder line on the same tile', async () => {
      const dom = freshDom()
      mockAllFetch(dom, BASE_RESPONSES({
        '/api/cos/today': { cases: [CASE_WAITING] },
        '/api/cos/progression?domain=personal': [PROG_WAITING],
      }))
      loadAndMount(dom)
      await tick(100)

      const html = dom.window.document.getElementById('cosBody')?.innerHTML || ''
      // Legacy ball-holder line present.
      expect(html).toContain('Külső félre vár')
      expect(html).toContain('DMRV')
      // Progression badge also present.
      expect(html).toContain('cos-prog-badge')
      expect(html).toContain('Folyamatban')
    })

    it('handles null goal and null nbaDescription gracefully', async () => {
      const progNulls = { ...PROG_ROW, goal: null, nbaDescription: null, lastDecision: null, lastDecisionReason: null }
      const dom = freshDom()
      mockAllFetch(dom, BASE_RESPONSES({
        '/api/cos/today': { cases: [CASE_WITH_PROG] },
        '/api/cos/progression?domain=personal': [progNulls],
      }))
      loadAndMount(dom)
      await tick(100)

      const html = dom.window.document.getElementById('cosBody')?.innerHTML || ''
      expect(html).not.toMatch(/\bnull\b/)
      expect(html).not.toMatch(/\bundefined\b/)
      // Badge still there (completion status present).
      expect(html).toContain('cos-prog-badge')
      // No NBA line (description is null).
      expect(html).not.toContain('cos-tile-nba')
    })

    it('handles malformed nbaDescription JSON without crashing', async () => {
      const progBad = { ...PROG_ROW, nbaDescription: '{broken json!!!!' }
      const dom = freshDom()
      mockAllFetch(dom, BASE_RESPONSES({
        '/api/cos/today': { cases: [CASE_WITH_PROG] },
        '/api/cos/progression?domain=personal': [progBad],
      }))
      loadAndMount(dom)
      await tick(100)

      const html = dom.window.document.getElementById('cosBody')?.innerHTML || ''
      expect(html).toContain('cos-prog-badge')
      // No NBA line from broken JSON.
      const nbaCount = (html.match(/cos-tile-nba/g) || []).length
      expect(nbaCount).toBe(0)
    })

    it('survives progression fetch failure without crashing', async () => {
      const dom = freshDom()
      const fn = vi.fn(async (url: string) => {
        const s = String(url)
        if (s.includes('/api/cos/progression')) throw new Error('Network error')
        const responses: Record<string, any> = {
          '/api/cos/today': { cases: [CASE_WITH_PROG] },
          '/api/cos/cases': { cases: [] }, '/api/cos/outbound': {},
          '/api/cos/campaigns': {}, '/api/cos/radar': {}, '/api/cos/monitoring': {},
          '/api/cos/analytics': {}, '/api/cos/zst-today': { cases: [] },
          '/api/cos/zst-cases': { cases: [] },
        }
        for (const [k, v] of Object.entries(responses)) {
          if (s.startsWith(k)) return { ok: true, json: async () => v }
        }
        return { ok: true, json: async () => ({}) }
      })
      ;(dom.window as any).fetch = fn
      ;(globalThis as any).fetch = fn
      loadAndMount(dom)
      await tick(100)

      const html = dom.window.document.getElementById('cosBody')?.innerHTML || ''
      // Tile still renders.
      expect(html).toContain('cos-case-tile')
      // No progression badge.
      expect(html).not.toContain('cos-prog-badge')
      // No error leaked.
      expect(html).not.toContain('Network error')
    })
  })

  // ---- EXPANDED DETAIL TESTS ----
  describe('expanded detail panel', () => {
    it('shows goal, status, last decision on expand', async () => {
      const dom = freshDom()
      mockAllFetch(dom, BASE_RESPONSES({
        '/api/cos/today': { cases: [CASE_WITH_PROG] },
        '/api/cos/progression?domain=personal': [PROG_ROW],
        '/api/cos/events': { events: [] },
        '/api/cos/documents': { documents: [] },
      }))
      loadAndMount(dom)
      await tick(100)

      const tile = dom.window.document.querySelector('.cos-case-tile') as HTMLElement
      tile?.click()
      await tick(100)

      const detailHtml = tile?.querySelector('.cos-case-detail')?.innerHTML || ''
      expect(detailHtml).toContain('cos-detail-progression')
      expect(detailHtml).toContain('Elvegezni az adminisztracios feladatot')  // goal
      expect(detailHtml).toContain('Folyamatban')  // completion status
      expect(detailHtml).toContain('Folytatás önállóan')  // decision label
      expect(detailHtml).toContain('Next action can be executed autonomously in shadow mode')
      expect(detailHtml).toContain('terv v3')
      expect(detailHtml).toContain('5 futtatás')
    })

    it('omits progression section when no progression data', async () => {
      const dom = freshDom()
      mockAllFetch(dom, BASE_RESPONSES({
        '/api/cos/today': { cases: [CASE_NO_PROG] },
        '/api/cos/events': { events: [] },
        '/api/cos/documents': { documents: [] },
      }))
      loadAndMount(dom)
      await tick(100)

      const tile = dom.window.document.querySelector('.cos-case-tile') as HTMLElement
      tile?.click()
      await tick(100)

      const detailHtml = tile?.querySelector('.cos-case-detail')?.innerHTML || ''
      expect(detailHtml).not.toContain('cos-detail-progression')
    })

    it('closing and re-opening preserves progression data', async () => {
      const dom = freshDom()
      mockAllFetch(dom, BASE_RESPONSES({
        '/api/cos/today': { cases: [CASE_WITH_PROG] },
        '/api/cos/progression?domain=personal': [PROG_ROW],
        '/api/cos/events': { events: [] },
        '/api/cos/documents': { documents: [] },
      }))
      loadAndMount(dom)
      await tick(100)

      const tile = dom.window.document.querySelector('.cos-case-tile') as HTMLElement
      tile?.click()
      await tick(100)
      tile?.click()  // close
      await tick(50)
      tile?.click()  // re-open
      await tick(50)

      const detailHtml = tile?.querySelector('.cos-case-detail')?.innerHTML || ''
      expect(detailHtml).toContain('cos-detail-progression')
    })

    it('null goal and null decision do not produce "null" text in detail', async () => {
      const progNulls = { ...PROG_ROW, goal: null, lastDecision: null, lastDecisionReason: null }
      const dom = freshDom()
      mockAllFetch(dom, BASE_RESPONSES({
        '/api/cos/today': { cases: [CASE_WITH_PROG] },
        '/api/cos/progression?domain=personal': [progNulls],
        '/api/cos/events': { events: [] },
        '/api/cos/documents': { documents: [] },
      }))
      loadAndMount(dom)
      await tick(100)

      const tile = dom.window.document.querySelector('.cos-case-tile') as HTMLElement
      tile?.click()
      await tick(100)

      const detailHtml = tile?.querySelector('.cos-case-detail')?.innerHTML || ''
      expect(detailHtml).not.toMatch(/\bnull\b/)
      expect(detailHtml).not.toMatch(/\bundefined\b/)
    })
  })

  // ---- ZST NAMESPACE ----
  describe('ZST namespace', () => {
    it('applies ZST progression data when ZST tab is active', async () => {
      const zstCase = { ...CASE_WITH_PROG, case_id: 'ZST-TEST-001' }
      const zstProg = { ...PROG_ROW, caseId: 'ZST-TEST-001', domain: 'zst' }
      const dom = freshDom()
      mockAllFetch(dom, BASE_RESPONSES({
        '/api/cos/zst-today': { cases: [zstCase] },
        '/api/cos/progression?domain=zst': [zstProg],
      }))
      loadAndMount(dom)
      await tick(100)

      // Click ZST tab
      const zstTab = dom.window.document.querySelector('[data-tab="zst"]') as HTMLElement
      zstTab?.click()
      await tick(50)

      const zstPanel = dom.window.document.getElementById('cosPanelZst')
      const zstHtml = zstPanel?.innerHTML || ''
      expect(zstHtml).toContain('cos-prog-badge')
    })
  })
})
