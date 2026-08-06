import { describe, it, expect } from 'vitest'
import {
  validateSkillPermissions, parseSkillFrontmatter, validateSkillMd,
  SENSITIVE_CAPABILITIES,
} from '../cos/skill-permission-validator.js'

// #5c: the stricter Skill Factory gate — a generated/loaded skill's declared
// permissions are validated; sensitive caps need explicit approval, unknown caps
// are rejected fail-closed.

describe('skill permission validator (#5c)', () => {
  it('a skill declaring nothing is OK', () => {
    expect(validateSkillPermissions({ name: 's' })).toEqual({ ok: true, violations: [] })
  })

  it('benign capabilities pass', () => {
    const r = validateSkillPermissions({ permissions: ['read-email', 'web-search', 'memory-write'] })
    expect(r.ok).toBe(true)
  })

  it('a sensitive capability without approval is rejected', () => {
    const r = validateSkillPermissions({ permissions: ['send-email'] })
    expect(r.ok).toBe(false)
    expect(r.violations[0].kind).toBe('UNAPPROVED_SENSITIVE')
  })

  it('a sensitive capability WITH explicit approval passes', () => {
    const r = validateSkillPermissions({ permissions: ['send-email'], sensitiveApproved: true })
    expect(r.ok).toBe(true)
  })

  it('an unknown capability is rejected fail-closed (even with approval)', () => {
    const r = validateSkillPermissions({ permissions: ['launch-missiles'], sensitiveApproved: true })
    expect(r.ok).toBe(false)
    expect(r.violations[0].kind).toBe('UNKNOWN_CAPABILITY')
  })

  it('send-email/payment/credential-access are on the sensitive list', () => {
    for (const c of ['send-email', 'payment', 'credential-access', 'browser-checkout']) {
      expect(SENSITIVE_CAPABILITIES.has(c)).toBe(true)
    }
  })

  it('parses inline-list permissions frontmatter', () => {
    const md = `---\nname: quote-sender\npermissions: [read-email, send-email]\nsensitive_approved: true\n---\n# body`
    const meta = parseSkillFrontmatter(md)
    expect(meta.name).toBe('quote-sender')
    expect(meta.permissions).toEqual(['read-email', 'send-email'])
    expect(meta.sensitiveApproved).toBe(true)
    expect(validateSkillMd(md).ok).toBe(true)
  })

  it('parses YAML block-list permissions and rejects an unapproved sensitive one', () => {
    const md = `---\nname: risky\npermissions:\n  - read-calendar\n  - payment\n---\n# body`
    const meta = parseSkillFrontmatter(md)
    expect(meta.permissions).toEqual(['read-calendar', 'payment'])
    const r = validateSkillMd(md)
    expect(r.ok).toBe(false)
    expect(r.violations.some(v => v.capability === 'payment' && v.kind === 'UNAPPROVED_SENSITIVE')).toBe(true)
  })

  it('no frontmatter → empty meta → OK', () => {
    expect(validateSkillMd('# just a heading, no frontmatter')).toEqual({ ok: true, violations: [] })
  })
})
