// APG 1.9 WP3 -- Execution Identity + Provenance, Marveen half.
//
// Every test in this file is written the same way: FIRST do the thing the 1.8
// conformance audit proved an attacker could do, and assert it is now refused.
// A happy path that never had a hole is not evidence that a hole was closed, so
// the happy paths here exist only to prove the refusals are not blanket ones.
//
// The three audit findings, and the shape of their attack:
//
//   §3.2  Any bearer-token holder -- i.e. every dispatched agent, since
//         kanban.ts writes `cat store/.dashboard-token` into the dispatch
//         message -- could PUT its own card out of enforced mode with a
//         free-text excuse, and `updated_by` was whatever the body said.
//   §3.1  POST /api/kanban/:id/archive had no APG check whatsoever. The
//         enforced-mode archive gate lived in web/apg.js, so a curl skipped it.
//   §3.3  PATCH /api/approvals/:id took `resolved_by` from the request body and
//         stored it verbatim -- §11.4's named anti-pattern.
//
// The sidecar is deliberately pointed at a nonexistent path throughout: this
// machine has a REAL kernel DB with real pilot data at the default location,
// and no test here may read it. It also makes the §25 fail-closed branch the
// natural default, which is the branch that used to fail open.

import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  initDatabase, getDb, createApproval, getApproval, createKanbanCard, getKanbanCard,
} from '../db.js'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'
import { tryHandleApg } from '../web/routes/apg.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'
import { reloadOverridesForTest, setOverride, OVERRIDES_PATH } from '../settings-store.js'
import {
  setScopeOverride, resolveEffectiveApgMode, MAX_DOWNGRADE_TTL_MINUTES,
  type ScopeOverrideDeps,
} from '../web/apg-scope-overrides.js'
import { resolveApgPrincipal } from '../web/apg-principal.js'
import { evaluateArchiveGate, type ArchiveGateDeps } from '../web/apg-archive-gate.js'
import { HUMAN_REQUIRED_CATEGORY } from '../web/apg-human-approval.js'
import { resolveCardRoleAgents } from '../costops/dispatch.js'
import type { ApgUiWorkItemSummary } from '../apg/ui-types.js'
import type { RouteContext } from '../web/routes/types.js'

// ---------------------------------------------------------------------------
// Harness (same fake-ServerResponse shape as apg-ui-routes.test.ts -- the real
// dashboard is never booted in a sandbox).
// ---------------------------------------------------------------------------

function fakeCtx(path: string, method: string, body?: unknown, auth?: RouteContext['auth']) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } } },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: {} as any, res, path: url.pathname, method, url, auth } as RouteContext
  ctx.req.on = ((event: string, cb: (...a: any[]) => void) => {
    if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
    if (event === 'end') cb()
    return ctx.req
  }) as any
  return { ctx, out }
}

/** The credential every dispatched agent holds. This is the attacker. */
const FLEET_TOKEN: RouteContext['auth'] = { kind: 'token' }
/** A named browser login -- the strongest principal Marveen can present. */
const OPERATOR_SESSION: RouteContext['auth'] = { kind: 'session', user: 'istvan' }
/** An enrolled device: operator-class, but it names a device, not a person. */
const OPERATOR_DEVICE: RouteContext['auth'] = { kind: 'device', device: 'bridge-phone' }

const SCOPE_OVERRIDES_PATH = join(PROJECT_ROOT, 'store', 'apg-scope-overrides.json')
const IDEMPOTENCY_PATH = join(PROJECT_ROOT, 'store', 'apg-decision-idempotency.json')
const AUDIT_PATH = join(PROJECT_ROOT, 'store', 'apg-ui-audit.jsonl')

function resetApgFiles(): void {
  for (const p of [SCOPE_OVERRIDES_PATH, IDEMPOTENCY_PATH, AUDIT_PATH, OVERRIDES_PATH]) {
    if (existsSync(p)) rmSync(p)
  }
  reloadOverridesForTest()
}

