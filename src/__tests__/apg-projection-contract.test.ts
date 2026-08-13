// APG 0.4 review: F-3, F-8, F-9, F-10 — four ways a projection lied quietly.
//
// The common shape: the UI is a projection of the sidecar (§1.4), and every one
// of these turned a fact the sidecar knew into a different fact on screen —
// without an error anywhere. A dead endpoint that answers `{events: []}`, a
// renamed enum that maps "never ran" onto "running", an unreadable table that
// looks like an empty one, and a blocking gate that opens when the thing it
// gates on is unreachable.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  deriveDisplayState,
  APG_CHECKPOINT_RESULTS,
  APG_KERNEL_VERIFICATION_STATUSES,
} from '../apg/ui-projection.js'
import { EXCLUDED_CLAIM_AUTHORITIES } from '../apg/completion-claim.js'
import {
  APG_FEED_STALL_AFTER_SECONDS, REQUIRED_OBSERVATION_DAYS, REQUIRED_ELIGIBLE_WORK_ITEMS,
} from '../apg/feed-health.js'
import { deriveExecutionId } from '../apg/execution-binding.js'

/** The WP6 §15.3-d golden vectors, pinned identically in the kernel's own
 *  tests/test_wp6_kanban_dispatch.py. See the contract block at the end. */
const VECTOR_WITH_CONTEXT = 'ex-b7848fb7906a827ea7322381e6c37f89'
const VECTOR_ALL_UNKNOWN = 'ex-a939ce43ca4c30f717c6eec6c4c398c0'

/**
 * Where the kernel repo is on THIS machine, or null.
 *
 * The cross-repo assertions below used to be guarded by a bare
 * `if (!existsSync(kernel)) return` — which reports a PASS for a comparison
 * that never happened. "Two repos, one contract" then held only on a machine
 * with both repos checked out, and the test said nothing about which machine it
 * was on. A test that reports success for work it did not do is the same class
 * of defect as the projection findings this file covers.
 *
 * Now: found → assert; not found → vitest reports an explicit SKIP (visible in
 * the run summary, not a green tick); and `APG_REQUIRE_KERNEL_CONTRACT=1` turns
 * the skip into a failure, so CI can demand the real comparison.
 */
