// APG 1.9 §15.2 / §15.3-e / §28.16 (WP6) -- done is a CLAIM, not an acceptance.
//
// THIS FILE IS ATTACK-SHAPED ON PURPOSE. The 1.8 conformance audit's WP6 finding
// was not that a feature was missing; it was that a CLAIM WAS BEING MADE. The
// kanban done handler wrote `outcome='accepted', evidence='kanban:done'` for
// every dispatch on the card, and `cost_per_accepted_task` and
// `first_pass_acceptance` were computed off those rows -- so "accepted", in the
// only namespace with numbers attached to it, meant "a producer curled its own
// card to done". §28.16's RED condition is that sentence: "`done` automatikusan
// `accepted`-et jelent verification nélkül".
//
// So the first and most important test here does not check that the new path
// works. It drives the REAL move endpoint, with every credential class the
// server can resolve, and asserts that the OLD ROW CANNOT BE PRODUCED. A
// regression that re-added the old writer would pass a feature test and fail
// this one, which is the right way round.
//
// The route is exercised through the same fake-ServerResponse RouteContext
// harness apg-ui-routes.test.ts uses -- a real handler against a real in-memory
// database, with no HTTP server booted (this repo's dashboard must never be
// live-booted in a sandbox).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RouteContext } from '../web/routes/types.js'

// The dispatch origin reaches into agent config, tmux and transcript scanning.
// None of that is what this file is about, and all of it is doubled so a `done`
// move exercises the REAL outcome/claim path and nothing else.
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const { initDatabase, getDb, createKanbanCard } = await import('../db.js')
const { tryHandleKanban } = await import('../web/routes/kanban.js')
const { createDispatch, resolveOutcome } = await import('../costops/dispatch.js')
const {
  resolveClaimAuthority, listCompletionClaims,
  EXCLUDED_CLAIM_AUTHORITIES, COMPLETION_CLAIM_AUTHORITIES,
} = await import('../apg/completion-claim.js')

function fakeMoveCtx(cardId: string, status: string, auth?: RouteContext['auth'], actor?: string) {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } } },
  }
  const url = new URL(`http://localhost:3420/api/kanban/${cardId}/move`)
  const req: any = {
    on(event: string, cb: (...args: any[]) => void) {
      if (event === 'data') cb(Buffer.from(JSON.stringify({ status, sort_order: 0, actor })))
      if (event === 'end') cb()
      return req
    },
  }
  const ctx = { req, res, path: url.pathname, method: 'POST', url, auth } as RouteContext
  return { ctx, out }
}

/** The shared bearer every dispatched agent is handed (kanban.ts writes the
 *  `cat .dashboard-token` curl into the dispatch message itself). */
const FLEET: RouteContext['auth'] = { kind: 'token' }
/** A credential no dispatched agent can obtain (apg-principal.ts). */
const OPERATOR: RouteContext['auth'] = { kind: 'session', user: 'istvan' }
const DEVICE: RouteContext['auth'] = { kind: 'device', device: 'istvan-laptop' }

const outcomesOf = (dispatchId: string) =>
  getDb().prepare('SELECT outcome, evidence FROM dispatch_outcomes WHERE dispatch_id = ? ORDER BY rowid')
    .all(dispatchId) as Array<{ outcome: string; evidence: string | null }>