function auditEvents(): Array<{ type: string; detail: Record<string, unknown> }> {
  if (!existsSync(AUDIT_PATH)) return []
  return readFileSync(AUDIT_PATH, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

/** Deps that answer the producer question without a DB, for the policy tests. */
function scopeDeps(producers: string[] | null, now = new Date('2026-08-13T12:00:00Z')): ScopeOverrideDeps {
  return { producersFor: () => producers, now: () => now }
}

beforeEach(() => {
  initDatabase(':memory:')
  resetApgFiles()
  process.env.APG_KERNEL_DB_PATH = '/nonexistent/apg-kernel-wp3-sandbox.db'
})

// ===========================================================================
// Item 1 -- §24.0.5: no manual blanket downgrade
// ===========================================================================

describe('§24.0.5: the self-downgrade hole', () => {
  it('ATTACK: a fleet-token caller can no longer take its own card out of enforced mode', async () => {
    setOverride('APG_MODE', 'enforced')
    // Exactly the audit's §3.2 request: the card id an agent was dispatched to,
    // a free-text reason, and the shared token every agent is handed.
    const { ctx, out } = fakeCtx('/api/apg/scope-overrides', 'PUT', {
      scope_type: 'kanban_card', scope_id: 'deadbeef', mode: 'observe',
      actor: 'buildfejleszto', reason: 'a typecheck gate is inconvenient right now',
    }, FLEET_TOKEN)

    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.error).toMatch(/§24\.0\.5/)
    // Not merely refused -- not written. The card is still enforced.
    expect(resolveEffectiveApgMode(null, 'deadbeef').mode).toBe('enforced')
    // And the attempt is on the record, with the principal that made it.
    const refusals = auditEvents().filter((e) => e.type === 'scope_override_downgrade_refused')
    expect(refusals).toHaveLength(1)
    expect(refusals[0].detail.principal).toBe('fleet_token:shared')
    expect(refusals[0].detail.principal_class).toBe('fleet')
    expect(refusals[0].detail.refusal).toBe('non_operator_principal')
  })

  it('ATTACK: the same refusal applies to a whole PROJECT, which is the §24.0.5 headline case', async () => {
    setOverride('APG_MODE', 'enforced')
    const { ctx, out } = fakeCtx('/api/apg/scope-overrides', 'PUT', {
      scope_type: 'project', scope_id: 'lumaseat', mode: 'observe',
      actor: 'buildfejleszto', reason: 'the whole chain is noisy',
    }, FLEET_TOKEN)
    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(resolveEffectiveApgMode('lumaseat', null).mode).toBe('enforced')
  })

  it('ATTACK: an agent cannot reach the same end by DELETING an override that raised the scope', async () => {
    setOverride('APG_MODE', 'observe')
    const put = fakeCtx('/api/apg/scope-overrides', 'PUT', {
      scope_type: 'kanban_card', scope_id: 'deadbeef', mode: 'enforced', actor: 'istvan', reason: 'raise',
    }, OPERATOR_SESSION)
    await tryHandleApg(put.ctx)
    expect(resolveEffectiveApgMode(null, 'deadbeef').mode).toBe('enforced')

    const del = fakeCtx('/api/apg/scope-overrides/kanban_card/deadbeef', 'DELETE', {
      actor: 'buildfejleszto', reason: 'cleanup',
    }, FLEET_TOKEN)
    expect(await tryHandleApg(del.ctx)).toBe(true)
    expect(del.out.status).toBe(403)
    expect(resolveEffectiveApgMode(null, 'deadbeef').mode).toBe('enforced')
  })

  it('RAISING enforcement stays open to any caller -- the rule is about weakening, not about paperwork', async () => {
    setOverride('APG_MODE', 'observe')
    const { ctx, out } = fakeCtx('/api/apg/scope-overrides', 'PUT', {
      scope_type: 'kanban_card', scope_id: 'deadbeef', mode: 'enforced', actor: 'buildfejleszto', reason: '',
    }, FLEET_TOKEN)
    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(resolveEffectiveApgMode(null, 'deadbeef').mode).toBe('enforced')
  })

  it('an operator downgrade succeeds, is time-bounded, and records who and on what basis', async () => {
    setOverride('APG_MODE', 'enforced')
    const { ctx, out } = fakeCtx('/api/apg/scope-overrides', 'PUT', {
      scope_type: 'project', scope_id: 'lumaseat', mode: 'observe',
      actor: 'istvan', reason: 'release incident, gates calibrating',
    }, OPERATOR_SESSION)
    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.status).toBe(200)

    const override = out.body.override
    // §11.4's attribution shape, applied to the mode store: the identity is the
    // credential's, the body's actor survives only as a labelled claim.
    expect(override.updated_by).toBe('session:istvan')
    expect(override.claimed_actor).toBe('istvan')
    expect(override.principal_class).toBe('operator')
    // §24.0.5: "időben/scope-ban korlátozott".
    expect(typeof override.expires_at).toBe('string')
    const ttlMinutes = (Date.parse(override.expires_at) - Date.now()) / 60_000
    expect(ttlMinutes).toBeGreaterThan(0)
    expect(ttlMinutes).toBeLessThanOrEqual(MAX_DOWNGRADE_TTL_MINUTES)
  })

  it('a downgrade cannot outlive the cap, however long the caller asks for', () => {
    setOverride('APG_MODE', 'enforced')
    const now = new Date('2026-08-13T12:00:00Z')
    const result = setScopeOverride(
      {
        scope_type: 'project', scope_id: 'lumaseat', mode: 'observe',
        claimed_actor: 'istvan', reason: 'incident', ttl_minutes: 60 * 24 * 365,
      },
      resolveApgPrincipal(OPERATOR_SESSION),
      scopeDeps([], now),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Date.parse(result.override.expires_at!) - now.getTime())
      .toBe(MAX_DOWNGRADE_TTL_MINUTES * 60_000)
  })

  it('an expired downgrade stops applying by itself, back toward the STRICTER mode', () => {
    setOverride('APG_MODE', 'enforced')
    const t0 = new Date('2026-08-13T12:00:00Z')
    const result = setScopeOverride(
      {
        scope_type: 'project', scope_id: 'lumaseat', mode: 'observe',
        claimed_actor: 'istvan', reason: 'incident', ttl_minutes: 30,
      },
      resolveApgPrincipal(OPERATOR_SESSION),
      scopeDeps([], t0),
    )
    expect(result.ok).toBe(true)
    // Inside the window the downgrade applies...
    expect(resolveEffectiveApgMode('lumaseat', null, new Date(t0.getTime() + 10 * 60_000)).mode)
      .toBe('observe')
    // ...and outside it, nothing has to remember to revoke anything.
    expect(resolveEffectiveApgMode('lumaseat', null, new Date(t0.getTime() + 31 * 60_000)).mode)
      .toBe('enforced')
  })

  it('ATTACK: an operator credential does not let the card\'s own PRODUCER downgrade it', () => {
    setOverride('APG_MODE', 'enforced')
    const result = setScopeOverride(
      {
        scope_type: 'kanban_card', scope_id: 'deadbeef', mode: 'observe',
        claimed_actor: 'buildfejleszto', reason: 'my own gate is in my way',
      },
      resolveApgPrincipal(OPERATOR_SESSION),
      scopeDeps(['buildfejleszto']),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.error).toMatch(/producer/i)
  })

  it('§25: when the producer question cannot be answered at all, enforced fails CLOSED', () => {
    setOverride('APG_MODE', 'enforced')
    const refused = setScopeOverride(
      {
        scope_type: 'kanban_card', scope_id: 'deadbeef', mode: 'observe',
        claimed_actor: 'istvan', reason: 'incident',
      },
      resolveApgPrincipal(OPERATOR_SESSION),
      scopeDeps(null),
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.status).toBe(403)

    // ...while a non-enforced parent fails OPEN, and says the check was blind.
    setOverride('APG_MODE', 'assisted')
    const allowed = setScopeOverride(
      {
        scope_type: 'kanban_card', scope_id: 'deadbeef', mode: 'observe',
        claimed_actor: 'istvan', reason: 'incident',
      },
      resolveApgPrincipal(OPERATOR_SESSION),
      scopeDeps(null),
    )
    expect(allowed.ok).toBe(true)
    const written = auditEvents().filter((e) => e.type === 'scope_override_set')
    expect(written.at(-1)!.detail.producer_check).toBe('unknown')
  })

  it('the producer set really comes from the §11.2 role column, not from a guess', async () => {
    // End-to-end: dispatch a card, then ask the same question the policy asks.
    createKanbanCard({ id: 'aabbccdd', title: 'role probe', assignee: MAIN_AGENT_ID, status: 'planned' } as any)
    const move = fakeCtx('/api/kanban/aabbccdd/move', 'POST', { status: 'in_progress' })
    expect(await tryHandleKanban(move.ctx)).toBe(true)
    expect(resolveCardRoleAgents(getDb(), 'aabbccdd').producer).toBe(MAIN_AGENT_ID)
  })
})

