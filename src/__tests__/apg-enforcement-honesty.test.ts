// F-5 and F-6 (APG 0.4 review): a switch must not promise what it does not do.
//
// F-6 is the same class as tonight's Reader island, seen from the operator's
// side: three of four enforcement toggles existed, appeared in the summary, were
// copied into the frontend's enforcement state — and had no consumer anywhere.
// Flip "require independent acceptance", the UI reports success, and the
// constraint does not exist. An absent switch is honest; a switch that lies is
// worse than nothing, because someone stops looking after flipping it.
//
// The fix here is deliberately NOT to invent enforcement semantics under time
// pressure. It is to publish which toggles are wired, derived from the actual
// call sites — so the UI can render "not yet enforced" instead of implying a
// rule that is not there.
//
// ── APG 1.9 WP3 update ────────────────────────────────────────────────────
// The 1.8 conformance audit found the honest map was itself half-honest. The
// one toggle published as `wired: true` WAS wired — to browser JavaScript. Its
// consumer was `web/apg.js`, and the server route it appeared to guard had no
// check at all, so a curl with the shared fleet token walked straight past it
// (audit §3.1). "Has a consumer" turned out to be a weaker property than the
// map implied, and the map had no vocabulary for the difference.
//
// So this file now asserts TWO things per control, not one: that it has a
// consumer, and WHERE that consumer refuses. Same discipline, one axis deeper.
// The three unwired toggles are still asserted unwired — WP3 deliberately did
// not invent semantics for them either.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Every .ts/.js source file outside tests, so a new consumer anywhere counts. */
function sourceFiles(root: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry.startsWith('.')) continue
    const full = join(root, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.(ts|js)$/.test(entry)) acc.push(full)
  }
  return acc
}

/**
 * Files that READ a toggle, as opposed to declaring or echoing it.
 *
 * The discriminator matters: `require_claim_receipt: summary.apg_...` is an
 * object-literal key being COPIED, which is exactly what made all four toggles
 * look consumed while three enforced nothing. A read looks like
 * `state.require_claim_receipt` — the flag reached for, not assigned.
 */
function consumersOf(flag: string): string[] {
  const isRead = (line: string): boolean =>
    new RegExp(`\\.${flag}\\b`).test(line) && !new RegExp(`\\b${flag}\\s*:`).test(line)
  return sourceFiles(join(process.cwd(), 'src'))
    .concat(sourceFiles(join(process.cwd(), 'web')))
    .filter(f => readFileSync(f, 'utf8').split('\n').some(isRead))
}

/**
 * Files under a given root that read the SETTING behind a toggle. The frontend
 * reads the summary field; the server reads the setting. Before WP3 only the
 * first existed for the archive gate, and consumersOf() could not tell you that.
 */
function settingReaders(settingKey: string, root: string): string[] {
  return sourceFiles(join(process.cwd(), root))
    .filter(f => readFileSync(f, 'utf8').includes(settingKey))
}

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

describe('F-6: the published wiring map matches reality', () => {
  it('HEADLINE: block_unaccepted_archive is the only toggle with a consumer', () => {
    // If this ever fails because a NEW consumer appeared, the fix is to update
    // the published map — the failure is the point: a toggle that starts
    // enforcing must stop being advertised as unwired, and vice versa.
    expect(consumersOf('block_unaccepted_archive').length).toBeGreaterThan(0)
    expect(consumersOf('require_claim_receipt')).toEqual([])
    expect(consumersOf('require_independent_acceptance')).toEqual([])
    expect(consumersOf('require_owner_decision')).toEqual([])
  })

  it('the summary publishes the map, and it says what the greps say', () => {
    const route = read('src/web/routes/apg.ts')
    const map = route.slice(route.indexOf('apg_enforcement_wired'))
    expect(map).toMatch(/require_claim_receipt: false/)
    expect(map).toMatch(/require_independent_acceptance: false/)
    expect(map).toMatch(/require_owner_decision: false/)
    expect(map).toMatch(/block_unaccepted_archive: true/)
  })

  it('the frontend carries the map into its enforcement state', () => {
    // Published-but-unread would be the same defect one layer along.
    const ui = read('web/apg.js')
    expect(ui).toMatch(/wired: summary\.apg_enforcement_wired/)
  })
})

describe('WP3/§25: the one wired control now refuses on the SERVER', () => {
  it('HEADLINE: the archive control is read server-side, not only in the browser', () => {
    // The 1.8 audit's finding 3.1 in one assertion. Before WP3 this list was
    // empty and web/apg.js was the whole control; if it ever empties again,
    // enforced mode has silently become a dialog box.
    expect(settingReaders('APG_BLOCK_UNACCEPTED_ARCHIVE', 'src').length).toBeGreaterThan(0)
    expect(settingReaders('APG_BLOCK_UNACCEPTED_ARCHIVE', 'src'))
      .toContain(join(process.cwd(), 'src/web/apg-archive-gate.ts'))
  })

  it('the archive ROUTE evaluates the gate before it archives anything', () => {
    const kanban = read('src/web/routes/kanban.ts')
    const archive = kanban.slice(kanban.indexOf('kanbanArchiveMatch && method'))
    const gateIdx = archive.indexOf('evaluateArchiveGate(')
    const archiveIdx = archive.indexOf('archiveKanbanCard(id)')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(gateIdx).toBeLessThan(archiveIdx)
    // The refusal must be a real HTTP refusal, not a logged warning.
    expect(archive.slice(gateIdx, archiveIdx)).toMatch(/if \(!gate\.allow\)/)
    expect(archive.slice(gateIdx, archiveIdx)).toMatch(/gate\.status/)
  })

  it('§25 ladder: enforced fails closed on BOTH branches, observe/assisted fail open but flagged', () => {
    const gate = read('src/web/apg-archive-gate.ts')
    // Two independent refusals in enforced mode: unaccepted work, and a
    // control plane that could not be read at all. The second is the one the
    // client used to get wrong.
    expect(gate.match(/mode === 'enforced'/g)?.length).toBeGreaterThanOrEqual(2)
    // Fail-open paths must never report a pass by omission.
    expect(gate).toMatch(/degraded: true/)
    expect(gate).toMatch(/accepted: null/)
  })

  it('the summary distinguishes WHERE a wired control refuses', () => {
    const route = read('src/web/routes/apg.ts')
    const map = route.slice(route.indexOf('apg_enforcement_enforced_by'))
    expect(map).toMatch(/block_unaccepted_archive: 'server'/)
    // The three unwired toggles enforce nowhere, and say so in both maps.
    expect(map).toMatch(/require_claim_receipt: null/)
    expect(map).toMatch(/require_independent_acceptance: null/)
    expect(map).toMatch(/require_owner_decision: null/)
  })
})