function resolveKernelSrc(): string | null {
  const candidates = [
    process.env.APG_KERNEL_SRC_ROOT,
    join(homedir(), 'marveen-local', 'apg-kernel', 'src'),
    join(process.cwd(), '..', 'marveen-apg-kernel', 'src'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  return candidates.find((dir) => existsSync(join(dir, 'checkpoints.py'))) ?? null
}

const KERNEL_SRC = resolveKernelSrc()
const KERNEL_REQUIRED = process.env.APG_REQUIRE_KERNEL_CONTRACT === '1'
const NO_KERNEL_REASON =
  'kernel checkout not found — set APG_KERNEL_SRC_ROOT to the kernel repo src/ '
  + 'directory (or APG_REQUIRE_KERNEL_CONTRACT=1 to make this a failure)'

/**
 * Read one `NAME = (...)` / `NAME = [...]` list of quoted UPPERCASE tokens out
 * of a kernel module. The kernel writes one as a list and one as a tuple, so
 * the close is whichever bracket the literal actually opened with — matching on
 * the wrong one silently swallows the rest of the file and turns this contract
 * into a much weaker assertion.
 */
function kernelTokenList(file: string, name: string): string[] {
  const src = readFileSync(join(KERNEL_SRC as string, file), 'utf8')
  const start = src.indexOf(`${name} = `)
  expect(start, `${name} not found in kernel ${file}`).toBeGreaterThanOrEqual(0)
  const open = src.indexOf('=', start) + 1
  const bracket = src.slice(open).trimStart().startsWith('[') ? ']' : ')'
  const body = src.slice(open, src.indexOf(bracket, open) + 1)
  return [...body.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort()
}

// The REAL DeriveDisplayStateInput. The first version of this fixture invented
// field names; vitest passed it happily (it does not typecheck) and tsc caught
// it — a green test that was not exercising the branch it claimed to.
const base = {
  latestTransitionState: null,
  latestCheckpointResult: 'PASS',
  latestCheckpoint: 'build',
  hasAssistedRecommendation: false,
  recommendationEvidenceCompleteness: null,
}

describe('the two-repo contract is actually checked, or loudly not checked', () => {
  it('HEADLINE: this run knows whether it compared against a real kernel checkout', () => {
    // The one assertion that must never skip. It does not check the vocabulary;
    // it checks that the SKIP is a decision with a reason, so a green run can
    // never be mistaken for a verified contract.
    if (KERNEL_SRC === null) {
      expect(
        KERNEL_REQUIRED,
        `cross-repo contract NOT verified in this run: ${NO_KERNEL_REASON}`,
      ).toBe(false)
      return
    }
    expect(existsSync(join(KERNEL_SRC, 'checkpoints.py'))).toBe(true)
    expect(existsSync(join(KERNEL_SRC, 'claim_verification.py'))).toBe(true)
  })
})

describe('F-8: the kernel result vocabulary is one contract, not two', () => {
  it.skipIf(KERNEL_SRC === null && !KERNEL_REQUIRED)(
    `HEADLINE: the UI list matches the kernel RESULT_VALUES [${KERNEL_SRC ?? NO_KERNEL_REASON}]`,
    () => {
      // Two repos, one contract. The kernel renamed NOT_APPLICABLE to EXCLUDED
      // and added ERROR; the UI still matched the old name, so both new values
      // fell through to "executing".
      expect(KERNEL_SRC, NO_KERNEL_REASON).not.toBeNull()
      expect([...APG_CHECKPOINT_RESULTS].sort())
        .toEqual(kernelTokenList('checkpoints.py', 'RESULT_VALUES'))
    },
  )

  it('EXCLUDED is not "executing" — a gate that never ran is not work in progress', () => {
    expect(deriveDisplayState({ ...base, latestCheckpointResult: 'EXCLUDED' })).toBe('clarification')
  })

  it('ERROR is surfaced as blocked, not as progress', () => {
    // An executor that returned nothing valid needs a human; showing it as a
    // running process is how it sits there for a week.
    expect(deriveDisplayState({ ...base, latestCheckpointResult: 'ERROR' })).toBe('blocked')
  })

  it('the OLD name still maps correctly — history is not rewritten by a rename', () => {
    // The kernel migration puts no CHECK on `result`, so pre-rename rows are
    // still in the store and still mean what they meant.
    expect(deriveDisplayState({ ...base, latestCheckpointResult: 'NOT_APPLICABLE' })).toBe('clarification')
  })

  it('a genuinely running gate is still "executing" — the counter-case', () => {
    expect(deriveDisplayState({ ...base, latestCheckpointResult: 'PASS' })).toBe('executing')
  })
})

describe('WP2 §10.3-b: the claim vocabulary is one contract, not two', () => {
  it.skipIf(KERNEL_SRC === null && !KERNEL_REQUIRED)(
    `HEADLINE: the UI list matches the kernel VERIFICATION_STATUSES [${KERNEL_SRC ?? NO_KERNEL_REASON}]`,
    () => {
      // The projection no longer decides a claim's verification status; it
      // relabels the kernel's. That only stays honest while both sides agree on
      // the vocabulary — a status the kernel adds and this list does not know
      // would render as UNKNOWN, which is a downgrade nobody asked for.
      expect(KERNEL_SRC, NO_KERNEL_REASON).not.toBeNull()
      expect([...APG_KERNEL_VERIFICATION_STATUSES].sort())
        .toEqual(kernelTokenList('claim_verification.py', 'VERIFICATION_STATUSES'))
    },
  )
})

describe('F-3: the Activity endpoint uses the driver, not a global nobody sets', () => {
  it('HEADLINE: no globalThis.BetterSqlite3 lookup remains', () => {
    // It waited on a global that NOTHING in the repo ever assigns — not the
    // app, not the tests — so §13's feed returned an error string on every
    // production call while looking like "no activity".
    const src = readFileSync(join(process.cwd(), 'src/apg/ui-projection.ts'), 'utf8')
    expect(src).not.toMatch(/globalThis as Record<string, unknown>\)\.BetterSqlite3/)
    // ...and the endpoint opens the sidecar the same way the rest of the file does.
    const fn = src.slice(src.indexOf('): ApgEventsResult | { error: string }'))
    expect(fn.slice(0, 900)).toMatch(/openApgKernelReadonly\(\)/)
  })
})

describe('F-9: an unreadable table is not an empty table', () => {
  it('HEADLINE: read failures are captured and surfaced, not swallowed', () => {
    const src = readFileSync(join(process.cwd(), 'src/apg/ui-projection.ts'), 'utf8')
    // The catch must record something before returning the empty array.
    const fn = src.slice(src.indexOf('function rowsOrEmpty'))
    expect(fn.slice(0, 700)).toMatch(/projectionReadErrors\.push/)
    // ...and the summary must put it in the response.
    expect(src).toMatch(/partial projection: \$\{readErrors\.length\}/)
  })
})

describe('F-10: the enforced archive gate holds when the sidecar is down', () => {
  it('HEADLINE: enforced mode no longer fails open on a fetch error', () => {
    const src = readFileSync(join(process.cwd(), 'web/apg.js'), 'utf8')
    // Anchor on the archive gate's OWN fetch — the same URL is fetched
    // elsewhere for display, and those catches are correctly fail-soft. Two
    // earlier versions of this assertion picked the wrong catch block, which is
    // exactly the kind of thing a source-reading test gets wrong quietly.
    const gate = src.slice(src.lastIndexOf('/api/apg/work-items?kanban_card_id='))
    // The old code was a bare `catch { return /* fail-open */ }`.
    expect(gate).not.toMatch(/catch \{ return \/\* fail-open \*\//)
    // Enforced must block; the advisory modes may still let it through.
    // Scope to the CATCH block — the success path has its own preventDefault,
    // and comparing offsets across both is what made the first version of this
    // assertion compare the wrong pair.
    const catchStart = gate.indexOf('} catch {')
    const catchBlock = gate.slice(catchStart, catchStart + 900)
    expect(catchBlock).toMatch(/if \(state\.mode !== 'enforced'\) return/)
    expect(catchBlock.indexOf("state.mode !== 'enforced'")).toBeLessThan(catchBlock.indexOf('event.preventDefault()'))
  })
})

// ---------------------------------------------------------------------------
// WP6 (§15.2, §15.3-e, §35). Three more places where the two repositories hold
// the same value and only one of them can be edited at a time.
// ---------------------------------------------------------------------------

describe('WP6: the excluded-claim-authority set is one contract, not two', () => {
  it.skipIf(KERNEL_SRC === null && !KERNEL_REQUIRED)(
    `HEADLINE: Marveen's EXCLUDED_CLAIM_AUTHORITIES matches the kernel's CLAIM_LINK_POLICY [${KERNEL_SRC ?? NO_KERNEL_REASON}]`,
    () => {
      // §15.3-e's whole force is that a self-asserted `done` cannot become
      // acceptance evidence. That rule is expressed twice -- as
      // `CLAIM_LINK_POLICY` in the kernel and as `EXCLUDED_CLAIM_AUTHORITIES`
      // here -- and a word present in one list and not the other would make a
      // claim count as evidence on one side of the boundary and not the other.
      const src = readFileSync(join(KERNEL_SRC as string, 'completion_verification.py'), 'utf8')
      const start = src.indexOf('CLAIM_LINK_POLICY = {')
      expect(start, 'CLAIM_LINK_POLICY not found in the kernel').toBeGreaterThanOrEqual(0)
      const policy = src.slice(start, src.indexOf('\n}', start))

      // The kernel writes (qualifying, excluded, wired). The FIRST frozenset is
      // qualifying and must be EMPTY: no authority makes a completion claim
      // into acceptance evidence, not even an operator's.
      expect(policy).toMatch(/frozenset\(\),\s*\n\s*frozenset\(\{/)

      const excluded = policy.slice(policy.indexOf('frozenset({'))
      for (const authority of EXCLUDED_CLAIM_AUTHORITIES) {
        expect(excluded, `${authority} is excluded here but not in the kernel`).toContain(authority)
      }
      // ...and nothing the kernel excludes is missing from this side.
      for (const token of [...excluded.matchAll(/\b([A-Z][A-Z_]{4,})\b/g)].map(m => m[1])) {
        if (token === 'PRESENT' || token === 'MISSING' || token === 'UNKNOWN') continue
        expect(EXCLUDED_CLAIM_AUTHORITIES as readonly string[]).toContain(token)
      }
    },
  )
})

describe('WP6: §35\'s three thresholds are one contract, not two', () => {
  it.skipIf(KERNEL_SRC === null && !KERNEL_REQUIRED)(
    `HEADLINE: the feed-health thresholds match the kernel's live_ingest constants [${KERNEL_SRC ?? NO_KERNEL_REASON}]`,
    () => {
      // feed-health.ts derives FRESH/STALLED and the promotion counts on the
      // read side, so it needs the same numbers the kernel writes them against.
      // A kernel that lengthened its stall window while this file did not would
      // have the dashboard report STALLED about a feed the kernel calls fresh.
      const src = readFileSync(join(KERNEL_SRC as string, 'live_ingest.py'), 'utf8')
      const constant = (name: string): string => {
        const match = src.match(new RegExp(`^${name} = (.+)$`, 'm'))
        expect(match, `${name} not found in the kernel's live_ingest.py`).not.toBeNull()
        return (match as RegExpMatchArray)[1].trim()
      }
      expect(constant('DEFAULT_CADENCE_SECONDS')).toBe('60 * 60')
      expect(constant('DEFAULT_STALL_AFTER_SECONDS')).toBe('3 * DEFAULT_CADENCE_SECONDS')
      expect(APG_FEED_STALL_AFTER_SECONDS).toBe(3 * 60 * 60)
      expect(constant('REQUIRED_OBSERVATION_DAYS')).toBe(String(REQUIRED_OBSERVATION_DAYS))
      expect(constant('REQUIRED_ELIGIBLE_WORK_ITEMS')).toBe(String(REQUIRED_ELIGIBLE_WORK_ITEMS))
    },
  )
})

describe('WP6: the execution_id derivation is one contract, not two', () => {
  it.skipIf(KERNEL_SRC === null && !KERNEL_REQUIRED)(
    `HEADLINE: both repositories pin the same golden execution ids [${KERNEL_SRC ?? NO_KERNEL_REASON}]`,
    () => {
      // §15.3-d's join works because both sides compute the id from the same
      // seven facts. Neither implementation can import the other, so the
      // contract is two golden vectors pinned in both test suites -- asserted
      // here to be literally the same strings, so a "fix" on one side that
      // quietly re-baselined its own vector is caught.
      const kernelTest = readFileSync(
        join(KERNEL_SRC as string, '..', 'tests', 'test_wp6_kanban_dispatch.py'), 'utf8')
      expect(kernelTest).toContain(VECTOR_WITH_CONTEXT)
      expect(kernelTest).toContain(VECTOR_ALL_UNKNOWN)
      // The Marveen half computes them rather than quoting them.
      expect(deriveExecutionId({
        workItemId: 'card-9f2a', agentId: 'dex', role: 'producer',
        createdAt: 1784281157, sessionId: 'sess-7', contextPacketHash: 'b'.repeat(64),
      })).toBe(VECTOR_WITH_CONTEXT)
      expect(deriveExecutionId({
        workItemId: 'card-9f2a', agentId: 'dex', role: 'producer', createdAt: 1784281157,
      })).toBe(VECTOR_ALL_UNKNOWN)
    },
  )
})
