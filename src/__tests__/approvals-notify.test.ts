import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getPendingMessages } from '../db.js'

// Override MAIN_AGENT_ID before the route module loads so the notification
// targets the configured value, not a hardcoded agent id.
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'agent-a' }
})

import { tryHandleApprovals } from '../web/routes/approvals.js'
import type { RouteContext } from '../web/routes/types.js'

function fakePost(path: string, body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path: url.pathname, method: 'POST', url } as RouteContext, out }
}

/** `auth` is what the GATE resolved for this request, and it is the only
 *  identity the route may believe. Defaults to the shared fleet bearer, because
 *  that is what every fleet curl call carries — and what proves nothing. */
function fakePatch(
  id: string, body: unknown,
  auth: RouteContext['auth'] = { kind: 'token' },
): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const path = `/api/approvals/${id}`
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path, method: 'PATCH', url, auth } as RouteContext, out }
}

async function createApprovalFor(agentId: string): Promise<string> {
  const { ctx, out } = fakePost('/api/approvals', {
    agent_id: agentId, category: 'email_send', action_description: 'Send report',
  })
  await tryHandleApprovals(ctx)
  expect(out.status).toBe(201)
  return out.body.id as string
}

describe('approvals notification target', () => {
  beforeEach(() => {
    initDatabase(':memory:')
  })

  it('sends the inter-agent notification to MAIN_AGENT_ID, not a hardcoded agent id', async () => {
    const { ctx, out } = fakePost('/api/approvals', {
      agent_id: 'agent-b',
      category: 'email_send',
      action_description: 'Send weekly digest',
    })

    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(201)

    // The notification must go to the mocked MAIN_AGENT_ID value.
    const pending = getPendingMessages('agent-a')
    expect(pending.length).toBe(1)
    expect(pending[0].to_agent).toBe('agent-a')
    expect(pending[0].from_agent).toBe('system')
    expect(pending[0].content).toContain('[APPROVAL_REQUEST]')

    // Regression guard: no message may land on a different target.
    const wrongTarget = getPendingMessages('agent-b')
    expect(wrongTarget.length).toBe(0)
  })
})

describe('approval resolution is bound to an authenticated principal', () => {
  // WHAT THIS REPLACES. Resolution identity was `resolved_by` from the request
  // BODY, guarded only by `resolved_by === target.agent_id`. Every fleet agent
  // holds the same bearer token, so any of them approved its own request by
  // writing `resolved_by: "istvan"`. The guard was not weak — it checked a value
  // the caller picks.
  beforeEach(() => {
    initDatabase(':memory:')
  })

  it('REFUSES to approve for a shared-token caller: it cannot prove it is not the requester', async () => {
    const id = await createApprovalFor('agent-b')
    const { ctx, out } = fakePatch(id, { status: 'approved', resolved_by: 'istvan' })
    expect(await tryHandleApprovals(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.code).toBe('unattributable_caller')
  })

  it('the same token caller MAY reject — the safe direction needs no identity', async () => {
    // Rejecting takes authority away. A self-rejection gains an agent nothing,
    // so the Telegram "NEM" relay keeps working on the shared token.
    const id = await createApprovalFor('agent-b')
    const { ctx, out } = fakePatch(id, { status: 'rejected', resolved_by: 'telegram_text' })
    expect(await tryHandleApprovals(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.status).toBe('rejected')
  })

  it('a logged-in human MAY approve, and the audit records the PROVEN identity', async () => {
    const id = await createApprovalFor('agent-b')
    const { ctx, out } = fakePatch(
      id, { status: 'approved', resolved_by: 'telegram_text' },
      { kind: 'session', user: 'istvan' },
    )
    expect(await tryHandleApprovals(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.status).toBe('approved')
    // The claimed label survives as provenance; the principal is what is proved.
    //
    // MERGE (APG 1.9 §11.4): the same two facts, in two fields instead of one
    // string. This used to assert `'user:istvan (telegram_text)'` -- proved and
    // claimed concatenated into the audit column. §11.4 forbids any part of a
    // request body from reaching that column, so the claim moved to its own
    // field. Nothing is lost and nothing new is trusted: `resolved_by` is still
    // the server-derived identity, `claimed_by` is still the caller's label,
    // and a reader can now tell them apart without parsing.
    expect(out.body.resolved_by).toBe('session:istvan')
    expect(out.body.claimed_by).toBe('telegram_text')
  })

  it('an enrolled device MAY approve', async () => {
    const id = await createApprovalFor('agent-b')
    const { ctx, out } = fakePatch(
      id, { status: 'approved', resolved_by: 'cli' },
      { kind: 'device', device: 'istvan-laptop' },
    )
    expect(await tryHandleApprovals(ctx)).toBe(true)
    expect(out.status).toBe(200)
    // Same split as above: proved identity in `resolved_by`, claim in `claimed_by`.
    expect(out.body.resolved_by).toBe('device:istvan-laptop')
    expect(out.body.claimed_by).toBe('cli')
  })

  it('self-approval stays refused even for a strong principal', async () => {
    const id = await createApprovalFor('agent-b')
    const { ctx, out } = fakePatch(
      id, { status: 'approved', resolved_by: 'agent-b' },
      { kind: 'session', user: 'istvan' },
    )
    expect(await tryHandleApprovals(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.error).toMatch(/cannot approve its own request/)
  })

  it('a federation peer may not resolve this instance\'s approvals at all', async () => {
    const id = await createApprovalFor('agent-b')
    const { ctx, out } = fakePatch(
      id, { status: 'approved', resolved_by: 'peer' },
      { kind: 'federation', peer: 'other-instance' },
    )
    expect(await tryHandleApprovals(ctx)).toBe(true)
    expect(out.status).toBe(403)
  })
})
