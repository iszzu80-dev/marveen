// Four claims the APG screen made that nothing behind it supported.
//
// Review 2026-08-10 (F-1, F-2, F-7, F-13), fixed 2026-08-12. Same shape in all
// four: the projection is the sidecar's story retold (§1.4), and each of these
// retold it as something stronger, more finished or more configured than the
// sidecar actually said — with no error anywhere on the way.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { requestedMode } from '../web/routes/apg.js'
import { setOverride, reloadOverridesForTest, OVERRIDES_PATH } from '../settings-store.js'
import { existsSync, rmSync } from 'node:fs'
import { PROJECT_ROOT } from '../config.js'
import type { RouteContext } from '../web/routes/types.js'

const REPO = process.cwd()

function fakeCtx(path: string): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } } },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req: {} as any, res, path: url.pathname, method: 'GET', url } as RouteContext, out }
}

// ── F-1: the strongest label on the screen ──────────────────────────────────
//
// `VERIFIED_CURRENT` renders as "citable as a current, verified fact". It was
// granted when the evidence row was PRESENT and ANY checkpoint in the same
// replay run had passed — so a green `spec_ready` (the SPECIFICATION was ready)
// promoted a file's mere existence to a runtime-verified fact. §11.1 lists six
// ways to produce a false green; this branch produced two of them by itself.
describe('F-1: a green claim needs a RUNTIME gate and a runtime observation', () => {
  const src = readFileSync(join(REPO, 'src/apg/ui-projection.ts'), 'utf8')

  // MERGE NOTE (develop <- APG 1.9 WP2 §10.3-b). This block used to read the
  // body of `claimStatus()` and assert that F-1's hardening was present in it:
  // RUNTIME_GATES.has(...), receipt.runtime_status === 'OBSERVED', and
  // `spec_ready` absent from the gate set. That function NO LONGER EXISTS. The
  // APG line removed the projection's local currentness rule outright rather
  // than hardening it, because a second rule for one label means the weaker one
  // decides -- and F-1's version, good as it was, still had no method
  // authority, no source-type exclusion, no required receipt keys and no
  // recency ceiling. The kernel's resolve_verification_status() has all four.
  //
  // So F-1's PROPERTY is not dropped, it is asserted against the architecture
  // that replaced the code F-1 patched. The strongest possible form of "a
  // documents-only PASS must not read as runtime-verified" is that this module
  // cannot reach a checkpoint result at all when it labels a claim -- which is
  // what these assertions now pin. The behavioural half (STALE survives a
  // PASSing gate, an unresolved claim is NOT_RESOLVED_BY_ENGINE) lives in
  // apg-claim-currentness.test.ts against a real sidecar-shaped database.

  it('HEADLINE: a passing gate can no longer promote anything, because the projection cannot see gates', () => {
    // F-1's defect needed three inputs: a checkpoint result, a replay run id and
    // a receipt. If the claim-labelling code cannot reach any of them, the bug
    // class is structurally unreachable -- including a version of it reintroduced
    // next month. This is strictly stronger than requiring a RUNTIME gate.
    const start = src.indexOf('function asNonEmptyString')
    const end = src.indexOf('function summaryFor')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const region = src.slice(start, end)
    expect(region).not.toMatch(/replay_run_id/)
    expect(region).not.toMatch(/candidate\.checkpoints/)
    expect(region).not.toMatch(/'PASS'/)
  })

  it('the module never grants the strongest label on its own authority', () => {
    // The whole of F-1 in one grep. VERIFIED_CURRENT may be RELABELLED from a
    // kernel status; it may never be RETURNED by code that weighed evidence.
    expect(src).not.toMatch(/return 'VERIFIED_CURRENT'/)
  })

  it('the hardened-but-still-local rule is gone, not merely outvoted', () => {
    // Belt and braces on the merge itself: if anyone restores claimStatus() or
    // its RUNTIME_GATES set, the two-rules-for-one-label problem is back and
    // this fails immediately.
    expect(src).not.toContain('function claimStatus(')
    expect(src).not.toContain('RUNTIME_GATES')
  })

  it('everything else keeps the honest label that already existed', () => {
    // The counter-case F-1 was careful about, unchanged: this must not become
    // "refuse everything". The honest middle label still exists and is still
    // reachable for evidence that has real support but no runtime proof.
    expect(src).toContain('SUPPORTED_BUT_NOT_RUNTIME_VERIFIED')
  })
})

