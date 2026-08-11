// §22.2: only the deterministic gate may issue an authorization ticket.
// Review #3, Ú-4 — carried unchanged through review #4, fixed here.
//
// The old state was honest about itself: `issueAuthorization` was an ordinary
// export and the module comment said "this is a code review rule, not something
// the type system enforces". The opaque 32-byte id defends against GUESSING a
// ticket. Nothing defended against MINTING one — two lines and an import.
//
// What is enforced now, and what is not, stated plainly: a permit cannot be
// hand-written, because membership of the WeakSet is granted only inside
// gate-permit.ts. A determined caller in the same process can still import that
// module and mint — so the second half of the defence is the standing check at
// the bottom, which fails the moment a third module starts minting.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { issueAuthorization, type AuthorizationContext } from '../cos/action-authorization.js'
import { mintGatePermit, isGatePermit, gatePermitRefusal } from '../cos/gate-permit.js'

const T0 = 1_700_000_000

/** Every PRODUCTION TypeScript file — `src` and `scripts`, recursively, tests
 *  excluded. The standing checks below used to read `src/cos` only (review #5,
 *  Ö-5): a caller one directory over was invisible to them, and the point of a
 *  standing check is tomorrow's caller, which the codebase has already shown
 *  moves between layers. Paths are returned repo-relative so a failure names the
 *  offender in the form a person can open. */
const REPO = process.cwd()
function productionSources(roots: string[] = ['src', 'scripts']): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue
        walk(rel)
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(rel)
      }
    }
  }
  for (const r of roots) walk(r)
  return out.sort()
}

const ctx: AuthorizationContext = {
  domain: 'personal', caseId: 'c1', caseVersion: 1, goalVersion: null,
  actionId: 'led-1', actionType: 'EMAIL_SEND', intent: 'SEND_APPROVED_EMAIL',
  targetReference: null, recipient: 'a@b.hu', payloadHash: 'ph', approvalId: null,
}

describe('§22.2 gate permit', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('HEADLINE: a hand-written "decision" cannot issue a ticket', () => {
    // Exactly what a caller would write to forge one. It has the right shape and
    // says allowed — and it is refused, because shape is not provenance.
    const forged = { allowed: true, reasons: [] }
    expect(() => issueAuthorization(getDb(), ctx, T0, {}, forged))
      .toThrow(/minted by a deterministic gate/)
  })

  it('no permit at all is refused', () => {
    expect(() => issueAuthorization(getDb(), ctx, T0)).toThrow(/issueAuthorization refused/)
  })

  it('a gate decision that REFUSED cannot issue a ticket either', () => {
    // The "ran the gate and ignored the answer" case. Minted, so provenance is
    // real; not allowed, so it must not buy a ticket.
    const refused = mintGatePermit({ allowed: false, reasons: ['connector down'] })
    expect(() => issueAuthorization(getDb(), ctx, T0, {}, refused))
      .toThrow(/the gate refused this action: connector down/)
  })

  it('a minted, allowed decision issues a ticket', () => {
    // The counter-case: a check that refuses everything is not a check.
    const permit = mintGatePermit({ allowed: true, reasons: [] })
    const ticket = issueAuthorization(getDb(), ctx, T0, {}, permit)
    expect(ticket.authorizationId).toMatch(/^[0-9a-f]{64}$/)
  })

  it('membership cannot be faked by copying the object', () => {
    const permit = mintGatePermit({ allowed: true, reasons: [] })
    expect(isGatePermit(permit)).toBe(true)
    // A structural clone carries every property and no provenance.
    expect(isGatePermit({ ...permit })).toBe(false)
    expect(isGatePermit(JSON.parse(JSON.stringify(permit)))).toBe(false)
  })

  it('the refusal message says which of the two conditions failed', () => {
    // A gate whose refusals are indistinguishable teaches nothing to the person
    // reading the log at 3am.
    expect(gatePermitRefusal(undefined)).toMatch(/minted by a deterministic gate/)
    expect(gatePermitRefusal(mintGatePermit({ allowed: false, reasons: [] })))
      .toMatch(/the gate refused/)
    expect(gatePermitRefusal(mintGatePermit({ allowed: true, reasons: [] }))).toBeNull()
  })

  it('STANDING CHECK: exactly the two gates mint permits', () => {
    // The half a WeakSet cannot enforce. If a third module starts minting, this
    // fails and somebody has to defend the addition — the same shape as the
    // caller check that caught the Reader island.
    const minters = productionSources()
      .filter(f => f !== 'src/cos/gate-permit.ts')
      .filter(f => /\bmintGatePermit\s*\(/.test(readFileSync(join(REPO, f), 'utf8')))
      .sort()
    expect(minters).toEqual(['src/cos/dispatch-gate.ts', 'src/cos/zst-send.ts'])
  })

  it('STANDING CHECK: every issueAuthorization call site passes a permit', () => {
    const offenders: string[] = []
    for (const f of productionSources().filter(x => x !== 'src/cos/action-authorization.ts')) {
      const src = readFileSync(join(REPO, f), 'utf8')
      for (const line of src.split('\n')) {
        if (!/\bissueAuthorization\s*\(/.test(line)) continue
        // A call with fewer than five arguments cannot be carrying a permit.
        if (!/issueAuthorization\([^)]*,[^)]*,[^)]*,[^)]*,[^)]*\)/.test(line)) offenders.push(`${f}: ${line.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('STANDING CHECK: the scan itself reaches outside src/cos', () => {
    // The check above is only worth what its SCAN covers. Review #5 (Ö-5) found
    // both standing checks reading `src/cos` alone: a mintGatePermit or
    // issueAuthorization call from `src/web/routes/` or `scripts/` would have
    // walked past both of them. There is no such caller today — which is exactly
    // why this needed an assertion rather than a reading, since a scan that
    // covers nothing passes the two tests above just as quietly as a correct one.
    const files = productionSources()
    expect(files).toContain('src/cos/gate-permit.ts')
    expect(files.some(f => f.startsWith('src/web/routes/'))).toBe(true)
    expect(files.some(f => f.startsWith('scripts/'))).toBe(true)
    // Tests are deliberately NOT scanned: this very file names both symbols.
    expect(files.some(f => f.includes('__tests__'))).toBe(false)
  })
})
