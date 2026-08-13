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

const REPO = process.cwd()
const PROACTIVE_DIR = 'src/cos/proactive'

/** Every production `.ts` under a root, recursively, tests excluded. */
function sources(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(join(REPO, dir))) return
    for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'node_modules') continue
        walk(rel)
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(rel)
    }
  }
  walk(root)
  return out.sort()
}

/** Comment lines, dropped before the import scan.
 *
 *  Found by this check's own first run: `types.ts` explains in prose why it does
 *  NOT import from `reader.ts`, quoting the import statement it removed — and
 *  the scanner read the quote as an import and reported the very dependency the
 *  comment exists to say is gone. A boundary check that reads documentation as
 *  code punishes writing the documentation, and the fix a tired person reaches
 *  for is to delete the explanation. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !/^\s*(\/\/|\*)/.test(l))
    .join('\n')
}

/** The module specifiers a file imports, static and dynamic alike.
 *
 *  Dynamic `import()` is included deliberately: it is the obvious way to acquire
 *  a forbidden dependency while keeping the static import list clean, and a
 *  boundary check that only reads the top of the file is a boundary check with a
 *  published bypass. */
function importSpecifiers(file: string): string[] {
  const src = stripComments(readFileSync(join(REPO, file), 'utf8'))
  const out: string[] = []
  const patterns = [
    /\bimport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,   // import x from 'y'
    /\bimport\s*['"]([^'"]+)['"]/g,                  // import 'y'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,        // await import('y')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,       // require('y')
    /\bexport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,    // re-export
  ]
  for (const re of patterns) {
    for (const m of src.matchAll(re)) out.push(m[1])
  }
  return out
}

/** Resolve a relative specifier to a repo-relative `.ts` path, or null when it
 *  is a package (which the package rule below judges by name instead). */
function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const abs = resolve(join(REPO, dirname(fromFile)), spec)
  for (const cand of [abs.replace(/\.js$/, '.ts'), `${abs}.ts`, join(abs, 'index.ts')]) {
    if (existsSync(cand)) return relative(REPO, cand).replace(/\\/g, '/')
  }
  return null
}

/** The full transitive closure of local modules the Proactive Core depends on,
 *  plus every external package name anything in that closure imports. */
function proactiveClosure(): { files: Set<string>; packages: Map<string, string> } {
  const files = new Set<string>()
  const packages = new Map<string, string>()   // package -> the file that pulled it in
  const queue = sources(PROACTIVE_DIR)
  for (const f of queue) files.add(f)
  while (queue.length) {
    const file = queue.shift()!
    for (const spec of importSpecifiers(file)) {
      const local = resolveLocal(file, spec)
      if (local) {
        if (!files.has(local)) { files.add(local); queue.push(local) }
      } else if (!packages.has(spec)) {
        packages.set(spec, file)
      }
    }
  }
  return { files, packages }
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