// ── F-2: "accepted" was a gate result ───────────────────────────────────────
describe('F-2: acceptance requires an accepter', () => {
  const src = readFileSync(join(REPO, 'src/apg/ui-projection.ts'), 'utf8')
  const fn = src.slice(src.indexOf('function acceptanceStatusFor('), src.indexOf('function claimStatus('))

  it('HEADLINE: a passing gate with no accepter is gates_passed, not accepted', () => {
    expect(fn).toContain("return accepter ? 'accepted' : 'gates_passed'")
  })

  it('waiting is called waiting — nobody "returned" anything', () => {
    // evidence_needed / decision_needed / clarification used to map to
    // `returned`, which names an action that never happened.
    expect(fn).toContain("return 'needs_input'")
    expect(fn).not.toMatch(/case 'clarification':\s*\n\s*return 'returned'/)
  })

  it('the projection passes a null accepter, because the sidecar records none', () => {
    // The honest input to the decision about building the missing half (1.8 WP3),
    // rather than a label that hides that it is missing.
    expect(src).toContain('acceptanceStatusFor(displayState, null)')
  })

  it('the Kanban badge no longer says "independently accepted" for a gate pass', () => {
    const ui = readFileSync(join(REPO, 'web/apg.js'), 'utf8')
    expect(ui).toContain("item.acceptance_status === 'gates_passed'")
    expect(ui).toContain('apg.kanban.badge.gates_passed')
    // And the label exists in BOTH languages, or the badge renders a raw key.
    for (const lang of ['web/lang/hu.js', 'web/lang/en.js']) {
      expect(readFileSync(join(REPO, lang), 'utf8')).toContain('apg.kanban.badge.gates_passed')
    }
  })
})

// ── F-7 / F-13: the mode, and where it came from ────────────────────────────
describe('F-7 + F-13: the mode is reported honestly and cannot be escalated', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    for (const p of [OVERRIDES_PATH(), join(PROJECT_ROOT, 'store', 'apg-scope-overrides.json')]) {
      if (existsSync(p)) rmSync(p)
    }
    reloadOverridesForTest()
    process.env.APG_KERNEL_DB_PATH = '/nonexistent/apg-honest-projection.db'
  })

  const ask = (query: string) =>
    requestedMode(new URL(`http://x/api/apg/work-items${query}`), null, null)

  it('HEADLINE: ?mode=enforced cannot switch APG back on when it is globally off', () => {
    setOverride('APG_MODE', 'off')
    // The kill switch wins. Before the fix the query string did, and the whole
    // feature came back on a deployment where the owner had switched it off.
    expect(ask('?mode=enforced')).toEqual({ mode: 'off', source: 'global' })
    expect(ask('?mode=assisted')).toEqual({ mode: 'off', source: 'global' })
  })

  it('asking for LESS than the configuration is still honoured', () => {
    // The counter-case, and the reason this is a clamp and not a ban: a preview
    // that can only ever show the configured mode is not a preview.
    setOverride('APG_MODE', 'enforced')
    expect(ask('?mode=observe')).toEqual({ mode: 'observe', source: 'request' })
    expect(ask('?mode=off')).toEqual({ mode: 'off', source: 'request' })
    // ...and equal is fine too.
    expect(ask('?mode=enforced')).toEqual({ mode: 'enforced', source: 'request' })
  })

  it('no ?mode= at all still reports the resolved scope', () => {
    setOverride('APG_MODE', 'assisted')
    expect(ask('')).toEqual({ mode: 'assisted', source: 'global' })
  })

  it('an unknown mode is still rejected', () => {
    setOverride('APG_MODE', 'enforced')
    expect(ask('?mode=banana')).toHaveProperty('error')
  })

  it('the source is threaded through instead of being the literal "global"', () => {
    const src = readFileSync(join(REPO, 'src/apg/ui-projection.ts'), 'utf8')
    expect(src).toContain('mode_source: modeSource')
    expect(src).not.toContain("mode_source: 'global',")
    const routes = readFileSync(join(REPO, 'src/web/routes/apg.ts'), 'utf8')
    expect(routes).toContain('modeSource: modeResult.source')
    expect(routes).toContain('buildApgWorkItemDetail(modeResult.mode, workItemId, modeResult.source)')
  })

  it('a clamped preview is labelled as coming from the request, not from a scope', () => {
    const routes = readFileSync(join(REPO, 'src/web/routes/apg.ts'), 'utf8')
    expect(routes).toContain("source: 'request'")
    // The old code claimed the query string WAS the global configuration.
    const fn = routes.slice(routes.indexOf('function requestedMode('), routes.indexOf('function detailError('))
    expect(fn).not.toContain("return { mode: explicitMode as ApgMode, source: 'global' }")
  })
})
