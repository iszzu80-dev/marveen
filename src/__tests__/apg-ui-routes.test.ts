import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, createApproval } from '../db.js'
import { PROJECT_ROOT, storePath } from '../config.js'
import { SETTINGS_REGISTRY } from '../config-registry.js'
import { tryHandleApg } from '../web/routes/apg.js'
import { reloadOverridesForTest, setOverride, OVERRIDES_PATH } from '../settings-store.js'
import type { RouteContext } from '../web/routes/types.js'

// Same fake-ServerResponse pattern as src/__tests__/optimization-routes.test.ts
// -- a real RouteContext against a real in-memory DB, capturing what json()
// writes, without booting the actual HTTP server/process (this repo's
// dashboard must never be live-booted in a sandbox: a known fleet-wide
// binary-pattern bug can SIGTERM the real production instance).
function fakeCtx(
  path: string,
  method = 'GET',
  auth?: RouteContext['auth'],
): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) {
      if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: {} as any, res, path: url.pathname, method, url, auth } as RouteContext
  return { ctx, out }
}

/** The operator credential no dispatched agent can hold (see apg-principal.ts). */
const OPERATOR: RouteContext['auth'] = { kind: 'session', user: 'istvan' }

function fakeCtxWithBody(
  path: string,
  method: string,
  body: unknown,
  auth?: RouteContext['auth'],
): { ctx: RouteContext; out: { status: number; body: any } } {
  const { ctx, out } = fakeCtx(path, method, auth)
  ctx.req.on = ((event: string, cb: (...args: any[]) => void) => {
    if (event === 'data') cb(Buffer.from(JSON.stringify(body)))
    if (event === 'end') cb()
    return ctx.req
  }) as any
  return { ctx, out }
}

const SCOPE_OVERRIDES_PATH = () => storePath('apg-scope-overrides.json')
const IDEMPOTENCY_PATH = () => storePath('apg-decision-idempotency.json')
const AUDIT_PATH = () => storePath('apg-ui-audit.jsonl')

function resetApgFiles(): void {
  for (const p of [SCOPE_OVERRIDES_PATH(), IDEMPOTENCY_PATH(), AUDIT_PATH(), OVERRIDES_PATH()]) {
    if (existsSync(p)) rmSync(p)
  }
  reloadOverridesForTest()
}

