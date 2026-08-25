import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'

// W14 / §8.3 — the RESTORE DRILL, exercised end to end.
//
// The daily maintenance job already did a restore TEST (decrypt, open,
// integrity_check, count). §8.3 asks for six steps, and the three it was missing
// are the ones that separate "the file decrypts" from "the system comes back":
// a CLEAN target, SMOKE TESTS on real read paths, and a MEASURED RPO/RTO.
//
// This runs the actual script as a subprocess against a synthetic store — the
// same way the egress-gate test runs the real hook — so what is proven is the
// program, not a re-implementation of it inside a test.

const DRILL = join(process.cwd(), 'scripts', 'w14-restore-drill.ts')
const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx')
const PASS = 'w14-drill-passphrase'

interface DrillOutput {
  ok: boolean
  error?: string
  steps: Array<{ step: string; ok: boolean; detail: Record<string, unknown> }>
}

function runDrill(dbPath: string, storeDir: string, env: Record<string, string> = {}): DrillOutput {
  const out = execFileSync(TSX, [DRILL, '--db', dbPath, '--store', storeDir, '--work', join(storeDir, 'work')], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, COS_BACKUP_PASSPHRASE: PASS, COS_BACKUP_DIR: join(storeDir, 'backups'), ...env },
    // The drill exits 1 on failure; execFileSync throws then, and the output is
    // on the error object. Both paths must be readable.
  })
  return JSON.parse(out) as DrillOutput
}

describe('W14 §8.3 — the restore drill', () => {
  let store: string
  let dbPath: string

  beforeEach(() => {
    store = mkdtempSync(join(tmpdir(), 'w14-drill-store-'))
    mkdirSync(join(store, 'backups'), { recursive: true, mode: 0o700 })
    dbPath = join(store, 'claudeclaw.db')
    initDatabase(dbPath)
    const db = getDb()
    createCase(db, { caseId: 'drill-1', title: 'Egy ugy', caseType: 'ADMIN', description: 'x' }, 1_800_000_000)
    createCase(db, { caseId: 'drill-2', title: 'Masik ugy', caseType: 'BILL', description: 'y' }, 1_800_000_000)
    // Policy files, so the drill has both halves to restore.
    writeFileSync(join(store, 'autonomy-config.json'), JSON.stringify({ email: { level: 2 } }))
    writeFileSync(join(store, 'egress-allowlist.json'), JSON.stringify({ domains: ['ops.example.com'] }))
    db.close()
  })

  afterEach(() => { rmSync(store, { recursive: true, force: true }) })

  it('runs all six §8.3 steps and passes on a healthy store', () => {
    const r = runDrill(dbPath, store)
    expect(r.ok).toBe(true)
    expect(r.steps.map(s => s.step)).toEqual([
      '1-staging-backup', '2-clean-target', '3-restore', '4-consistency', '5-smoke', '6-rpo-rto',
    ])
    expect(r.steps.every(s => s.ok)).toBe(true)
  })

  it('the consistency step compares the RESTORED row counts against the source', () => {
    const r = runDrill(dbPath, store)
    const consistency = r.steps.find(s => s.step === '4-consistency')!
    expect(consistency.detail.integrity).toBe('ok')
    expect(consistency.detail.sourceCounts).toEqual(consistency.detail.restoredCounts)
    expect((consistency.detail.sourceCounts as Record<string, number>).personal_cases).toBe(2)
  })

  it('the SMOKE step opens real read paths, not a row count', () => {
    // A restored file that opens is not a restored system: this asserts that the
    // functions the running COS calls return sensible answers against the
    // restored store.
    const r = runDrill(dbPath, store)
    const smoke = r.steps.find(s => s.step === '5-smoke')!
    expect(smoke.ok).toBe(true)
    expect(smoke.detail.activeCases).toBe(2)
    expect(smoke.detail.error).toBeUndefined()
  })

  it('the policy half is restored too — the rules come back, not only the cases', () => {
    const r = runDrill(dbPath, store)
    const restore = r.steps.find(s => s.step === '3-restore')!
    expect(restore.detail.policyFiles).toBe(2)
    const consistency = r.steps.find(s => s.step === '4-consistency')!
    expect(consistency.detail.policyRestored).toBe(2)
    expect(consistency.detail.policyMissing).toEqual([])
  })

  it('RPO is the age of the newest REAL backup, and says so when there is none', () => {
    // Not the drill's own backup age, which would always be zero and would say
    // nothing about what a real restore would lose.
    const r = runDrill(dbPath, store)
    const rpo = r.steps.find(s => s.step === '6-rpo-rto')!
    expect(rpo.detail.rpoSeconds).toBeNull()
    expect(String(rpo.detail.note)).toMatch(/unbounded until the daily job has run/)
    expect(typeof rpo.detail.rtoSeconds).toBe('number')
  })

  it('with a real backup present, the RPO is its measured age', () => {
    const backups = join(store, 'backups')
    const nowSec = Math.floor(Date.now() / 1000)
    writeFileSync(join(backups, `backup-${nowSec - 7200}.db.enc`), Buffer.from('not a real backup, only a timestamp'))
    const r = runDrill(dbPath, store)
    const rpo = r.steps.find(s => s.step === '6-rpo-rto')!
    expect(rpo.detail.rpoSeconds as number).toBeGreaterThanOrEqual(7200)
    expect(rpo.detail.rpoHours as number).toBeGreaterThanOrEqual(2)
  })

  it('leaves nothing behind: the work directory is cleaned up', () => {
    runDrill(dbPath, store)
    const leftovers = readdirSync(join(store, 'work')).filter(n => n.startsWith('.drill-'))
    expect(leftovers).toEqual([])
  })

  it('FAILS, loudly, when the backup is not what it claims to be', () => {
    // The drill must be able to go red. A corrupt store is the closest thing to
    // the disaster it exists to rehearse.
    // TRUNCATION, not a flipped byte. A single flipped byte often lands in free
    // space and `integrity_check` still says ok — measured, and the reason this
    // test was rewritten. Truncation is also the shape the real failure took:
    // byte-copying a live WAL store produces a short file, which is exactly what
    // the backup code's own header describes.
    const bytes = readFileSync(dbPath)
    writeFileSync(dbPath, bytes.subarray(0, Math.floor(bytes.length * 0.6)))
    let failed = false
    try {
      const r = runDrill(dbPath, store)
      failed = !r.ok
    } catch (e) {
      // exit 1 → execFileSync throws; the JSON is still on stdout
      const out = String((e as { stdout?: Buffer }).stdout ?? '')
      failed = out.includes('"ok": false') || out.includes('"ok":false')
    }
    expect(failed).toBe(true)
  })

  it('refuses to run without a passphrase rather than reporting a green drill', () => {
    let refused = false
    try {
      execFileSync(TSX, [DRILL, '--db', dbPath, '--store', store], {
        cwd: process.cwd(), encoding: 'utf8',
        env: { ...process.env, COS_BACKUP_PASSPHRASE: '' },
      })
    } catch (e) {
      const out = String((e as { stdout?: Buffer }).stdout ?? '')
      refused = out.includes('COS_BACKUP_PASSPHRASE is not set')
    }
    expect(refused).toBe(true)
  })
})
