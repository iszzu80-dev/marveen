// W10 — narrow enforcement on the fleet data-sensitivity gate.
//
// Istvan approved enforcement for RESTRICTED credential/auth-token traffic only,
// with internal and everything else staying observe-only. The tests that matter
// are therefore the ASYMMETRY tests: a gate that blocks everything would pass a
// naive "does it block?" test and would be the wrong thing shipped.

import { describe, it, expect } from 'vitest'
import {
  evaluateDispatch as checkContent, normalizeConfig, DEFAULT_RESTRICTED, DEFAULT_INTERNAL,
  type GateConfig,
} from '../data-sensitivity-gate.js'

const TRUSTED = new Set(['claude'])

function cfg(over: Partial<GateConfig> = {}): GateConfig {
  return normalizeConfig({
    mode: 'observe-only',
    enabled: true,
    auditLogRetentionDays: 90,
    restricted: DEFAULT_RESTRICTED,
    internal: DEFAULT_INTERNAL,
    ...over,
  })
}

const BEARER = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'
const INTERNAL_TEXT = 'check RENDER_API_KEY in the env of suite-postgres-08wb'

describe('narrow enforcement blocks credentials and nothing else', () => {
  it('the shipped default enforces RESTRICTED', () => {
    expect(normalizeConfig({}).enforceCategories).toEqual(['restricted'])
  })

  it('a bearer token to an untrusted model is BLOCKED, not merely observed', () => {
    const r = checkContent(BEARER, 'deepseek-v4-flash', cfg(), TRUSTED)
    expect(r.category).toBe('restricted')
    expect(r.verdict).toBe('block')
  })

  it('INTERNAL content to the same untrusted model stays would_block', () => {
    // The asymmetry is the whole point of "narrow". Production database names
    // and secret KEY NAMES appear in ordinary fleet traffic; enforcing on them
    // would break legitimate work the same night rather than prevent a leak.
    const r = checkContent(INTERNAL_TEXT, 'deepseek-v4-flash', cfg(), TRUSTED)
    expect(r.category).toBe('internal')
    expect(r.verdict).toBe('would_block')
  })

  it('a credential to a TRUSTED model is still allowed — this gate is about egress, not content', () => {
    expect(checkContent(BEARER, 'claude-opus-5', cfg(), TRUSTED).verdict).toBe('allow')
  })

  it('mode:off is not resurrected by the narrow list', () => {
    // A narrow enforcement list must never be able to turn a gate the operator
    // switched OFF back on. Off means off.
    const r = checkContent(BEARER, 'deepseek-v4-flash', cfg({ mode: 'off' }), TRUSTED)
    expect(r.verdict).toBe('allow')
  })

  it('an empty list restores the previous behaviour exactly', () => {
    const r = checkContent(BEARER, 'deepseek-v4-flash', cfg({ enforceCategories: [] }), TRUSTED)
    expect(r.verdict).toBe('would_block')
  })

  it('full enforce mode is unaffected by the narrow list', () => {
    const r = checkContent(INTERNAL_TEXT, 'deepseek-v4-flash',
      cfg({ mode: 'enforce', enforceCategories: [] }), TRUSTED)
    expect(r.verdict).toBe('block')
  })

  it('an unrecognised category in a stored config is dropped, not treated as enforcement', () => {
    const c = normalizeConfig({ enforceCategories: ['restricted', 'nonsense', 42] })
    expect(c.enforceCategories).toEqual(['restricted'])
  })
})

describe('what narrow enforcement actually catches', () => {
  // Each of these is a real credential shape from DEFAULT_RESTRICTED. If a
  // future edit narrows the pattern set, this goes red instead of the gate
  // quietly passing the thing it exists to stop.
  const cases: Array<[string, string]> = [
    ['jwt', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQabc'],
    ['db url', 'postgresql://user:pass@host:5432/proddb'],
    ['render key', 'rnd_abcdefghijklmnopqrstuvwxyz'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['bearer', BEARER],
  ]
  for (const [name, text] of cases) {
    it(`blocks a ${name} heading for an untrusted model`, () => {
      expect(checkContent(text, 'deepseek-v4-flash', cfg(), TRUSTED).verdict).toBe('block')
    })
  }
})
