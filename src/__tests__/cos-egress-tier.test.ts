// §10 egress tier: ONE answer for both namespaces, and both sweeps ask it.
//
// THE BUG THIS CLOSES (review 2026-08-12, T-1). `reader-cycle.contextSensitivity`
// read every context item with the PERSONAL coercer. A corporate case carries
// `ZST_INTERNAL` / `ZST_FINANCIAL` / …, which that coercer does not recognise, so
// it fail-closed to HIGHLY_SENSITIVE — and the ENTIRE corporate domain was routed
// to the contracted provider by DATA ABSENCE, not by content. Measured across all
// eight corporate classes: seven of eight came back HIGHLY_SENSITIVE, including
// the everyday `ZST_INTERNAL` tier.
//
// The enrichment sweep had already hit this and solved it with a PRIVATE copy.
// The copy was the real defect: the Reader is the module enrichment copied its
// routing rule FROM, and it never got the fix back. So the standing checks at the
// bottom are the point of this file — not that the mapping is right today, but
// that it cannot fork again.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  egressTierFor, ZST_TO_EGRESS_TIER, isProviderAllowedForSensitivity,
} from '../cos/provider-data-policy.js'
import { contextSensitivity } from '../cos/reader-cycle.js'
import { ZST_SENSITIVITIES, allowedProfilesForZst } from '../cos/zst-sensitivity.js'
import { allowedProfilesFor } from '../cos/sensitivity.js'

const REPO = process.cwd()

describe('§10 egress tier, both namespaces', () => {
  it('HEADLINE: an everyday CORPORATE case is not maximally sensitive', () => {
    // The regression. Before the fix this returned HIGHLY_SENSITIVE and the case
    // could only go to a contracted provider — a policy verdict about content
    // nobody had looked at.
    expect(contextSensitivity('zst', [
      { sensitivity: 'ZST_INTERNAL', content: 'A havi riport csatolva.' },
    ])).toBe('PERSONAL')
    expect(isProviderAllowedForSensitivity('deepseek', 'PERSONAL')).toBe(true)
  })

  it('and a genuinely restricted corporate case still is', () => {
    // The counter-case. A gate that stops refusing everything must not start
    // permitting everything: the classes above the everyday tier stay contracted.
    expect(contextSensitivity('zst', [
      { sensitivity: 'ZST_FINANCIAL', content: 'a havi zaras' },
    ])).toBe('HIGHLY_SENSITIVE')
    expect(isProviderAllowedForSensitivity('deepseek', 'HIGHLY_SENSITIVE')).toBe(false)
  })

  it('CORPORATE CONTENT escalates too, not just the declared class', () => {
    // Stricter than the private copy this replaces: that one coerced the declared
    // class and never ran the corporate classifier, so a bank account number in an
    // "internal" thread rode out on the declaration.
    expect(egressTierFor('zst', 'ZST_INTERNAL', 'utalás IBAN HU42117730161111101800000000'))
      .toBe('HIGHLY_SENSITIVE')
    // ...and without the trigger, the same case stays on the cheap route.
    expect(egressTierFor('zst', 'ZST_INTERNAL', 'a havi riport')).toBe('PERSONAL')
  })

  it('the personal namespace is unchanged', () => {
    expect(egressTierFor('personal', 'PERSONAL', 'semmi')).toBe('PERSONAL')
    expect(egressTierFor('personal', 'PERSONAL', 'a kartya: 4111 1111 1111 1111'))
      .toBe('HIGHLY_SENSITIVE')
    expect(contextSensitivity('personal', [])).toBe('PUBLIC')
  })

  it('fail-closed on BOTH unknowns: the class and the domain', () => {
    // An unrecognised corporate class lands on the strict side...
    expect(egressTierFor('zst', 'ZST_SOMETHING_NEW', 'x')).toBe('HIGHLY_SENSITIVE')
    expect(egressTierFor('zst', undefined, 'x')).toBe('HIGHLY_SENSITIVE')
    // ...and an unrecognised DOMAIN is read with the personal vocabulary, which
    // is what every non-corporate caller means. A corporate class read that way
    // is unknown there too, so it is still refused rather than downgraded.
    expect(egressTierFor('something-else', 'ZST_INTERNAL', 'x')).toBe('HIGHLY_SENSITIVE')
  })

  it('every corporate class has a mapping — no undefined row', () => {
    for (const z of ZST_SENSITIVITIES) {
      expect(ZST_TO_EGRESS_TIER[z], `missing mapping for ${z}`).toBeTruthy()
    }
  })

  it('STANDING CHECK: the map is DERIVED from the two profile allowlists', () => {
    // The mapping is not an opinion about corporate data. Each corporate class is
    // mapped to the personal tier whose model-profile allowlist is identical —
    // both tables already exist and both are owner-sanctioned policy. If either
    // table changes, this fails instead of the map quietly meaning something else.
    for (const z of ZST_SENSITIVITIES) {
      const corporate = [...allowedProfilesForZst(z)].sort()
      const personal = [...allowedProfilesFor(ZST_TO_EGRESS_TIER[z])].sort()
      expect(personal, `${z} -> ${ZST_TO_EGRESS_TIER[z]}`).toEqual(corporate)
    }
  })

  it('STANDING CHECK: exactly one module decides the egress tier', () => {
    // The half a shared function cannot enforce. Both sweeps must ASK; neither may
    // grow its own answer again. A private mapping is recognisable by a corporate
    // class name appearing in EXECUTABLE code — comments are stripped first,
    // because both files legitimately explain the history in prose and a check
    // that fires on its own explanation teaches people to delete the explanation.
    const offenders: string[] = []
    for (const rel of ['src/cos/reader-cycle.ts', 'src/cos/goal-enrichment.ts']) {
      const code = readFileSync(join(REPO, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      if (!code.includes('egressTierFor')) offenders.push(`${rel}: does not call egressTierFor`)
      if (/\bZST_[A-Z_]+\b/.test(code)) offenders.push(`${rel}: maps corporate classes itself`)
    }
    expect(offenders).toEqual([])
  })
})
