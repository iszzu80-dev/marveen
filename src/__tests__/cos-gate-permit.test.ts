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

/** Strip line comments, block comments and string/template literals, so a
 *  MENTION of a symbol cannot be mistaken for a call to it. Deliberately crude
 *  and deliberately not a parser: it only has to be right about which
 *  parentheses and commas are code. */
function stripNonCode(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const two = src.slice(i, i + 2)
    if (two === '//') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (two === '/*') { i += 2; while (i < src.length && src.slice(i, i + 2) !== '*/') i++; i += 2; continue }
    const ch = src[i]!
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < src.length && src[i] !== quote) { if (src[i] === '\\') i++; i++ }
      i++
      out += '""'
      continue
    }
    out += ch
    i++
  }
  return out
}

/** Every real `issueAuthorization(...)` call in a file, with how many top-level
 *  arguments it passes. Counting by walking the parentheses is what lets a call
 *  wrapped over four lines be told apart from a four-argument one. */
export function issueAuthorizationCalls(src: string): Array<{ args: number }> {
  const code = stripNonCode(src)
  const calls: Array<{ args: number }> = []
  const re = /\bissueAuthorization\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    let depth = 1
    let i = m.index + m[0].length
    // SEGMENTS, not comma count. A trailing comma before the closing paren is
    // house style here, and counting commas made every correctly-formatted call
    // look like it passed one argument too many.
    const segments: string[] = ['']
    for (; i < code.length && depth > 0; i++) {
      const c = code[i]!
      if ('([{'.includes(c)) { depth++; segments[segments.length - 1] += c; continue }
      if (')]}'.includes(c)) {
        depth--
        if (depth === 0) break
        segments[segments.length - 1] += c
        continue
      }
      if (c === ',' && depth === 1) { segments.push(''); continue }
      segments[segments.length - 1] += c
    }
    calls.push({ args: segments.filter(x => x.trim() !== '').length })
  }
  return calls
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

  it('STANDING CHECK: exactly the three gates mint permits', () => {
    // The half a WeakSet cannot enforce. If a fourth module starts minting, this
    // fails and somebody has to defend the addition — the same shape as the
    // caller check that caught the Reader island.
    //
    // THE THIRD ONE IS DEFENDED HERE, because this test is the place the check
    // sends the next person. `progression-approval-gate.ts` was added by the P4
    // closure (ACTION_APPROVAL_PRODUCER_WIRING) and it authorises a different
    // KIND of thing: not an outbound message, but a progression step Invariant E
    // refused to run autonomously. The two send gates cannot evaluate it —
    // `evaluateDispatch` asks about a connector, a campaign approval and a
    // rendered payload, and a plan step has none of the three. Reusing it would
    // have meant fabricating a campaign so its checks pass, which is a lie told
    // to a safety gate to get a yes out of it.
    //
    // The alternative to a third gate was no gate: let the answer path call
    // `issueAuthorization` directly because "the owner said yes". Everything the
    // new gate checks is a way for that yes to be true and the ticket still
    // wrong — the case moved on, the step was already completed, the kill switch
    // came down, the request went stale, or the risk class is one the owner's
    // own rule forbids an approval to waive.
    const minters = productionSources()
      .filter(f => f !== 'src/cos/gate-permit.ts')
      .filter(f => /\bmintGatePermit\s*\(/.test(readFileSync(join(REPO, f), 'utf8')))
      .sort()
    expect(minters).toEqual([
      'src/cos/dispatch-gate.ts',
      'src/cos/progression-approval-gate.ts',
      'src/cos/zst-send.ts',
    ])
  })

  it('STANDING CHECK: every issueAuthorization call site passes a permit', () => {
    // THE INSTRUMENT WAS WRONG BEFORE IT WAS RIGHT, and the fix is worth the
    // paragraph because the old one was green for two reasons that had nothing
    // to do with the property.
    //
    // It read the file LINE BY LINE and required five comma-separated arguments
    // on ONE line. So a legitimate call formatted across four lines — the house
    // style for a call with a context object — was reported as an offender, and
    // a MENTION of the symbol inside a comment was reported as one too. Both are
    // false positives, and a standing check that cries wolf gets its expectation
    // edited rather than its finding investigated.
    //
    // The failure it could not see is the one that matters: a call written
    // across several lines with only four arguments is a real permit-less call,
    // and the line scanner could not tell it from the four-line legitimate one.
    // So the scan now strips comments and strings, then counts arguments by
    // walking the parentheses.
    const offenders: string[] = []
    for (const f of productionSources().filter(x => x !== 'src/cos/action-authorization.ts')) {
      for (const call of issueAuthorizationCalls(readFileSync(join(REPO, f), 'utf8'))) {
        if (call.args < 5) offenders.push(`${f}: ${call.args} args`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the call-site scanner can actually tell a bad call from a wrapped good one', () => {
    // A scan that never goes red proves nothing about the code it scans. These
    // are the four shapes the old line-based version got wrong or could not see.
    const wrappedGood = `issueAuthorization(\n  db, ctx, now,\n  { ttlSeconds: 60 },\n  permit,\n)`
    const wrappedBad = `issueAuthorization(\n  db, ctx, now,\n  { ttlSeconds: 60 },\n)`
    expect(issueAuthorizationCalls(wrappedGood).map(c => c.args)).toEqual([5])
    expect(issueAuthorizationCalls(wrappedBad).map(c => c.args)).toEqual([4])
    // Commas nested inside an argument are not argument separators.
    expect(issueAuthorizationCalls('issueAuthorization(db, ctx, now, { a: 1, b: 2 })').map(c => c.args)).toEqual([4])
    // A mention in prose is not a call.
    expect(issueAuthorizationCalls('// calls issueAuthorization(...) eventually')).toEqual([])
    expect(issueAuthorizationCalls('/* issueAuthorization(a,b,c,d,e) */')).toEqual([])
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
