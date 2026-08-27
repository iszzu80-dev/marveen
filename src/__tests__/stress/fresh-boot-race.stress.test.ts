// The probabilistic four-way race over the REAL bootstrap. A REPRODUCER, not a
// gate.
//
// WHY IT IS NOT IN THE RELEASE GATE (owner, 2026-08-27,
// FRESH_BOOT_NEGATIVE_CONTROL). It disables the lock and requires the boot to
// break, retrying up to six rounds. The defect is real and this is how it was
// originally measured: 47 boots OK and 1 dead with `duplicate column name:
// trace_id` on develop @1adf2a23, and 13 failures in 60 against the pinned
// runtime. But a test that needs several rounds to see a 1-in-48 event is
// measuring the machine as much as the code. On a quiet box the race gets
// weaker, the loop runs out, and the gate goes red for a reason that has nothing
// to do with the change under review. Its GREEN says as little: 47 of 48
// unlocked boots pass too.
//
// So the gate keeps the deterministic pair (db-bootstrap-lock-rendezvous), and
// this stays as the thing that checks the replica is faithful -- it runs the
// actual bootstrap, not a model of the shape it fails in.
//
// RUN IT WITH: npm run test:stress. Excluded from `vitest run` by
// vitest.config.ts, which is what "not a gating test" means mechanically rather
// than by convention.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx')
const WORKER = join(process.cwd(), 'src', '__tests__', 'helpers', 'fresh-boot-worker.ts')
const PEERS = 4

interface WorkerLine { tag: string; ok: boolean; error?: string }

function runWorker(dbPath: string, tag: string, env: NodeJS.ProcessEnv = {}): Promise<WorkerLine> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [WORKER, '--db', dbPath, '--tag', tag, '--peers', String(PEERS)], {
      cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''; let err = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    child.on('error', reject)
    child.on('close', (code) => {
      const parsed = out.split('\n')
        .map((l) => { try { return JSON.parse(l.trim()) as WorkerLine } catch { return null } })
        .filter((v): v is WorkerLine => v !== null && typeof v.ok === 'boolean')
        .pop()
      if (!parsed) return reject(new Error(`worker ${tag} produced no verdict (exit ${code}): ${err.slice(-800)}`))
      resolve(parsed)
    })
  })
}

const raceBoot = (dbPath: string, env: NodeJS.ProcessEnv = {}): Promise<WorkerLine[]> =>
  Promise.all(Array.from({ length: PEERS }, (_, i) => runWorker(dbPath, String.fromCharCode(65 + i), env)))

describe('REPRODUCER: the real bootstrap, raced without the lock', () => {
  let dir: string
  let dbPath: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fresh-boot-stress-'))
    dbPath = join(dir, 'claudeclaw.db')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('with the lock disabled, the real bootstrap breaks under a 4-way race', async () => {
    let sawFailure: string | null = null
    for (let round = 0; round < 6 && sawFailure === null; round++) {
      const roundDir = mkdtempSync(join(tmpdir(), 'fresh-boot-stress-r-'))
      const roundDb = join(roundDir, 'claudeclaw.db')
      try {
        const results = await raceBoot(roundDb, { MARVEEN_BOOTSTRAP_LOCK_DISABLED: '1' })
        const failure = results.find((r) => !r.ok)
        if (failure) sawFailure = failure.error ?? 'unknown'
      } finally {
        rmSync(roundDir, { recursive: true, force: true })
      }
    }
    expect(
      sawFailure,
      'the unlocked bootstrap survived 6 rounds of a 4-way race; either the race got weaker or the guard is no longer what makes it safe',
    ).not.toBeNull()
  }, 300_000)

  it('with the lock ON, the same race over the real bootstrap is clean', async () => {
    const results = await raceBoot(dbPath)
    expect(results.filter((r) => !r.ok).map((f) => `${f.tag}: ${f.error}`)).toEqual([])
  }, 120_000)
})
