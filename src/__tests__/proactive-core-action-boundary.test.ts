// §15.3, clauses (1), (3) and (5): the ACTION half of the v1.4 release boundary.
//
// Its sibling `proactive-core-import-boundary.test.ts` guards the dependency
// graph — what the Proactive Core can reach. This file guards the allowlist
// itself — what it is permitted to do.
//
// The failure this defends against is not a browser appearing in an import. It
// is one line added to `INTERNAL_PREPARATION_CLASSES`, in a diff about something
// else, six months from now, by someone who needs the planner to do one more
// thing and finds a list that looks like a list. §15.2 names fourteen classes
// that must never appear there, and §15.3(5) names the way they will try to: an
// alias or a rename.
//
// So the allowlist is asserted VERBATIM. Not "contains no forbidden class" —
// that only catches the honest mistake. Verbatim, so that any change at all,
// including a rename, has to be made deliberately and shows up with a red test
// attached to it.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  FORBIDDEN_EXTERNAL_ACTION_CLASSES,
  INTERNAL_PREPARATION_CLASSES,
} from '../cos/proactive/types.js'
import { promoteSignal } from '../cos/proactive/initiative-store.js'
import { ensureProactiveSchema } from '../cos/proactive/schema.js'
import { recordSignal } from '../cos/proactive/signal-store.js'
import { qualifySignal } from '../cos/proactive/qualification.js'
import { initDatabase, getDb } from '../db.js'

const REPO = process.cwd()
const PROACTIVE_DIR = 'src/cos/proactive'
const T0 = 1_700_000_000

/** §15.1, as the spec writes it. Copied here on purpose: a test that imports the
 *  list and compares it to itself asserts nothing. This is the independent
 *  copy, and the diff between the two is the alarm. */
const SPEC_15_1_CLASSES = [
  'READ_CONTEXT',
  'RESOLVE_MISSING_INFORMATION',
  'CHECK_DEADLINE',
  'VERIFY_STATE',
  'CHECK_STALL',
  'CHECK_ANOMALY',
  'ORGANIZE_EVIDENCE',
  'ASSESS_RISK',
  'CHECK_DUPLICATE',
  'PREPARE_DRAFT',
  'PREPARE_DECISION_PACKAGE',
  'PREPARE_INTERNAL_SUMMARY',
  'SCHEDULE_REVIEW',
]

/** §15.2, likewise independently copied. */
const SPEC_15_2_FORBIDDEN = [
  'RESEARCH_WEB',
  'BROWSER_NAVIGATE',
  'FORM_FILL',
  'FORM_SUBMIT',
  'SEND_TO_NEW_EXTERNAL_RECIPIENT',
  'DISCLOSE_PERSONAL_DATA',
  'CREATE_ACCOUNT',
  'ACCEPT_OFFER',
  'BOOK',
  'ORDER',
  'PAY',
  'CANCEL_CONTRACT',
  'SIGN',
  'LEGAL_COMMITMENT',
]

function proactiveSources(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(join(REPO, dir))) return
    for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) walk(rel)
      else if (e.name.endsWith('.ts')) out.push(rel)
    }
  }
  walk(PROACTIVE_DIR)
  return out.sort()
}

/** A signal that qualifies, so the promotion path can be exercised for real
 *  rather than through a stub of itself. */
function qualifiedSignal() {
  const db = getDb()
  const r = recordSignal(db, {
    domain: 'personal',
    signalType: 'DEADLINE',
    sourceRefs: ['doc-1'],
    subjectRef: 'szerzodes-2026',
    summary: 'A szerzodes felmondasi hatarideje kozeledik.',
    evidenceClaims: [{ statement: 'A felmondasi hatarido 2026-09-01.', sourceRef: 'doc-1' }],
    estimatedMateriality: 'HIGH',
    estimatedUrgency: 'HIGH',
    estimatedActionability: 'HIGH',
    candidateDeadline: T0 + 30 * 86400,
    confidence: 0.9,
  }, T0)
  if (r.outcome !== 'RECORDED') throw new Error(`fixture signal refused: ${JSON.stringify(r)}`)
  return { signal: r.signal, qualification: qualifySignal(r.signal, T0) }
}

