// P2-B: measured fresh-token sizes for a representative packet set.
//
// COUNTING METHOD, stated plainly: these are ESTIMATES, not measurements. Every
// number is estimateFreshTokens() = ceil(rendered_chars / 4) over the rendered
// packet text. No tokenizer is involved, so a real tokenizer will differ --
// typically within roughly +/-15% for English + code. Nothing in the codebase
// presents these as measured (the confidence marker is asserted below), and the
// ~3000 figure they are compared against is a TARGET, not a cap.
//
// The test prints the table so the numbers are reproducible from a test run
// rather than pasted into a report by hand.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildContextPacket,
  renderContextPacket,
  estimateFreshTokens,
  artifactRefFromContent,
  validateContextPacket,
  TARGET_FRESH_TOKENS,
  type ContextPacket,
} from '../context-packet.js'
import { EXAMPLE_PACKET } from '../context-packet-example.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..')

function readRepoFile(rel: string): string {
  const p = join(REPO_ROOT, rel)
  return existsSync(p) ? readFileSync(p, 'utf-8') : `MISSING:${rel}`
}

// Real repo material, so the reference-vs-inline comparison uses real sizes.
const AUDIT = readRepoFile('docs/optimization/marveen-lean-optimization-audit-2026-07-17.md')
const GUARD = readRepoFile('src/context-guard.ts')
const DISPATCH = readRepoFile('src/costops/dispatch.ts')
const P2B_SPEC = readRepoFile('docs/optimization/phase2-p2b-context-packet.md')

// --- the representative set -------------------------------------------------

const SMALL: ContextPacket = buildContextPacket({
  cardId: 'b7f0aa12',
  goal: 'Fix the Hungarian label on the usage page footer: it says "Tokenek" where the column is cost.',
  taskSize: 'small',
  contextBudgetClass: 'minimal',
  references: [artifactRefFromContent('src/web/lang/hu.js', '9dd1c27', 'fixture', { note: 'The key is usage.footer.tokens.' })],
  constraints: ['Copy change only; no logic.'],
  dataSensitivity: 'internal',
  doneWhen: ['The footer reads "Költség" and the en/hu label tests stay green.'],
})

const NORMAL = EXAMPLE_PACKET

const KANBAN_DISPATCH: ContextPacket = buildContextPacket({
  cardId: 'c31d99f4',
  goal: 'Add a per-provider filter to the CostOps costs page, reading the existing cost_line_items rows.',
  taskSize: 'normal',
  contextBudgetClass: 'standard',
  references: [
    artifactRefFromContent('src/costops/schema.ts', '9dd1c27', GUARD, { note: 'cost_line_items shape lives here.', excerpt: 'CREATE TABLE IF NOT EXISTS cost_line_items (' }),
    artifactRefFromContent('src/web/routes/costs.ts', '9dd1c27', DISPATCH, { note: 'The list endpoint to extend.' }),
  ],
  constraints: [
    'Read-only: no new writes, no new collector.',
    'A provider with no rows must render as empty, never as a zero total.',
    'CostOps stays the single measurement system.',
  ],
  dataSensitivity: 'internal',
  dataSensitivityNotes: ['Aggregates only; no account identifiers in the response.'],
  doneWhen: ['The filter narrows the table server-side.', 'A provider with no rows renders empty, proven by a test.'],
})

const LARGE: ContextPacket = buildContextPacket({
  cardId: 'd5510cbe',
  goal: 'Migrate all four dispatch origins onto the P2-B packet metadata writer and prove attribution end to end.',
  taskSize: 'large',
  contextBudgetClass: 'extended',
  references: [
    artifactRefFromContent('docs/optimization/phase2-p2b-context-packet.md', '9dd1c27', P2B_SPEC, { note: 'The canonical spec. Read the Build + Done-when sections.', excerpt: 'Dispatch metadata is the natural carrier for packet metadata.' }),
    artifactRefFromContent('src/costops/dispatch.ts', '9dd1c27', DISPATCH, { note: 'createDispatchSafe is the pattern to mirror.', excerpt: 'export function createDispatchSafe(' }),
    artifactRefFromContent('src/web/routes/kanban.ts', '9dd1c27', GUARD, { note: 'Origin 1 of 4 -- already wired; copy this shape.' }),
    artifactRefFromContent('src/web/message-router.ts', '9dd1c27', GUARD, { note: 'Origin 2 of 4.' }),
    artifactRefFromContent('src/web/schedule-runner.ts', '9dd1c27', GUARD, { note: 'Origin 3 of 4.' }),
    artifactRefFromContent('src/web/agent-worker.ts', '9dd1c27', GUARD, { note: 'Origin 4 of 4.' }),
    artifactRefFromContent('docs/optimization/marveen-lean-optimization-audit-2026-07-17.md', '9dd1c27', AUDIT, { note: 'Background only. Its 85/90/92/97 thresholds are SUPERSEDED -- do not restore them.' }),
  ],
  constraints: [
    'Additive and behaviour-neutral: no origin may change what it dispatches.',
    'Reuse the initCostOpsSchema seam; do not add a parallel init.',
    'No LLM on the packet or taskSize paths.',
    'Every new column nullable, forward-only, never backfilled.',
  ],
  dataSensitivity: 'internal',
  dataSensitivityNotes: ['Paths and hashes only. No prompt text is persisted at any origin.'],
  doneWhen: [
    'All four origins record packet metadata through recordPacketMetadataSafe.',
    'A dispatch from each origin reads back with a confidence-marked estimate.',
    'Full vitest suite green, tsc --noEmit exit 0, npm run build exit 0.',
  ],
  complexityJustification: 'Four independent call sites must each be named with its file, or the task is not executable without rediscovery.',
})