describe('APG UI API (route smoke)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    resetApgFiles()
    // This machine has a REAL local APG kernel sidecar with real pilot data
    // at ~/marveen-local/apg-kernel/store/apg-kernel.db (openApgKernelReadonly's
    // default path). Point every test at a deliberately nonexistent path
    // instead, so "sidecar unavailable" tests stay deterministic and no test
    // in this suite ever reads real production APG data.
    process.env.APG_KERNEL_DB_PATH = '/nonexistent/apg-kernel-test-sandbox.db'
  })

  it('GET /api/apg/summary defaults to APG_MODE=off and never touches the (absent) sidecar', async () => {
    const { ctx, out } = fakeCtx('/api/apg/summary')
    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.mode).toBe('off')
    expect(out.body.enabled).toBe(false)
    expect(out.body.mode_source).toBe('global')
    expect(out.body.counts.active).toBe(0)
    expect(JSON.stringify(out.body)).not.toMatch(/secret|api[_-]?key|password/i)
  })

  it('a global-off scope override cannot be raised by a card override (absolute master off)', async () => {
    const { ctx: putCtx } = fakeCtxWithBody('/api/apg/scope-overrides', 'PUT', {
      scope_type: 'kanban_card', scope_id: '0f75d35d', mode: 'enforced', actor: 'test', reason: 'probe',
    }, OPERATOR)
    expect(await tryHandleApg(putCtx)).toBe(true)

    const { ctx, out } = fakeCtx('/api/apg/summary?kanban_card_id=0f75d35d')
    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.body.mode).toBe('off')
    expect(out.body.mode_source).toBe('global')
  })

  it('once APG_MODE is not off, a card override raises/changes the effective mode for that card only', async () => {
    setOverride('APG_MODE', 'observe')
    const { ctx: putCtx, out: putOut } = fakeCtxWithBody('/api/apg/scope-overrides', 'PUT', {
      scope_type: 'kanban_card', scope_id: '0f75d35d', mode: 'enforced', actor: 'test', reason: 'probe',
    }, OPERATOR)
    expect(await tryHandleApg(putCtx)).toBe(true)
    expect(putOut.status).toBe(200)

    const { ctx: scoped, out: scopedOut } = fakeCtx('/api/apg/summary?kanban_card_id=0f75d35d')
    await tryHandleApg(scoped)
    expect(scopedOut.body.mode).toBe('enforced')
    expect(scopedOut.body.mode_source).toBe('card')

    const { ctx: unscoped, out: unscopedOut } = fakeCtx('/api/apg/summary')
    await tryHandleApg(unscoped)
    expect(unscopedOut.body.mode).toBe('observe')
    expect(unscopedOut.body.mode_source).toBe('global')
  })

  it('PUT /api/apg/scope-overrides rejects a downgrade from enforced with no reason', async () => {
    setOverride('APG_MODE', 'enforced')
    const { ctx, out } = fakeCtxWithBody('/api/apg/scope-overrides', 'PUT', {
      scope_type: 'project', scope_id: 'lumaseat', mode: 'observe', actor: 'test', reason: '',
    }, OPERATOR)
    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/reason/i)
  })

  it('GET /api/apg/work-items degrades to an empty list (not a 500) when the sidecar is unavailable', async () => {
    const { ctx, out } = fakeCtx('/api/apg/work-items')
    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.items).toEqual([])
    expect(out.body.total).toBe(0)
    expect(typeof out.body.error).toBe('string')
  })

  it('GET /api/apg/work-items/:id 404s when the sidecar has nothing for that id', async () => {
    const { ctx, out } = fakeCtx('/api/apg/work-items/does-not-exist')
    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(typeof out.body.error).toBe('string')
  })

  it('POST /api/apg/approvals/:id/decision: producer cannot silently double-decide, and replays the SAME response for a repeated idempotency_key', async () => {
    const approval = createApproval({
      id: 'approval-1', agent_id: 'buildfejleszto', category: 'test',
      action_description: 'do the thing', action_payload: null, timeout_at: null,
    })

    const first = fakeCtxWithBody(`/api/apg/approvals/${approval.id}/decision`, 'POST', {
      action: 'accept', idempotency_key: 'k1',
    }, OPERATOR)
    expect(await tryHandleApg(first.ctx)).toBe(true)
    expect(first.out.status).toBe(200)
    expect(first.out.body.status).toBe('approved')
    // §11.4: was the literal 'dashboard' -- a SURFACE, not a person. The
    // attribution now names the principal the credential resolved to, and it
    // still refuses to claim the human was proven.
    expect(first.out.body.resolved_by).toBe('session:istvan')
    expect(first.out.body.human_principal_proven).toBe(false)

    // Same idempotency_key replayed -- spec 7.4: must return the SAME result,
    // not the generic "already resolved" 409 (that 409 is for a genuinely
    // conflicting SECOND decision, not a retry of the first one).
    const replay = fakeCtxWithBody(`/api/apg/approvals/${approval.id}/decision`, 'POST', {
      action: 'accept', idempotency_key: 'k1',
    }, OPERATOR)
    expect(await tryHandleApg(replay.ctx)).toBe(true)
    expect(replay.out.status).toBe(200)
    expect(replay.out.body).toEqual(first.out.body)

    // A DIFFERENT idempotency_key against the now-resolved approval is a
    // genuine conflict -> 409, distinguishable from the replay case above.
    const conflict = fakeCtxWithBody(`/api/apg/approvals/${approval.id}/decision`, 'POST', {
      action: 'block', idempotency_key: 'k2',
    }, OPERATOR)
    expect(await tryHandleApg(conflict.ctx)).toBe(true)
    expect(conflict.out.status).toBe(409)
    expect(conflict.out.body.status).toBe('approved')
  })

  it('POST decision rejects an invalid action with 400 and never calls resolveApproval', async () => {
    const approval = createApproval({
      id: 'approval-2', agent_id: 'buildfejleszto', category: 'test',
      action_description: 'do the thing', action_payload: null, timeout_at: null,
    })
    const { ctx, out } = fakeCtxWithBody(`/api/apg/approvals/${approval.id}/decision`, 'POST', {
      action: 'not-a-real-action', idempotency_key: 'k1',
    })
    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('GET /api/apg/scope-overrides returns [] before anything is written', async () => {
    const { ctx, out } = fakeCtx('/api/apg/scope-overrides')
    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.body.overrides).toEqual([])
  })

  it('GET /api/apg/work-items clamps limit to [1,500] and offset to >=0, 400s on non-numeric input', async () => {
    const overLimit = fakeCtx('/api/apg/work-items?limit=99999')
    await tryHandleApg(overLimit.ctx)
    expect(overLimit.out.body.limit).toBe(500)

    const zeroLimit = fakeCtx('/api/apg/work-items?limit=0')
    await tryHandleApg(zeroLimit.ctx)
    expect(zeroLimit.out.body.limit).toBe(1)

    const negOffset = fakeCtx('/api/apg/work-items?offset=-5')
    await tryHandleApg(negOffset.ctx)
    expect(negOffset.out.body.offset).toBe(0)

    const badLimit = fakeCtx('/api/apg/work-items?limit=not-a-number')
    await tryHandleApg(badLimit.ctx)
    expect(badLimit.out.status).toBe(400)

    const badMode = fakeCtx('/api/apg/work-items?mode=super-enforced')
    await tryHandleApg(badMode.ctx)
    expect(badMode.out.status).toBe(400)
  })

  it('a corrupted scope-overrides.json degrades to empty instead of crashing the request', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    mkdirSync(dirname(SCOPE_OVERRIDES_PATH()), { recursive: true })
    writeFileSync(SCOPE_OVERRIDES_PATH(), '{not valid json::')

    const { ctx, out } = fakeCtx('/api/apg/scope-overrides')
    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.overrides).toEqual([])

    // and the mode resolver still works (falls back to global, no throw)
    const summary = fakeCtx('/api/apg/summary?kanban_card_id=0f75d35d')
    expect(await tryHandleApg(summary.ctx)).toBe(true)
    expect(summary.out.status).toBe(200)
  })

  it('PUT /api/apg/scope-overrides rejects an unknown mode and an unknown scope_type', async () => {
    const badMode = fakeCtxWithBody('/api/apg/scope-overrides', 'PUT', {
      scope_type: 'kanban_card', scope_id: '0f75d35d', mode: 'super-enforced', actor: 'test', reason: '',
    })
    expect(await tryHandleApg(badMode.ctx)).toBe(true)
    expect(badMode.out.status).toBe(400)

    const badScope = fakeCtxWithBody('/api/apg/scope-overrides', 'PUT', {
      scope_type: 'workspace', scope_id: 'x', mode: 'observe', actor: 'test', reason: '',
    })
    expect(await tryHandleApg(badScope.ctx)).toBe(true)
    expect(badScope.out.status).toBe(400)
  })

  // ── Surface toggle RED-able tests (item #1) ──
  // Each toggle OFF must return false in the summary response; ON must return true.
  // These prove the toggle actually gates its surface (not just a no-op default).

  const SURFACE_TOGGLES = [
    { key: 'APG_UI_OVERVIEW', field: 'apg_ui_overview_enabled' },
    { key: 'APG_UI_KANBAN', field: 'apg_ui_kanban_enabled' },
    { key: 'APG_UI_ACTIVITY', field: 'apg_ui_activity_enabled' },
    { key: 'APG_UI_EVIDENCE', field: 'apg_ui_evidence_enabled' },
    { key: 'APG_UI_APPROVAL_ENHANCEMENTS', field: 'apg_ui_approval_enhancements_enabled' },
  ]

  for (const toggle of SURFACE_TOGGLES) {
    it(`summary.${toggle.field} is true by default (${toggle.key})`, async () => {
      // Ensure APG_MODE is not off so the summary endpoint responds.
      setOverride('APG_MODE', 'observe')
      reloadOverridesForTest()
      const { ctx, out } = fakeCtx('/api/apg/summary')
      expect(await tryHandleApg(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body[toggle.field]).toBe(true)
    })

    it(`summary.${toggle.field} turns false when ${toggle.key}=0 (RED-able)`, async () => {
      setOverride('APG_MODE', 'observe')
      setOverride(toggle.key, '0')
      reloadOverridesForTest()
      const { ctx, out } = fakeCtx('/api/apg/summary')
      expect(await tryHandleApg(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body[toggle.field]).toBe(false)
    })

    it(`summary.${toggle.field} turns true again when ${toggle.key}=1`, async () => {
      setOverride('APG_MODE', 'observe')
      setOverride(toggle.key, '1')
      reloadOverridesForTest()
      const { ctx, out } = fakeCtx('/api/apg/summary')
      expect(await tryHandleApg(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body[toggle.field]).toBe(true)
    })
  }
})

describe('APG settings i18n completeness', () => {
  // Verify every APG registry entry has a settings.desc.<KEY> in both
  // hu.js and en.js. This prevents the exact gap that this fix closes:
  // a registry entry added without its matching i18n key causes the
  // Settings page to show a raw untranslated token.
  it('every module=apg registry entry has settings.desc.<key> in hu.js and en.js', () => {
    const webDir = join(PROJECT_ROOT, 'web', 'lang')

    const loadKeys = (filename: string): Set<string> => {
      const raw = readFileSync(join(webDir, filename), 'utf-8')
      const keys = new Set<string>()
      const re = /'settings\.desc\.([^']+)'/g
      let match
      while ((match = re.exec(raw)) !== null) {
        keys.add(`settings.desc.${match[1]}`)
      }
      return keys
    }

    const huKeys = loadKeys('hu.js')
    const enKeys = loadKeys('en.js')
    const apgEntries = SETTINGS_REGISTRY.filter((e) => e.module === 'apg')

    expect(apgEntries.length).toBeGreaterThanOrEqual(11)

    for (const entry of apgEntries) {
      const descKey = `settings.desc.${entry.key}`
      expect(huKeys.has(descKey),
        `Missing hu.js key: ${descKey}`).toBe(true)
      expect(enKeys.has(descKey),
        `Missing en.js key: ${descKey}`).toBe(true)
    }
  })
})
