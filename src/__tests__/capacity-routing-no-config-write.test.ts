import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Phase 3, card 59b383a9. THE single most important guard in this phase:
// "configuredPrimary is NEVER overwritten by runtime fallback." The old
// model-fallback-runner.ts broke this rule (writeModelFor/writeMainModel
// rewrote agent-config.json / .claude/settings.json) and has been deleted.
//
// GATE FINDING (marveen, 2026-07-30, card 59b383a9 comment 8261): this file
// USED to also hand-list the two modules it considered "the routing path"
// (capacity-routing-runner.ts, capacity-routing-store.ts) and scan only
// those for a forbidden call. Marveen proved that insufficient by mutation:
// inserting `writeAgentModel(name, model)` directly in agent-process.ts's
// startAgentProcess right after the resolveRuntimeModel call -- a file NOT
// on the hand-picked list -- passed tsc, passed this file, and passed the
// full suite. That check gated the modules I WROTE, not the path the code
// actually TAKES. Fixed by inverting to default-deny: see
// agent-config-write-allowlist.test.ts, which scans every file under src/
// (not a hand-picked subset) for a call to any agent-config-write symbol and
// allowlists only the one legitimate site, with a reason.
//
// What remains here: the two checks that were never in question (the
// violating file is gone; web.ts points at the replacement) plus a narrower,
// faster, complementary check that resolveRuntimeModel's own function body
// specifically calls no write function -- useful as a fast first signal, but
// NOT a substitute for the tree-wide scan.

const SRC = join(import.meta.dirname, '..')

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('Phase 3: configuredPrimary is never written by the routing path', () => {
  it('the old config-writing runner (model-fallback-runner.ts) no longer exists', () => {
    expect(existsSync(join(SRC, 'web/model-fallback-runner.ts'))).toBe(false)
  })

  it('web.ts no longer imports the deleted runner', () => {
    const code = read('web.ts')
    expect(code).not.toMatch(/model-fallback-runner/)
    expect(code).toMatch(/capacity-routing-runner/)
  })

  it('resolveRuntimeModel only ever READS the overlay/config; it takes no write function as a dependency', () => {
    const code = stripComments(read('web/capacity-routing-store.ts'))
    const fn = code.match(/export function resolveRuntimeModel\([\s\S]*?\n\}/)
    expect(fn, 'resolveRuntimeModel not found').not.toBeNull()
    expect(fn![0]).not.toMatch(/writeFileSync|atomicWriteFileSync|writeRuntimeOverlay\(/)
  })
})