const SET: Array<[string, ContextPacket]> = [
  ['small  (copy fix)', SMALL],
  ['normal (committed example)', NORMAL],
  ['normal (kanban dispatch)', KANBAN_DISPATCH],
  ['large  (4-origin migration)', LARGE],
]

describe('P2-B measured packet sizes (estimates -- see the counting method at the top)', () => {
  it('reports the fresh-token estimate for the representative set', () => {
    const rows: string[] = []
    rows.push('method: ceil(rendered_chars / 4), no tokenizer -- ESTIMATE, not measured')
    rows.push('name                          chars   est.tokens  refs  vs ~3000 target')
    for (const [name, p] of SET) {
      const text = renderContextPacket(p)
      const est = estimateFreshTokens(text)
      expect(est.confidence).toBe('estimated')
      rows.push(
        `${name.padEnd(28)}  ${String(text.length).padStart(5)}   ${String(est.tokens).padStart(9)}  ` +
        `${String(p.references.length).padStart(4)}  ${est.tokens <= TARGET_FRESH_TOKENS ? 'under' : 'OVER (documented)'}`,
      )
    }
    // eslint-disable-next-line no-console
    console.log(rows.join('\n'))

    // The gate: the MAJORITY of the representative set is under the target.
    const under = SET.filter(([, p]) => estimateFreshTokens(renderContextPacket(p)).tokens <= TARGET_FRESH_TOKENS).length
    expect(under).toBeGreaterThan(SET.length / 2)
  })

  it('every non-large packet in the set is individually under the ~3000 target', () => {
    for (const [name, p] of SET) {
      if (p.taskSize === 'large') continue
      expect(estimateFreshTokens(renderContextPacket(p)).tokens, name).toBeLessThan(TARGET_FRESH_TOKENS)
    }
  })

  it('every packet in the set validates clean -- reference-based, no warnings', () => {
    // Honest note: with 7 references the LARGE packet still lands well under the
    // target, so its complexityJustification is present but not yet load-bearing.
    // The target/cap distinction itself is proven in context-packet.test.ts on a
    // packet that genuinely exceeds 3000 tokens.
    for (const [name, p] of SET) {
      const v = validateContextPacket(p)
      expect(v.errors, name).toEqual([])
      expect(v.warnings, name).toEqual([])
    }
    expect(LARGE.complexityJustification).toBeTruthy()
  })

  it('reports the saving vs inlining the same material, which is the whole point', () => {
    const inlinedChars = [AUDIT, GUARD, DISPATCH, P2B_SPEC].reduce((n, s) => n + s.length, 0)
    const inlined = estimateFreshTokens([AUDIT, GUARD, DISPATCH, P2B_SPEC].join('\n'))
    const referenced = estimateFreshTokens(renderContextPacket(LARGE))
    // eslint-disable-next-line no-console
    console.log(
      `inline-vs-reference (same 4 artifacts):\n` +
      `  inlined:    ${inlinedChars} chars -> ~${inlined.tokens} est. tokens\n` +
      `  referenced: ${renderContextPacket(LARGE).length} chars -> ~${referenced.tokens} est. tokens (largest packet in the set)\n` +
      `  ratio:      ${(inlined.tokens / Math.max(referenced.tokens, 1)).toFixed(1)}x fewer fresh tokens by reference`,
    )
    expect(referenced.tokens).toBeLessThan(inlined.tokens)
  })
})