describe('WP3/§24.0.5: a scope downgrade is an authority act, not a form field', () => {
  it('HEADLINE: a non-operator principal cannot downgrade, and the refusal precedes the write', () => {
    const store = read('src/web/apg-scope-overrides.ts')
    const fn = store.slice(store.indexOf('export function setScopeOverride('))
    const guardIdx = fn.indexOf('isOperatorPrincipal(principal)')
    const writeIdx = fn.indexOf('atomicWriteFileSync(')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(writeIdx)
    expect(fn.slice(guardIdx, writeIdx)).toMatch(/status: 403/)
  })

  it('updated_by is the resolved principal, never the request body', () => {
    const store = read('src/web/apg-scope-overrides.ts')
    expect(store).toMatch(/updated_by: principal\.attribution/)
    // The body's value survives only under a name that admits what it is.
    expect(store).toMatch(/claimed_actor: claimedActor/)
    const route = read('src/web/routes/apg.ts')
    expect(route).not.toMatch(/updated_by: body\.actor/)
    expect(route).toMatch(/claimed_actor: body\.actor\.trim\(\)/)
  })

  it('a downgrade is bounded in time and the bound is honoured on read', () => {
    const store = read('src/web/apg-scope-overrides.ts')
    expect(store).toMatch(/MAX_DOWNGRADE_TTL_MINUTES/)
    // The expiry is only real if the resolver drops expired rows.
    const resolver = store.slice(store.indexOf('export function resolveEffectiveApgMode('))
    expect(resolver).toMatch(/isExpired/)
  })
})

describe('WP3/§11.4: the approver is named by the server or not at all', () => {
  it('HEADLINE: the generic approvals route no longer stores the body\'s resolved_by', () => {
    const src = read('src/web/routes/approvals.ts')
    // This is the 1.8 audit's finding 3.3 in one line. The call must pass the
    // server-derived principal; the old form passed `resolved_by.trim()`.
    expect(src).toMatch(/resolveApproval\(idMatch\[1\], status, principal\.attribution, msgId\)/)
    expect(src).not.toMatch(/resolveApproval\(idMatch\[1\], status, resolved_by/)
  })

  it('the APG decision route names the principal, not the surface', () => {
    const src = read('src/web/routes/apg.ts')
    expect(src).toMatch(/resolveApproval\(approvalId, mappedStatus, principal\.attribution/)
    expect(src).not.toMatch(/resolveApproval\(approvalId, mappedStatus, 'dashboard'/)
  })

  it('human_required exists as a category and is refused for an agent principal', () => {
    const policy = read('src/web/apg-human-approval.ts')
    expect(policy).toMatch(/HUMAN_REQUIRED_CATEGORY = 'human_required'/)
    expect(policy).toMatch(/isOperatorPrincipal\(principal\)/)
    expect(policy).toMatch(/status: 403/)
    // Both resolution routes must consult it — a policy one route skips is not
    // a policy, it is a suggestion.
    expect(read('src/web/routes/approvals.ts')).toMatch(/checkHumanApprovalAuthority\(/)
    expect(read('src/web/routes/apg.ts')).toMatch(/checkHumanApprovalAuthority\(/)
  })

  it('HONEST LIMIT: no human principal is ever claimed to be proven', () => {
    // The load-bearing admission of this whole work package. A session cookie
    // is not a human. If someone ever flips this to true, it must be because a
    // real authenticated human principal landed — and this test failing is how
    // that change announces itself instead of arriving quietly.
    const policy = read('src/web/apg-human-approval.ts')
    expect(policy).not.toMatch(/humanPrincipalProven: true/)
    const route = read('src/web/routes/apg.ts')
    expect(route).toMatch(/apg_human_principal_available: false/)
  })
})

describe('F-5: the APG decision path has the self-approval guard', () => {
  it('HEADLINE: the guard exists and runs BEFORE the approval is resolved', () => {
    // §27 makes weakening the self-approval guard an explicit stop condition,
    // and this route simply did not have the check the generic route has.
    const src = read('src/web/routes/apg.ts')
    const decision = src.slice(src.indexOf("const action = body.action as OwnerAction"))
    expect(decision).toMatch(/cannot approve its own request/)
    expect(decision.indexOf('cannot approve its own request'))
      .toBeLessThan(decision.indexOf('resolveApproval(approvalId'))
  })

  it('it answers 403, the same as the generic route', () => {
    const src = read('src/web/routes/apg.ts')
    const decision = src.slice(src.indexOf("const action = body.action as OwnerAction"))
    const guard = decision.slice(0, decision.indexOf('resolveApproval(approvalId'))
    expect(guard).toMatch(/\}, 403\)/)
  })
})
