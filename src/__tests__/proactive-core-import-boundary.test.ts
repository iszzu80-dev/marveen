// §15.3: "zero new external execution surface" is a code-level standing
// invariant, not a documentation checkbox.
//
// This file owns clauses (2) and (4): the v1.4 Proactive Core must not depend,
// DIRECTLY OR TRANSITIVELY, on a browser, fetch, egress or external-adapter
// module, and no browser/research/disclosure module may enter its dependency
// closure.
//
// TRANSITIVE is the whole point, and it is the reason this cannot be a review
// rule. A direct `import { chromium }` would be caught by anybody reading the
// diff. What nobody catches by reading is `proactive/x.ts` importing a helper
// from `cos/y.ts` that six months later grows a `fetch` — at which moment the
// Proactive Core has an egress path and every file in the chain still looks
// innocent on its own.
//
// The pattern is `cos-gate-permit.test.ts` (review #5, Ö-5), which the §25 audit
// confirmed is suitable for reuse: read the real files, resolve the real import
// graph, name the offender in a form somebody can open.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'


import { importClosure, sources, importSpecifiers, stripComments, REPO } from './helpers/import-closure.js'

const PROACTIVE_DIR = 'src/cos/proactive'





/** The full transitive closure of local modules the Proactive Core depends on,
 *  plus every external package name anything in that closure imports.
 *
 *  The traversal itself now lives in helpers/import-closure.ts: the
 *  SERVICE_QUOTE boundary needed the same reasoning (2026-08-15), and a second
 *  copy is where this one's fixes would have stopped arriving. */
function proactiveClosure(): { files: Set<string>; packages: Map<string, string> } {
  return importClosure(sources(PROACTIVE_DIR))
}

/** Modules and packages that can reach the outside world. A dependency on any
 *  of these from the Proactive Core is a v1.4 release-boundary violation. */
const FORBIDDEN_PACKAGES = [
  'playwright', 'playwright-core', 'puppeteer', 'puppeteer-core', 'selenium-webdriver',
  'node-fetch', 'axios', 'got', 'undici', 'superagent', 'request',
  'node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'http', 'https', 'net', 'tls',
  'nodemailer', 'googleapis', 'ws',
  // THE MODEL CLIENT. The reason stated here is deliberately not the one that
  // first suggests itself.
  //
  // The tempting argument is "the v1.4 qualification policy is deterministic, so
  // it does not need a model". That is true today and it is the WRONG reason,
  // because it makes the ban contingent on a property. The day someone decides
  // the policy needs a model call — a decision they are entitled to make — the
  // ban stops looking like a boundary and starts looking like an obstacle, and
  // obstacles get removed by whoever is in a hurry.
  //
  // The reason is: THE PROACTIVE CORE HAS NO RIGHT TO ADDRESS A MODEL. That is a
  // boundary, not a property. It holds whether or not the policy is
  // deterministic, and it is the same shape as every other line on this list —
  // the module detects and qualifies from stored evidence, and it consumes
  // Reader OUTPUT rather than holding the client that produces it. Changing it
  // means granting a right, which is a decision someone has to make out loud.
  // (Marveen's correction, 2026-08-13.)
  '@anthropic-ai/sdk', 'openai', '@google/generative-ai',
]

/** Local modules whose job IS to reach outside. Matched on the path, so a new
 *  adapter under `src/cos/adapters/` is covered the day it is written. */
const FORBIDDEN_LOCAL_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /^src\/cos\/adapters\//, why: 'külső adapter (egress)' },
  { re: /browser|playwright|puppeteer/i, why: 'browser automation' },
  { re: /^src\/cos\/(executor|executor-core|dispatch-gate|zst-send)\.ts$/, why: 'végrehajtó / küldő út' },
  { re: /^src\/cos\/(gmail-|telegram|bus-)/, why: 'külső csatorna' },
]

describe('§15.3 release boundary — the Proactive Core cannot reach outside', () => {
  it('the scan actually found the Proactive Core (a check over nothing passes everything)', () => {
    // Ö-5's lesson, stated as an assertion. Every test below is worth exactly
    // what its scan covers, and a scan that silently matches zero files reports
    // a clean boundary just as confidently as a correct one does.
    const files = sources(PROACTIVE_DIR)
    expect(files.length).toBeGreaterThanOrEqual(4)
    expect(files).toContain(`${PROACTIVE_DIR}/types.ts`)
  })

  it('the closure walk really follows edges, and really collects packages', () => {
    // The two arms of the walker, each proven to do something. Without this, a
    // walker that resolved nothing would report an empty closure and every
    // boundary test below would pass for the worst possible reason.
    //
    // Note what this deliberately does NOT assert: that the closure reaches
    // outside `src/cos/proactive`. It did, on the first run — through a type-only
    // import of `EvidenceFact` from `reader.ts`, which dragged the Anthropic SDK
    // in with it — and removing that edge is what made the boundary real. The
    // closure being exactly the directory is the goal, not a broken scan.
    const { files, packages } = proactiveClosure()
    expect(files.has(`${PROACTIVE_DIR}/types.ts`)).toBe(true)
    // signal-store imports ./types.js; if the resolver were dead, the walk that
    // starts from signal-store would never add it.
    expect(importSpecifiers(`${PROACTIVE_DIR}/signal-store.ts`)).toContain('./types.js')
    expect([...packages.keys()]).toContain('node:crypto')
  })

  it('STANDING CHECK (§15.3/2, /4): no forbidden package in the transitive closure', () => {
    const { packages } = proactiveClosure()
    const offenders = [...packages.entries()]
      .filter(([pkg]) => FORBIDDEN_PACKAGES.includes(pkg))
      .map(([pkg, file]) => `${file} → ${pkg}`)
      .sort()
    expect(offenders).toEqual([])
  })

  it('STANDING CHECK (§15.3/2, /4): no egress module in the transitive closure', () => {
    const { files } = proactiveClosure()
    const offenders: string[] = []
    for (const f of files) {
      for (const { re, why } of FORBIDDEN_LOCAL_PATTERNS) {
        if (re.test(f)) offenders.push(`${f} (${why})`)
      }
    }
    expect([...new Set(offenders)].sort()).toEqual([])
  })

  it('STANDING CHECK (§15.3/3): the Proactive Core mints no permit and issues no authorization', () => {
    // §15.3(3) is about the planner receiving a permit for an executor that can
    // emit a new external side effect. The strongest form this codebase can
    // assert is the absolute one: nothing here touches the ticket machinery at
    // all, so there is no permit to route anywhere.
    const offenders: string[] = []
    for (const f of sources(PROACTIVE_DIR)) {
      const src = readFileSync(join(REPO, f), 'utf8')
      for (const [i, line] of src.split('\n').entries()) {
        // Comments explain the boundary; only real calls cross it.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
        if (/\b(mintGatePermit|issueAuthorization|executeAction|planAction)\s*\(/.test(line)) {
          offenders.push(`${f}:${i + 1}: ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('STANDING CHECK: the Proactive Core does not write to the Case store either', () => {
    // §4.1 — "a signal coming into existence must not create a Case" — and §8's
    // "look for an existing Case first". Neither is enforceable by a store that
    // has no access to Cases, which is precisely why this directory has none.
    // The qualification policy receives candidate Cases as an ARGUMENT; it does
    // not go and find them.
    const offenders: string[] = []
    for (const f of sources(PROACTIVE_DIR)) {
      for (const spec of importSpecifiers(f)) {
        if (/case-store|zst-case-store|intake|progression-pipeline|owner-question/.test(spec)) {
          offenders.push(`${f} → ${spec}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
