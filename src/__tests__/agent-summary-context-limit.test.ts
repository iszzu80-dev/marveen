import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Card 585c056c: /api/agents must expose the SAME canonical context-window
// resolution scripts/fleet-context-guard.sh now consumes (instead of
// maintaining its own drifted copy), so the wiring itself is what this
// guards -- contextLimitForModel/isRecognizedContextModel are independently
// unit-tested in context-guard.test.ts; this only proves getAgentSummary
// actually calls them (source-level, same idiom as
// main-agent-detail-guards.test.ts's sourceBetween checks) rather than
// silently falling back to some other/no computation.

const __dirname = dirname(fileURLToPath(import.meta.url))
const agentsSource = readFileSync(join(__dirname, '..', 'web', 'routes', 'agents.ts'), 'utf8')

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('AgentSummary.contextLimit / contextLimitKnown wiring', () => {
  it('imports the canonical registry, not a local re-derivation', () => {
    expect(agentsSource).toMatch(/import\s*\{\s*contextLimitForModel,\s*isRecognizedContextModel\s*\}\s*from\s*'\.\.\/\.\.\/context-guard\.js'/)
  })

  it('getAgentSummary computes contextLimit/contextLimitKnown from the RESOLVED model, not the raw config field', () => {
    const code = stripComments(agentsSource)
    const fnStart = code.indexOf('function getAgentSummary(name: string): AgentSummary {')
    expect(fnStart, 'getAgentSummary not found').toBeGreaterThan(-1)
    const fnBody = code.slice(fnStart, code.indexOf('\n}', fnStart))
    expect(fnBody).toMatch(/contextLimit:\s*contextLimitForModel\(modelResolution\.model\)/)
    expect(fnBody).toMatch(/contextLimitKnown:\s*isRecognizedContextModel\(modelResolution\.model\)/)
  })
})
