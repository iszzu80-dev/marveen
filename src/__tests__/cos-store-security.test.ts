import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { redactSensitive, REDACTED, assertStorePermissions, anyTooOpen, missingPaths } from '../cos/store-security.js'

// §C DoD (data security): sensitive content never reaches a log, and the store
// files are not group/other readable.

describe('redactSensitive (no sensitive content in logs / skill-trajectories)', () => {
  it('redacts sensitive-named fields anywhere in the tree, keeping the shape', () => {
    const input = {
      caseId: 'c1', subject: 'Invoice',
      email: { from: 'a@b.c', body: 'SECRET BODY', snippet: 'secret snip' },
      attachments: [{ filename: 'inv.pdf', content: 'PDFBYTES', attachment_text: 'total 100' }],
    }
    const r = redactSensitive(input) as any
    expect(r.caseId).toBe('c1')            // non-sensitive kept
    expect(r.email.from).toBe('a@b.c')     // kept
    expect(r.email.body).toBe(REDACTED)    // redacted
    expect(r.email.snippet).toBe(REDACTED)
    expect(r.attachments).toBe(REDACTED)   // the whole attachments field is sensitive-named
  })

  it('does not mutate the input and handles cycles', () => {
    const input: any = { body: 'x', nested: {} }
    input.nested.self = input
    const r = redactSensitive(input) as any
    expect(input.body).toBe('x')           // original untouched
    expect(r.body).toBe(REDACTED)
    expect(r.nested.self).toBe('[CYCLE]')
  })
})

describe('assertStorePermissions', () => {
  it.skipIf(process.platform === 'win32')('flags a group/other-readable file and tightens it under enforce', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-perm-'))
    const f = join(dir, 'claudeclaw.db')
    writeFileSync(f, 'x')
    chmodSync(f, 0o644) // group+other readable → too open
    let checks = assertStorePermissions([{ path: f, kind: 'file' }])
    expect(anyTooOpen(checks)).toBe(true)
    expect(checks[0].fixed).toBe(false)
    // enforce tightens to 0600
    checks = assertStorePermissions([{ path: f, kind: 'file' }], { enforce: true })
    expect(checks[0].fixed).toBe(true)
    expect(anyTooOpen(checks)).toBe(false)
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('a properly-locked-down file is not flagged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-perm-'))
    const f = join(dir, 'ok.db')
    writeFileSync(f, 'x'); chmodSync(f, 0o600)
    const checks = assertStorePermissions([{ path: f, kind: 'file' }])
    expect(anyTooOpen(checks)).toBe(false)
  })

  // CHANGED 2026-08-13 (E17). This asserted `[]` — i.e. it asserted the defect: a
  // path the check could not see produced no entry, so a typo'd or moved store
  // path silently dropped out of the check and anyTooOpen() answered false for a
  // file nobody had looked at. The check has to be able to say "I could not
  // check this", or its silence is worthless.
  it('E17: a missing path is REPORTED, not silently dropped (still no throw)', () => {
    const checks = assertStorePermissions([{ path: '/no/such/cos-file', kind: 'file' }])
    expect(checks).toHaveLength(1)
    expect(checks[0].missing).toBe(true)
    expect(missingPaths(checks)).toEqual(['/no/such/cos-file'])
    // a path that does not exist cannot be over-open — that stays a separate fact
    expect(anyTooOpen(checks)).toBe(false)
  })

  it('E17 CONTROL: a path that IS there is not reported as missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-perm-'))
    const f = join(dir, 'there.db')
    writeFileSync(f, 'x'); chmodSync(f, 0o600)
    expect(missingPaths(assertStorePermissions([{ path: f, kind: 'file' }]))).toEqual([])
  })
})