// ===========================================================================
// Item 2 -- §25: the archive gate is a server control now
// ===========================================================================

describe('§25: server-side enforcement of the unaccepted-archive gate', () => {
  function card(id: string): void {
    createKanbanCard({ id, title: 'unaccepted work', status: 'done' } as any)
  }

  it('ATTACK: a curl with the shared token can no longer archive under enforced mode', async () => {
    setOverride('APG_MODE', 'enforced')
    setOverride('APG_BLOCK_UNACCEPTED_ARCHIVE', '1')
    card('cafe0001')

    // No browser, no client gate, no Origin header -- just the request the
    // audit said walked straight through. The sidecar is unreachable, which is
    // the §25 fail-closed branch the client version used to fail OPEN on.
    const { ctx, out } = fakeCtx('/api/kanban/cafe0001/archive', 'POST', {}, FLEET_TOKEN)
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.error).toMatch(/§25/)
    expect(out.body.apg.blocked).toBe(true)
    expect(out.body.apg.degraded).toBe(true)
    // The card is still on the board. That is the whole point.
    expect(getKanbanCard('cafe0001')?.archived_at ?? null).toBeNull()
  })

  it('even an OPERATOR is refused -- this control is about acceptance, not about privilege', async () => {
    setOverride('APG_MODE', 'enforced')
    setOverride('APG_BLOCK_UNACCEPTED_ARCHIVE', '1')
    card('cafe0002')
    const { ctx, out } = fakeCtx('/api/kanban/cafe0002/archive', 'POST', {}, OPERATOR_SESSION)
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(403)
  })

  it('§25: non-APG Marveen stays available -- with APG off the same request archives', async () => {
    setOverride('APG_MODE', 'off')
    setOverride('APG_BLOCK_UNACCEPTED_ARCHIVE', '1')
    card('cafe0003')
    const { ctx, out } = fakeCtx('/api/kanban/cafe0003/archive', 'POST', {}, FLEET_TOKEN)
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(out.body.apg.reason).toBe('apg_off')
  })

  it('an operator who switched the control OFF gets a named pass, not a silent one', async () => {
    setOverride('APG_MODE', 'enforced')
    setOverride('APG_BLOCK_UNACCEPTED_ARCHIVE', '0')
    card('cafe0004')
    const { ctx, out } = fakeCtx('/api/kanban/cafe0004/archive', 'POST', {}, FLEET_TOKEN)
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.ok).toBe(true)
    expect(out.body.apg.reason).toMatch(/control_disabled:APG_BLOCK_UNACCEPTED_ARCHIVE/)
    expect(out.body.apg.accepted).toBeNull()
  })

  // The unaccepted-work branch needs a work item, which needs a kernel sidecar.
  // The gate is a pure function over injected deps precisely so this branch is
  // testable without one -- and so the §25 ladder can be read in one place.
  const unacceptedItem = {
    id: 'wi-1', kanban_card_id: 'cafe0005', effective_mode: 'enforced',
    acceptance_status: 'done_not_accepted',
  } as unknown as ApgUiWorkItemSummary

  function gateDeps(over: Partial<ArchiveGateDeps> = {}): ArchiveGateDeps {
    return {
      resolveMode: () => ({ mode: 'enforced', source: 'global' }),
      isControlEnabled: () => true,
      listWorkItems: () => ({ items: [unacceptedItem] }),
      ...over,
    }
  }

  it('enforced refuses unaccepted work, and names why', () => {
    const decision = evaluateArchiveGate({ cardId: 'cafe0005', project: null }, gateDeps())
    expect(decision.allow).toBe(false)
    if (decision.allow) return
    expect(decision.status).toBe(403)
    expect(decision.report.accepted).toBe(false)
    expect(decision.report.reason).toMatch(/unaccepted_work_item:done_not_accepted/)
  })

  it('assisted lets it through but never reports a PASS (§25: "ne mutass hamis PASS-t")', () => {
    const decision = evaluateArchiveGate(
      { cardId: 'cafe0005', project: null },
      gateDeps({ resolveMode: () => ({ mode: 'assisted', source: 'global' }) }),
    )
    expect(decision.allow).toBe(true)
    expect(decision.report.accepted).toBe(false)
    expect(decision.report.blocked).toBe(false)
  })

  it('observe fails open on a control-plane failure, with an EXPLICIT degraded state', () => {
    const decision = evaluateArchiveGate(
      { cardId: 'cafe0005', project: null },
      gateDeps({
        resolveMode: () => ({ mode: 'observe', source: 'global' }),
        listWorkItems: () => ({ error: 'sidecar_unavailable' }),
      }),
    )
    expect(decision.allow).toBe(true)
    expect(decision.report.degraded).toBe(true)
    // Never `accepted: true` by omission -- "we could not look" has its own value.
    expect(decision.report.accepted).toBeNull()
    expect(decision.report.reason).toMatch(/control_plane_unavailable/)
  })

  it('a throwing read model lands in the same branch as a reported error, not in a 500', () => {
    const decision = evaluateArchiveGate(
      { cardId: 'cafe0005', project: null },
      gateDeps({ listWorkItems: () => { throw new Error('db locked') } }),
    )
    expect(decision.allow).toBe(false)
    if (decision.allow) return
    expect(decision.status).toBe(403)
    expect(decision.report.degraded).toBe(true)
  })

  it('an accepted card archives normally in enforced mode -- the gate is not a blanket block', () => {
    const decision = evaluateArchiveGate(
      { cardId: 'cafe0006', project: null },
      gateDeps({
        listWorkItems: () => ({
          items: [{ ...unacceptedItem, acceptance_status: 'accepted' } as ApgUiWorkItemSummary],
        }),
      }),
    )
    expect(decision.allow).toBe(true)
    expect(decision.report.accepted).toBe(true)
  })
})

