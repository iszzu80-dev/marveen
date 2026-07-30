import { describe, it, expect } from 'vitest'
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Phase 3, card 59b383a9. GATE FINDING (marveen, 2026-07-30, card comment
// 8261): a source-level guard that hand-lists "the routing path" modules and
// scans only those repeats the exact mistake it exists to prevent -- it
// gates the modules someone WROTE, not the path the code actually TAKES, and
// breaks silently the moment a new module joins that path. Proved by
// mutation: `writeAgentModel(name, model)` inserted directly in
// agent-process.ts (not on the old hand-picked list) passed every existing
// check, tsc, and the full suite.
//
// Fixed by inverting to DEFAULT-DENY, the same principle the error
// classifier already gets right (src/capacity-routing.ts: an error class not
// explicitly whitelisted is not fallback-eligible): scan EVERY file under
// src/ for a call to any agent-config-write symbol, and allowlist only the
// one legitimate site, with the reason written down. A new module added
// anywhere on (or off) the routing path is covered by this by construction --
// it either doesn't call these symbols (passes) or does and must be
// consciously allowlisted (forces a decision, not an oversight).
//
// The three proofs this file's own test suite is designed to survive
// (verified 2026-07-30, each mutated and reverted clean):
//   1. marveen's exact mutation (a write call inserted in agent-process.ts,
//      or anywhere else not on the allowlist) -> RED.
//   2. the legitimate operator write (routes/agents.ts) -> stays GREEN.
//   3. removing the allowlist entry for routes/agents.ts -> RED (proves the
//      entry is load-bearing, not decorative; the allowlist cannot silently
//      grow because every entry is required to actually matter).

const SRC = join(import.meta.dirname, '..')

// Every symbol that would mutate an agent's CONFIGURED model or model
// profile if called. Definitions: web/agent-config.ts. Track that file if
// a new write function is added there.
const FORBIDDEN_CALLS = ['writeAgentModel', 'writeAgentModelProfile', 'writeMainModel', 'writeModelFor']

// The ONLY files permitted to call any of the above. Default-deny: anything
// else, anywhere in src/, calling one of these symbols is a violation --
// regardless of which module it lives in or when it was added.
const ALLOWLIST: Record<string, string> = {
  'web/routes/agents.ts':
    'the operator-facing REST endpoint for agent create (POST /api/agents) and '
    + 'update (PATCH /api/agents/:name) -- a human explicitly asked for this model '
    + 'via the dashboard, so writing config here IS the intended path. This is the '
    + 'opposite of an automated capacity-routing decision, which must never write it.',
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walkTsFiles(full, out)
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) out.push(full)
  }
  return out
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** True when `code` CALLS `symbol` (not merely defines it: a `function` declaration is not a call). */
function callsSymbol(code: string, symbol: string): boolean {
  const re = new RegExp(`(?<!function )\\b${symbol}\\s*\\(`)
  return re.test(code)
}

function relPath(abs: string): string {
  return relative(SRC, abs).split(sep).join('/')
}

describe('agent-config write default-deny allowlist (Phase 3 gate fix)', () => {
  const allFiles = walkTsFiles(SRC).map(relPath)
  // Sanity: the scan actually found source files, so an empty/broken walk
  // cannot silently report "no violations" by finding nothing.
  it('the scan covers a non-trivial number of source files', () => {
    expect(allFiles.length).toBeGreaterThan(50)
  })

  it('every file calling a forbidden agent-config-write symbol is on the allowlist -- no exceptions by module name', () => {
    const violations: string[] = []
    for (const rel of allFiles) {
      if (rel in ALLOWLIST) continue
      const code = stripComments(readFileSync(join(SRC, rel), 'utf-8'))
      for (const symbol of FORBIDDEN_CALLS) {
        if (callsSymbol(code, symbol)) violations.push(`${rel}: calls ${symbol}(...)`)
      }
    }
    expect(violations, `Unallowlisted agent-config write(s) found:\n${violations.join('\n')}`).toEqual([])
  })

  it('every allowlist entry genuinely calls a forbidden symbol -- the allowlist cannot be decorative', () => {
    for (const [rel, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, `${rel}'s allowlist reason is suspiciously short`).toBeGreaterThan(20)
      const code = stripComments(readFileSync(join(SRC, rel), 'utf-8'))
      const callsAny = FORBIDDEN_CALLS.some((s) => callsSymbol(code, s))
      expect(callsAny, `${rel} is allowlisted but calls no forbidden symbol -- remove the stale entry`).toBe(true)
    }
  })

  it('the write-function DEFINITIONS themselves (web/agent-config.ts) are not flagged as calls', () => {
    // Guards the negative-lookbehind logic in callsSymbol: `export function
    // writeAgentModel(...)` must not be mistaken for a call to itself.
    const code = stripComments(readFileSync(join(SRC, 'web/agent-config.ts'), 'utf-8'))
    expect(callsSymbol(code, 'writeAgentModel')).toBe(false)
    expect(callsSymbol(code, 'writeAgentModelProfile')).toBe(false)
  })
})