describe('§15.3 release boundary — what the v1.4 planner is allowed to do', () => {
  it('STANDING CHECK (§15.3/1): the allowlist is exactly §15.1, in order', () => {
    // Verbatim, including order. Order carries no runtime meaning; asserting it
    // is what makes an insertion anywhere in the list — not only at the end —
    // impossible to make quietly.
    expect([...INTERNAL_PREPARATION_CLASSES]).toEqual(SPEC_15_1_CLASSES)
  })

  it('STANDING CHECK (§15.3/1): no §15.2 class has entered the allowlist', () => {
    const leaked = SPEC_15_2_FORBIDDEN.filter(c => (INTERNAL_PREPARATION_CLASSES as readonly string[]).includes(c))
    expect(leaked).toEqual([])
  })

  it('STANDING CHECK: the forbidden list is exactly §15.2, so nothing drops off it', () => {
    // The quieter half. Widening the allowlist is visible; deleting an entry
    // from the DENY list is the same breach and looks like tidying.
    expect([...FORBIDDEN_EXTERNAL_ACTION_CLASSES]).toEqual(SPEC_15_2_FORBIDDEN)
  })

  it('STANDING CHECK (§15.3/5): no forbidden class name appears anywhere in the module', () => {
    // The rename/alias route. A forbidden class arriving under a new name still
    // has to be written down somewhere; a forbidden class arriving under its OWN
    // name in a string literal, a map key or a switch arm is the cheaper attempt,
    // and this is what catches it. Comments are exempt — this file and §15.2's
    // own documentation have to be able to say the words.
    const offenders: string[] = []
    for (const f of proactiveSources()) {
      const lines = readFileSync(join(REPO, f), 'utf8').split('\n')
      // The DENY-list declaration itself is the one place these words belong.
      // Exempted by LINE RANGE, not by file: exempting the whole of `types.ts`
      // would leave the allowlist — which lives in the same file — unguarded by
      // this check, and that is precisely where a forbidden class would be added.
      const declStart = lines.findIndex(l => /export const FORBIDDEN_EXTERNAL_ACTION_CLASSES/.test(l))
      const declEnd = declStart < 0 ? -1 : declStart + lines.slice(declStart).findIndex(l => /\]\s*as const/.test(l))
      for (const [i, line] of lines.entries()) {
        if (declStart >= 0 && i >= declStart && i <= declEnd) continue
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
        for (const c of SPEC_15_2_FORBIDDEN) {
          // Word-boundary match: PREPARE_DRAFT must not trip on DRAFT, and
          // CHECK_DUPLICATE must not trip on anything.
          if (new RegExp(`\\b${c}\\b`).test(line)) offenders.push(`${f}:${i + 1}: ${c}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the exemption above is a range, and it is the right range', () => {
    // A self-check on the exemption. If the declaration were ever reformatted so
    // the range matcher missed it, the test above would start exempting nothing
    // (loud, fine) or — the dangerous direction — a `findIndex` returning -1
    // would make `declEnd` swallow a large block. Pinning the size keeps that
    // honest.
    const lines = readFileSync(join(REPO, `${PROACTIVE_DIR}/types.ts`), 'utf8').split('\n')
    const start = lines.findIndex(l => /export const FORBIDDEN_EXTERNAL_ACTION_CLASSES/.test(l))
    expect(start).toBeGreaterThan(0)
    const span = lines.slice(start).findIndex(l => /\]\s*as const/.test(l))
    expect(span).toBeGreaterThan(0)
    expect(span).toBeLessThan(10)
  })
})

describe('§15.3 release boundary — the runtime refusal, not only the list', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    ensureProactiveSchema(getDb())
  })

  it('HEADLINE: promotion refuses a forbidden preparation class', () => {
    // The list is checked at the door too. The standing check above catches the
    // list being widened in a diff; this catches a class that never went through
    // the list at all — built at runtime, read from config, or supplied by a
    // caller who did not look.
    const { signal, qualification } = qualifiedSignal()
    const r = promoteSignal(getDb(), signal, qualification, {
      desiredOutcome: { outcomeType: 'DECISION', targetState: 'A felmondas eldontve', completionEvidence: ['dontes rogzitve'] },
      currentGap: 'nincs dontes',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      allowedPreparationClasses: ['READ_CONTEXT', 'BROWSER_NAVIGATE' as any],
    }, T0)
    expect(r.outcome).toBe('REFUSED')
    if (r.outcome === 'REFUSED') expect(r.reason).toMatch(/BROWSER_NAVIGATE/)
  })

  it('and accepts the allowed ones, so the refusal above is not just a broken path', () => {
    const { signal, qualification } = qualifiedSignal()
    const r = promoteSignal(getDb(), signal, qualification, {
      desiredOutcome: { outcomeType: 'DECISION', targetState: 'A felmondas eldontve', completionEvidence: ['dontes rogzitve'] },
      currentGap: 'nincs dontes',
      allowedPreparationClasses: ['READ_CONTEXT', 'CHECK_DEADLINE', 'PREPARE_DECISION_PACKAGE'],
    }, T0)
    expect(r.outcome).toBe('PROMOTED')
  })
})