// ===========================================================================
// Item 3 -- §11.4 / §26.2: the approver is named by the server
// ===========================================================================

describe('§11.4: resolved_by comes from the credential, not the body', () => {
  it('ATTACK: a body claiming resolved_by:"Gábor" no longer becomes the approver', async () => {
    createApproval({
      id: 'ap-1', agent_id: 'buildfejleszto', category: 'deploy',
      action_description: 'ship it', action_payload: null, timeout_at: null,
    })
    // The audit's §3.3 request, verbatim in shape: an agent-held token, and the
    // owner's name in the body.
    const { ctx, out } = fakeCtx('/api/approvals/ap-1', 'PATCH', {
      status: 'approved', resolved_by: 'Gábor',
    }, FLEET_TOKEN)
    expect(await tryHandleApprovals(ctx)).toBe(true)
    expect(out.status).toBe(200)

    const stored = getApproval('ap-1')!
    expect(stored.status).toBe('approved')
    // The decisive assertion: the owner's name is NOT the stored attribution.
    expect(stored.resolved_by).not.toBe('Gábor')
    expect(stored.resolved_by).toBe('fleet_token:shared')
    // The claim survives, next to the attribution, labelled as a claim.
    const resolved = auditEvents().filter((e) => e.type === 'approval_resolved')
    expect(resolved.at(-1)!.detail.claimed_by).toBe('Gábor')
    expect(resolved.at(-1)!.detail.resolved_by).toBe('fleet_token:shared')
  })

  it('the self-approval guard still fires on the CLAIMED name, and still admits it is best-effort', async () => {
    createApproval({
      id: 'ap-2', agent_id: 'buildfejleszto', category: 'deploy',
      action_description: 'ship it', action_payload: null, timeout_at: null,
    })
    const { ctx, out } = fakeCtx('/api/approvals/ap-2', 'PATCH', {
      status: 'approved', resolved_by: 'buildfejleszto',
    }, FLEET_TOKEN)
    expect(await tryHandleApprovals(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(getApproval('ap-2')!.status).toBe('pending')
  })

  it('a named session attributes to the person, and still refuses to call the human proven', async () => {
    createApproval({
      id: 'ap-3', agent_id: 'buildfejleszto', category: 'deploy',
      action_description: 'ship it', action_payload: null, timeout_at: null,
    })
    const { ctx, out } = fakeCtx('/api/approvals/ap-3', 'PATCH', {
      status: 'approved',
    }, OPERATOR_SESSION)
    expect(await tryHandleApprovals(ctx)).toBe(true)
    expect(getApproval('ap-3')!.resolved_by).toBe('session:istvan')
    expect(out.body.human_principal_proven).toBe(false)
    expect(out.body.human_attestation).toBe('named_session')
  })
})

describe('§11.4/§26.2: the human_required approval category', () => {
  function humanApproval(id: string): void {
    createApproval({
      id, agent_id: 'buildfejleszto', category: HUMAN_REQUIRED_CATEGORY,
      action_description: 'delete production data', action_payload: null, timeout_at: null,
    })
  }

  it('ATTACK: an agent principal cannot resolve a human_required gate, in ANY mode', async () => {
    for (const mode of ['off', 'observe', 'assisted', 'enforced']) {
      resetApgFiles()
      initDatabase(':memory:')
      setOverride('APG_MODE', mode)
      humanApproval(`hr-${mode}`)
      const { ctx, out } = fakeCtx(`/api/approvals/hr-${mode}`, 'PATCH', {
        status: 'approved', resolved_by: 'Gábor',
      }, FLEET_TOKEN)
      expect(await tryHandleApprovals(ctx)).toBe(true)
      // §26's invariant 2 is not mode-scoped: observe does NOT fail open into
      // handing an agent the owner's vote.
      expect(out.status, `mode=${mode}`).toBe(403)
      expect(getApproval(`hr-${mode}`)!.status).toBe('pending')
    }
  })

  it('§25 enforced: an unnamed operator credential is refused -- the required control is "name the human"', async () => {
    setOverride('APG_MODE', 'enforced')
    humanApproval('hr-device')
    const { ctx, out } = fakeCtx('/api/approvals/hr-device', 'PATCH', {
      status: 'approved',
    }, OPERATOR_DEVICE)
    expect(await tryHandleApprovals(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.error).toMatch(/§25/)
  })

  it('§25 assisted: the same credential resolves, marked UNPROVEN rather than shown as a PASS', async () => {
    setOverride('APG_MODE', 'assisted')
    humanApproval('hr-device-assisted')
    const { ctx, out } = fakeCtx('/api/approvals/hr-device-assisted', 'PATCH', {
      status: 'approved',
    }, OPERATOR_DEVICE)
    expect(await tryHandleApprovals(ctx)).toBe(true)
    expect(getApproval('hr-device-assisted')!.status).toBe('approved')
    expect(out.body.human_principal_proven).toBe(false)
    expect(out.body.human_attestation).toBe('device_key')
    const resolved = auditEvents().filter((e) => e.type === 'approval_resolved')
    expect(resolved.at(-1)!.detail.human_required).toBe(true)
    expect(resolved.at(-1)!.detail.human_principal_proven).toBe(false)
    expect(resolved.at(-1)!.detail.attestation_note).toBe('unproven_human:device_key')
  })

  it('the APG decision route enforces the same category rule', async () => {
    setOverride('APG_MODE', 'enforced')
    humanApproval('hr-apg')
    const { ctx, out } = fakeCtx('/api/apg/approvals/hr-apg/decision', 'POST', {
      action: 'accept', idempotency_key: 'k1',
    }, FLEET_TOKEN)
    expect(await tryHandleApg(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(getApproval('hr-apg')!.status).toBe('pending')
  })

  it('an ordinary category is unaffected -- the gate is scoped to human_required', async () => {
    setOverride('APG_MODE', 'enforced')
    createApproval({
      id: 'ordinary', agent_id: 'buildfejleszto', category: 'deploy',
      action_description: 'ship it', action_payload: null, timeout_at: null,
    })
    const { ctx } = fakeCtx('/api/approvals/ordinary', 'PATCH', { status: 'approved' }, FLEET_TOKEN)
    expect(await tryHandleApprovals(ctx)).toBe(true)
    expect(getApproval('ordinary')!.status).toBe('approved')
  })
})
