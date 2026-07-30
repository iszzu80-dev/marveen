import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Phase 3, card 59b383a9. THE single most important guard in this phase:
// "configuredPrimary is NEVER overwritten by runtime fallback." The old
// model-fallback-runner.ts broke this rule (writeModelFor/writeMainModel
// rewrote agent-config.json / .claude/settings.json) and has been deleted.
// This is a source-level guard, same idiom as main-restart-platform.test.ts:
// the failure mode is a config-write call sneaking back into the routing
// path, which a mocked fs harness would only prove for the mock, not the
// real file. Two independent checks: the violating file must be gone, and
// the two live modules that DO run on the routing path must never call any
// agent-config-writing function.

const SRC = join(import.meta.dirname, '..')

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

// Every symbol that would mutate an agent's CONFIGURED model if called.
const FORBIDDEN_WRITE_CALLS = [
  'writeAgentModel(',
  'writeAgentModelProfile(',
  'writeMainModel(',
  'writeModelFor(',
]

const ROUTING_MODULES = [
  'web/capacity-routing-runner.ts',
  'web/capacity-routing-store.ts',
] as const

describe('Phase 3: configuredPrimary is never written by the routing path', () => {
  it('the old config-writing runner (model-fallback-runner.ts) no longer exists', () => {
    expect(existsSync(join(SRC, 'web/model-fallback-runner.ts'))).toBe(false)
  })

  it('web.ts no longer imports the deleted runner', () => {
    const code = read('web.ts')
    expect(code).not.toMatch(/model-fallback-runner/)
    expect(code).toMatch(/capacity-routing-runner/)
  })

  for (const rel of ROUTING_MODULES) {
    it(`${rel} contains no call to any agent-config write function`, () => {
      const code = stripComments(read(rel))
      for (const forbidden of FORBIDDEN_WRITE_CALLS) {
        expect(code, `${rel} must never call ${forbidden}`).not.toContain(forbidden)
      }
      // Nor a raw settings.json write.
      expect(code).not.toMatch(/\.claude[/\\]settings\.json/)
    })
  }

  it('resolveRuntimeModel only ever READS the overlay/config; it takes no write function as a dependency', () => {
    const code = stripComments(read('web/capacity-routing-store.ts'))
    const fn = code.match(/export function resolveRuntimeModel\([\s\S]*?\n\}/)
    expect(fn, 'resolveRuntimeModel not found').not.toBeNull()
    expect(fn![0]).not.toMatch(/writeFileSync|atomicWriteFileSync|writeRuntimeOverlay\(/)
  })
})
