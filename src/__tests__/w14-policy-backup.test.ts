import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPolicyBackup, verifyPolicyBackup, restorePolicyBackup, prunePolicyBackups,
  POLICY_FILES, SECRET_FILES, isRuntimeState, BACKUP_RETENTION_DAYS,
} from '../cos/backup.js'

// W14 / §8.2 — the POLICY half of the backup.
//
// The audit measured what the daily backup covers: the database, and nothing
// else. Everything the system decides with that is not in SQLite lives in
// `store/*.json` — the autonomy levels, the egress allowlist, which secret is
// bound to which MCP server, the source-commit policy. A restore from a current
// backup would produce a store with every case and none of the rules, including
// a security control that would come back empty.
//
// The design point these tests are really about is the third status:
// UNCLASSIFIED. A declared list rots as the system grows, and a rot nobody sees
// is how the egress allowlist would have fallen out of a future backup. So a
// store file matching neither list nor the runtime-state pattern is REPORTED,
// on every run, until somebody decides which it is.

const PASS = 'w14-test-passphrase'
const NOW = 1_800_000_000

describe('W14 §8.2 — the policy backup', () => {
  let store: string
  let dest: string

  beforeEach(() => {
    store = mkdtempSync(join(tmpdir(), 'w14-store-'))
    dest = mkdtempSync(join(tmpdir(), 'w14-backups-'))
    // A realistic store: two policy files, one secret, one runtime state.
    writeFileSync(join(store, 'autonomy-config.json'), JSON.stringify({ email: { level: 2 } }))
    writeFileSync(join(store, 'egress-allowlist.json'), JSON.stringify({ domains: ['ops.example.com'] }))
    writeFileSync(join(store, 'vault.json'), JSON.stringify({ entries: [{ id: 'X', encrypted: 'SECRET' }] }))
    writeFileSync(join(store, 'fleet-stall-state.json'), JSON.stringify({ at: 1 }))
  })
  afterEach(() => {
    rmSync(store, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
  })

  it('backs up the policy files and round-trips them', () => {
    const made = createPolicyBackup({ storeDir: store, destDir: dest, passphrase: PASS, now: NOW })
    const v = verifyPolicyBackup({ encPath: made.path, passphrase: PASS })
    expect(v.ok).toBe(true)
    expect(v.restoredFiles.sort()).toEqual(['autonomy-config.json', 'egress-allowlist.json'])

    const target = mkdtempSync(join(tmpdir(), 'w14-restore-'))
    try {
      const { written } = restorePolicyBackup({ encPath: made.path, passphrase: PASS, targetDir: target })
      expect(written.sort()).toEqual(['autonomy-config.json', 'egress-allowlist.json'])
      // The egress allowlist comes back with its contents, not as an empty file:
      // a security control that restores empty is worse than one that is missing.
      expect(JSON.parse(readFileSync(join(target, 'egress-allowlist.json'), 'utf-8')))
        .toEqual({ domains: ['ops.example.com'] })
    } finally { rmSync(target, { recursive: true, force: true }) }
  })

  it('does NOT carry the secrets, and says so rather than staying silent', () => {
    const made = createPolicyBackup({ storeDir: store, destDir: dest, passphrase: PASS, now: NOW })
    // §8.2: "Secret backup külön security policy szerint." The exclusion is a
    // decision on the record — an entry in the manifest — not an omission that
    // looks like nobody thought about it.
    const vaultEntry = made.manifest.find(e => e.name === 'vault.json')
    expect(vaultEntry?.status).toBe('EXCLUDED_SECRET')
    const v = verifyPolicyBackup({ encPath: made.path, passphrase: PASS })
    expect(v.restoredFiles).not.toContain('vault.json')
    // and the ciphertext does not contain the secret by any other route
    expect(readFileSync(made.path).toString('latin1')).not.toContain('SECRET')
  })

  it('runtime state is classified, not backed up', () => {
    const made = createPolicyBackup({ storeDir: store, destDir: dest, passphrase: PASS, now: NOW })
    expect(made.manifest.find(e => e.name === 'fleet-stall-state.json')?.status).toBe('RUNTIME_STATE')
    expect(made.unclassified).toEqual([])
  })

  it('A NEW STORE FILE IS REPORTED — the declared list cannot rot silently', () => {
    // This is the test the whole design exists for. Somebody adds a policy file
    // next month; without this it would simply not be in the backup, and the
    // first anyone would hear of it is a restore that behaves differently.
    writeFileSync(join(store, 'brand-new-policy.json'), JSON.stringify({ rule: 'x' }))
    const made = createPolicyBackup({ storeDir: store, destDir: dest, passphrase: PASS, now: NOW })
    expect(made.unclassified).toEqual(['brand-new-policy.json'])
    expect(made.manifest.find(e => e.name === 'brand-new-policy.json')?.status).toBe('UNCLASSIFIED')
    // It is reported, not silently included: what it IS remains an operator
    // decision, and guessing would put an unknown file into a backup that must
    // stay auditable.
    const v = verifyPolicyBackup({ encPath: made.path, passphrase: PASS })
    expect(v.restoredFiles).not.toContain('brand-new-policy.json')
    expect(v.unclassified).toEqual(['brand-new-policy.json'])
  })

  it('a declared file that is MISSING is recorded as missing, not as absent-and-fine', () => {
    const made = createPolicyBackup({ storeDir: store, destDir: dest, passphrase: PASS, now: NOW })
    // Every declared policy file this store does not have shows up as MISSING,
    // so a restore can tell "was not there when the backup ran" from "was lost".
    const missing = made.manifest.filter(e => e.status === 'MISSING').map(e => e.name)
    expect(missing).toContain('cos-source-commit-policy.json')
    expect(missing.length).toBe(POLICY_FILES.length - 2)
  })

  it('the restore test FAILS on a corrupted bundle', () => {
    const made = createPolicyBackup({ storeDir: store, destDir: dest, passphrase: PASS, now: NOW })
    const bytes = readFileSync(made.path)
    bytes[bytes.length - 5] ^= 0xff                       // flip a byte in the ciphertext
    writeFileSync(made.path, bytes)
    const v = verifyPolicyBackup({ encPath: made.path, passphrase: PASS })
    expect(v.ok).toBe(false)
    expect(v.problem).toBeTruthy()
  })

  it('the wrong passphrase does not silently produce an empty bundle', () => {
    const made = createPolicyBackup({ storeDir: store, destDir: dest, passphrase: PASS, now: NOW })
    const v = verifyPolicyBackup({ encPath: made.path, passphrase: 'not-the-passphrase' })
    expect(v.ok).toBe(false)
  })

  it('prunes on the filename timestamp, on the same window as the database backups', () => {
    createPolicyBackup({ storeDir: store, destDir: dest, passphrase: PASS, now: NOW })
    const old = join(dest, `policy-${NOW - (BACKUP_RETENTION_DAYS + 1) * 86400}.json.enc`)
    writeFileSync(old, Buffer.from('stale'))
    const pruned = prunePolicyBackups({ destDir: dest, now: NOW })
    expect(pruned.deleted).toHaveLength(1)
    expect(existsSync(old)).toBe(false)
    expect(pruned.kept).toEqual([`policy-${NOW}.json.enc`])
  })
})

describe('W14 §8.2 — the classification rules themselves', () => {
  it('the two declared lists do not overlap', () => {
    // A file in both would be backed up AND declared excluded, and which one won
    // would depend on iteration order.
    const overlap = POLICY_FILES.filter(f => (SECRET_FILES as readonly string[]).includes(f))
    expect(overlap).toEqual([])
  })

  it('no declared policy file is also matched by the runtime-state pattern', () => {
    expect(POLICY_FILES.filter(isRuntimeState)).toEqual([])
  })

  it('the egress allowlist and the vault bindings are IN the policy set', () => {
    // Named explicitly because these two are the ones whose silent absence would
    // change behaviour rather than merely lose a preference: one is a security
    // control, the other decides which secret reaches which service.
    expect(POLICY_FILES).toContain('egress-allowlist.json')
    expect(POLICY_FILES).toContain('vault-bindings.json')
  })

  it('the vault itself is NOT in the policy set', () => {
    expect(POLICY_FILES).not.toContain('vault.json')
    expect(SECRET_FILES).toContain('vault.json')
  })
})
