// W10 — "there is no supported direct external WRITE" as a check rather than a
// claim.
//
// WHAT THIS CAN AND CANNOT PROVE, said first so the test is not read as more
// than it is. In a single-process TypeScript codebase anything importable is
// callable; `gate-permit.ts` says so plainly about its own ticket minting. No
// test can prove that no code path anywhere reaches a provider. What this test
// does prove is narrower and still worth having: every module in this repository
// that calls a MUTATING provider endpoint also imports the broker. A new file
// that starts posting to Gmail or Telegram without one turns this red, which
// converts "we agreed not to do that" into something CI notices.
//
// It matches on the URL and the HTTP method together. Matching on the host alone
// would flag every read; matching on `method: 'POST'` alone would flag OAuth
// token refreshes, which are not effects on the world.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src', 'scripts']

/** Provider endpoints that CHANGE something. Token endpoints are excluded on
 *  purpose: refreshing an access token mutates nothing outside our own session. */
const MUTATING_ENDPOINTS: Array<{ name: string; re: RegExp }> = [
  { name: 'gmail send', re: /gmail\.googleapis\.com[^'"`]*\/messages\/send/ },
  { name: 'gmail modify', re: /gmail\.googleapis\.com[^'"`]*\/messages\/[^'"`]*modify/ },
  { name: 'gmail trash', re: /gmail\.googleapis\.com[^'"`]*\/(?:trash|untrash|batchModify)/ },
  { name: 'calendar write', re: /googleapis\.com\/calendar\/v3\/calendars\/[^'"`]*\/events(?!\?)/ },
  { name: 'sheets write', re: /sheets\.googleapis\.com[^'"`]*(?:values[^'"`]*:(?:append|update)|batchUpdate)/ },
  { name: 'drive upload', re: /(?:www\.googleapis\.com\/upload\/drive|drive\.googleapis\.com[^'"`]*\/files\?)/ },
  { name: 'telegram send', re: /api\.telegram\.org[^'"`]*(?:sendMessage|sendPhoto|sendDocument|editMessageText)/ },
]

/** Files allowed to contain such a URL WITHOUT importing the broker. */
const EXEMPT = new Set<string>([
  // The broker itself and its inventory name endpoints in prose/config.
  'src/identity/action-broker.ts',
  'src/identity/external-capability-inventory.ts',
  // The Gmail send transport is a LEAF: it holds the wire call and is reached
  // only through the two dispatch flows, both of which broker it. Exempting it
  // is not a shrug -- the test below asserts that every file which constructs
  // one imports the broker, so the exemption is itself checked. Brokering
  // inside the transport as well would write two audit rows for one send and
  // make the log lie about how many things happened.
  'src/cos/adapters/gmail-api-transport.ts',
  // The scope verifier calls only tokeninfo, and is asserted read-only by its
  // own tests; it is listed here because it mentions scope names, not endpoints.
  'scripts/w10-verify-external-scopes.ts',
])

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '__tests__' || e === 'dist') continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('no in-process module writes to a provider without the broker', () => {
  const files = ROOTS.flatMap(r => walk(r))

  it('finds the files it is supposed to be checking (the test is not vacuously green)', () => {
    // A search that matches nothing passes every "no violations" assertion, so
    // the control names files that MUST be found. If a refactor moves the wire
    // calls, this goes red and says the search stopped working -- rather than
    // the suite going green because it now checks nothing.
    const withMutation = files.filter(f => MUTATING_ENDPOINTS.some(m => m.re.test(readFileSync(f, 'utf8'))))
    expect(withMutation.length, 'the endpoint patterns matched nothing at all').toBeGreaterThan(1)
    expect(withMutation.some(f => f.includes('gmail-api-transport')), 'gmail send site not found').toBe(true)
    expect(withMutation.some(f => f.includes('channel-provider')), 'channel send site not found').toBe(true)
  })

  it('every file that CONSTRUCTS the Gmail send transport imports the broker', () => {
    // This is what makes the transport's exemption above a checked claim rather
    // than a note. A new caller that builds a transport and sends without the
    // broker turns this red at the construction site.
    const violations: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      if (!/new GmailApiTransport\(/.test(src)) continue
      if (!/from '.*identity\/action-broker\.js'/.test(src)
          && !/dispatchApprovedSend|dispatchZstSend/.test(src)) {
        violations.push(`${f}: constructs a Gmail transport outside a brokered dispatch flow`)
      }
    }
    expect(violations).toEqual([])
  })

  it('every file with a mutating provider endpoint imports the action broker', () => {
    const violations: string[] = []
    for (const f of files) {
      const norm = f.replace(/\\/g, '/')
      if (EXEMPT.has(norm)) continue
      const src = readFileSync(f, 'utf8')
      const hits = MUTATING_ENDPOINTS.filter(m => m.re.test(src)).map(m => m.name)
      if (!hits.length) continue
      if (!/from '.*identity\/action-broker\.js'/.test(src)) {
        violations.push(`${norm}: calls [${hits.join(', ')}] and does not import the broker`)
      }
    }
    expect(violations).toEqual([])
  })
})

describe('the transport modules keep the effect inside the broker call', () => {
  // One level deeper than "imports the broker": the mutating fetch must appear
  // AFTER the broker call begins, not before it. Cheap textual ordering, and it
  // catches the specific regression of someone hoisting the send out of the
  // thunk to "simplify" it.
  const cases: Array<[string, RegExp]> = [
    ['src/cos/cos-telegram.ts', /sendMessage/],
    ['src/cos/adapters/gmail-label-api.ts', /modify/],
  ]
  for (const [file, effect] of cases) {
    it(`${file}: the effect appears inside the brokered call`, () => {
      const src = readFileSync(file, 'utf8')
      const brokerAt = src.indexOf('brokerExternalAction(')
      expect(brokerAt, `${file} does not call the broker`).toBeGreaterThan(-1)
      const after = src.slice(brokerAt)
      expect(effect.test(after), `${file}: the mutating call is not inside the broker call`).toBe(true)
    })
  }
})
