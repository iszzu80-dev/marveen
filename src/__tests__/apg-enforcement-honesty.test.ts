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
    const route = readFileSync(join(process.cwd(), 'src/web/routes/apg.ts'), 'utf8')
    const map = route.slice(route.indexOf('apg_enforcement_wired'))
    expect(map).toMatch(/require_claim_receipt: false/)
    expect(map).toMatch(/require_independent_acceptance: false/)
    expect(map).toMatch(/require_owner_decision: false/)
    expect(map).toMatch(/block_unaccepted_archive: true/)
  })

  it('the frontend carries the map into its enforcement state', () => {
    // Published-but-unread would be the same defect one layer along.
    const ui = readFileSync(join(process.cwd(), 'web/apg.js'), 'utf8')
    expect(ui).toMatch(/wired: summary\.apg_enforcement_wired/)
  })
})

describe('F-5: the APG decision path has the self-approval guard', () => {
  it('HEADLINE: the guard exists and runs BEFORE the approval is resolved', () => {
    // §27 makes weakening the self-approval guard an explicit stop condition,
    // and this route simply did not have the check the generic route has.
    const src = readFileSync(join(process.cwd(), 'src/web/routes/apg.ts'), 'utf8')
    const decision = src.slice(src.indexOf("const action = body.action as OwnerAction"))
    expect(decision).toMatch(/cannot approve its own request/)
    expect(decision.indexOf('cannot approve its own request'))
      .toBeLessThan(decision.indexOf('resolveApproval(approvalId'))
  })

  it('it answers 403, the same as the generic route', () => {
    const src = readFileSync(join(process.cwd(), 'src/web/routes/apg.ts'), 'utf8')
    const decision = src.slice(src.indexOf("const action = body.action as OwnerAction"))
    const guard = decision.slice(0, decision.indexOf('resolveApproval(approvalId'))
    expect(guard).toMatch(/\}, 403\)/)
  })
})