describe('§28.16 attack: a kanban `done` can no longer produce an APG acceptance', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('THE OLD ROW IS UNPRODUCIBLE: no credential class turns `done` into outcome=accepted', async () => {
    const credentials: Array<[string, RouteContext['auth'] | undefined]> = [
      ['fleet token (the dispatched agent itself)', FLEET],
      ['named operator session', OPERATOR],
      ['operator device key', DEVICE],
      ['no credential at all', undefined],
    ]
    const dispatchIds: string[] = []
    for (const [label, auth] of credentials) {
      const cardId = `card-${dispatchIds.length}`
      createKanbanCard({ id: cardId, title: label, assignee: 'dex' })
      dispatchIds.push(createDispatch(getDb(), {
        source: 'kanban', role: 'producer', agent: 'dex', cardId,
      }))
      const { ctx, out } = fakeMoveCtx(cardId, 'done', auth)
      expect(await tryHandleKanban(ctx)).toBe(true)
      expect(out.body).toEqual({ ok: true })
    }

    // Not one `accepted` row exists anywhere, from any of the four.
    const accepted = getDb()
      .prepare("SELECT COUNT(*) AS n FROM dispatch_outcomes WHERE outcome = 'accepted'")
      .get() as { n: number }
    expect(accepted.n).toBe(0)
    // ...and nothing carries the old evidence string either, under any outcome.
    const oldEvidence = getDb()
      .prepare("SELECT COUNT(*) AS n FROM dispatch_outcomes WHERE evidence = 'kanban:done'")
      .get() as { n: number }
    expect(oldEvidence.n).toBe(0)
    // What DID happen: each card recorded a producer completion.
    for (const id of dispatchIds) expect(resolveOutcome(getDb(), id)).toBe('producer_completed')
  })

  it('the completion is recorded as a CLAIM, with the authority the server resolved', async () => {
    createKanbanCard({ id: 'card-1', title: 'A card', assignee: 'dex' })
    createDispatch(getDb(), { source: 'kanban', role: 'producer', agent: 'dex', cardId: 'card-1' })

    const { ctx } = fakeMoveCtx('card-1', 'done', FLEET)
    await tryHandleKanban(ctx)

    const claims = listCompletionClaims(getDb(), 'card-1')
    expect(claims).toHaveLength(1)
    // The card was dispatched to a producer, and the caller presented the token
    // that producer holds -- indistinguishable from a self-report (§15.3-e).
    expect(claims[0].claim_authority).toBe('PRODUCER_SELF_ASSERTED')
    expect(claims[0].claim_source).toBe('kanban_done_move')
    expect(claims[0].claimed_by_class).toBe('token')
    expect(claims[0].claimed_by_attribution).toBe('fleet_token:shared')
  })

  it('the request body cannot upgrade its own authority (§11.4)', async () => {
    createKanbanCard({ id: 'card-1', title: 'A card', assignee: 'dex' })
    createDispatch(getDb(), { source: 'kanban', role: 'producer', agent: 'dex', cardId: 'card-1' })

    // An agent claiming to be the operator in the body it controls.
    const { ctx } = fakeMoveCtx('card-1', 'done', FLEET, 'istvan')
    await tryHandleKanban(ctx)

    const claims = listCompletionClaims(getDb(), 'card-1')
    expect(claims[0].claim_authority).toBe('PRODUCER_SELF_ASSERTED')
    expect(claims[0].claimed_by_attribution).not.toContain('istvan')
  })

  it('an operator move is attributed to the operator, and STILL is not acceptance', async () => {
    createKanbanCard({ id: 'card-1', title: 'A card', assignee: 'dex' })
    const dispatchId = createDispatch(getDb(), { source: 'kanban', role: 'producer', agent: 'dex', cardId: 'card-1' })

    const { ctx } = fakeMoveCtx('card-1', 'done', OPERATOR)
    await tryHandleKanban(ctx)

    const claims = listCompletionClaims(getDb(), 'card-1')
    expect(claims[0].claim_authority).toBe('OPERATOR_ATTESTED')
    // §15.2's acceptance is "verification + acceptance contract satisfied", and
    // a human typing `done` satisfies neither. The strongest available
    // credential still produces a completion, not an acceptance.
    expect(resolveOutcome(getDb(), dispatchId)).toBe('producer_completed')
    expect(outcomesOf(dispatchId).map(r => r.outcome)).toEqual(['producer_completed'])
  })

  it('a move to any other status records no claim and no outcome', async () => {
    createKanbanCard({ id: 'card-1', title: 'A card', assignee: 'dex' })
    const dispatchId = createDispatch(getDb(), { source: 'kanban', role: 'producer', agent: 'dex', cardId: 'card-1' })

    for (const status of ['in_progress', 'waiting', 'planned']) {
      const { ctx } = fakeMoveCtx('card-1', status, OPERATOR)
      await tryHandleKanban(ctx)
    }
    expect(listCompletionClaims(getDb(), 'card-1')).toHaveLength(0)
    expect(resolveOutcome(getDb(), dispatchId)).toBe('unknown')
  })

  it('a card that was never instrumented gets a claim but no invented dispatch', async () => {
    createKanbanCard({ id: 'card-1', title: 'Never dispatched' })
    const { ctx } = fakeMoveCtx('card-1', 'done', OPERATOR)
    await tryHandleKanban(ctx)

    // The claim is a real event on a real card and is recorded...
    expect(listCompletionClaims(getDb(), 'card-1')).toHaveLength(1)
    // ...but no dispatch row is manufactured to hang an outcome on.
    const rows = getDb().prepare('SELECT COUNT(*) AS n FROM dispatches').get() as { n: number }
    expect(rows.n).toBe(0)
    const outcomes = getDb().prepare('SELECT COUNT(*) AS n FROM dispatch_outcomes').get() as { n: number }
    expect(outcomes.n).toBe(0)
  })
})

describe('§15.3-e: the excluded-source policy at the bus boundary', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a fleet-token claim on a card WITH a producer dispatch is self-assertion', () => {
    createKanbanCard({ id: 'card-1', title: 'A card' })
    createDispatch(getDb(), { source: 'kanban', role: 'producer', agent: 'dex', cardId: 'card-1' })
    const resolved = resolveClaimAuthority(getDb(), 'card-1', {
      class: 'fleet', kind: 'token', attribution: 'fleet_token:shared', humanAttestation: 'none',
    })
    expect(resolved.authority).toBe('PRODUCER_SELF_ASSERTED')
    expect(resolved.excluded).toBe(true)
  })

  it('a fleet-token claim on a card with NO producer dispatch is unattributed, not innocent', () => {
    createKanbanCard({ id: 'card-1', title: 'A card' })
    const resolved = resolveClaimAuthority(getDb(), 'card-1', {
      class: 'fleet', kind: 'token', attribution: 'fleet_token:shared', humanAttestation: 'none',
    })
    // We cannot say it is self-assertion; §11.1 says we certainly cannot say it
    // is not. Both fleet cases are EXCLUDED.
    expect(resolved.authority).toBe('FLEET_TOKEN_UNATTRIBUTED')
    expect(resolved.excluded).toBe(true)
  })

  it('every excluded authority is one of the five the vocabulary declares', () => {
    // The cross-repo half of this contract -- that the kernel's
    // CLAIM_LINK_POLICY excludes exactly these words -- lives in
    // apg-projection-contract.test.ts, which owns the kernel-checkout resolver
    // and reports an explicit SKIP rather than a false pass when the kernel is
    // not present. This is the local half: nothing here is excluded by a word
    // the authority vocabulary does not contain.
    for (const authority of EXCLUDED_CLAIM_AUTHORITIES) {
      expect(COMPLETION_CLAIM_AUTHORITIES).toContain(authority)
    }
    // The two operator/verifier authorities are NOT excluded -- they are
    // non-qualifying, which is a different fact and is why the kernel keeps
    // three evidence classes rather than a boolean.
    expect(EXCLUDED_CLAIM_AUTHORITIES).not.toContain('OPERATOR_ATTESTED')
    expect(EXCLUDED_CLAIM_AUTHORITIES).not.toContain('VERIFIER_ATTESTED')
  })
})
