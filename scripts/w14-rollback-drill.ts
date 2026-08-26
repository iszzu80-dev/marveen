#!/usr/bin/env npx tsx
/**
 * W14 — PRODUCTION-EQUIVALENT ISOLATED ROLLBACK DRILL (the CODE layer).
 *
 * MIP-v1.0 §8.8 asks for an exercised rollback runbook. W14 shipped the runbook
 * with the CODE layer marked "practice only — NOT exercised", because the only
 * way to exercise it live was to restart the owner's dashboard at 02:00, and a
 * drill that causes the outage it prevents is not a drill.
 *
 * The owner's Phase 0 gate (2026-08-26) named the way out: a production-
 * equivalent ISOLATED drill with the same release artifact / pin / store /
 * consumer alignment; a live quiet-window drill only if isolation cannot prove
 * it honestly. This is that drill.
 *
 * WHAT MAKES IT PRODUCTION-EQUIVALENT, rather than a mock of one:
 *   - a real local clone of this repo, so `git show <sha>:path` resolves the
 *     same way the live guard resolves it;
 *   - releases built the way production builds them — `git archive <sha>` into
 *     `releases/cos-cycle-<sha>/`, with `store` and `node_modules` symlinked;
 *   - a REAL COPY of the live store (not a fixture, not an empty database), so
 *     the inode check has something true to say;
 *   - the SAME guard binary: `scripts/run-pinned-cos-cycle.sh --verify-only`,
 *     run with MARVEEN_REPO_ROOT pointed at the mirror. Not a reimplementation
 *     of its logic -- a reimplementation would drill the drill, not the guard.
 *
 * WHAT IT IS NOT. It does not restart a systemd service and does not touch
 * anything under the live tree. The one thing it therefore cannot prove is that
 * `systemctl --user restart` brings the dashboard back; that step is unchanged
 * from the daily restarts the install already survives, and it is called out in
 * the runbook rather than claimed here.
 *
 * SAFETY. Step 1 asserts the mirror store is a DIFFERENT INODE from the live
 * one before anything else runs, and the drill aborts if it is not. A drill that
 * could write to production is worse than no drill.
 *
 * usage:
 *   npx tsx scripts/w14-rollback-drill.ts --from <shaA> --to <shaB> [--keep]
 */
import { execFileSync } from 'node:child_process'
import {
  mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, symlinkSync,
  statSync, existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'

const LIVE_REPO = process.env.MARVEEN_LIVE_REPO ?? join(homedir(), 'marveen')
const LIVE_STORE = join(LIVE_REPO, 'store', 'claudeclaw.db')

interface Step { step: string; expect: string; got: string; pass: boolean; detail?: string }
const steps: Step[] = []
function record(step: string, expect: string, got: string, detail?: string): boolean {
  const pass = expect === got
  steps.push({ step, expect, got, pass, detail })
  const mark = pass ? 'PASS' : 'FAIL'
  console.error(`  [${mark}] ${step}  expect=${expect} got=${got}${detail ? `  (${detail})` : ''}`)
  return pass
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1]!
  if (fallback !== undefined) return fallback
  throw new Error(`missing --${name}`)
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', maxBuffer: 1 << 28 })
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** Run the REAL release gate against the mirror -- through the PREFLIGHT, which
 *  is how production invokes it. Returns the exit code and the JSON line printed
 *  on stderr. Exit 90 = the guard refused; 91 = the preflight refused before the
 *  guard ever ran. The drill asserts on WHICH of the two spoke, because "it said
 *  no" is a weaker claim than "the right check said no". */
function runGuard(mirror: string, guardPath: string): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [guardPath, '--verify-only'], {
      env: { ...process.env, MARVEEN_REPO_ROOT: mirror },
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stderr?: string }
    return { code: e.status ?? -1, out: String(e.stderr ?? '') }
  }
}

/** Deploy one candidate into the mirror the way production does: a release
 *  archive per consumer, `current` symlinks moved together, pin file rewritten.
 *
 *  `gateSha` is deliberately SEPARATE from the payload sha. The release gate
 *  (preflight + guard) is versioned independently of what it polices, for a
 *  reason the drill discovered rather than assumed: **the currently pinned
 *  runtime `0011de922` does not contain `scripts/run-pinned-cos-cycle.sh` at
 *  all** -- the guard was added to develop AFTER that candidate was cut
 *  (fa88bb94). So a gate that rolled back with the payload would roll back to no
 *  gate.
 *
 *  The invariant this encodes: **a gate only ever REFUSES, so keeping the
 *  stricter gate across a rollback cannot cause a bad release -- only block
 *  one.** The `.release-sha` marker the hardened gate requires is deployment
 *  metadata written by THIS function for every candidate, including a rollback
 *  target, so an older payload does not become unrunnable under a newer gate. */
function deploy(mirror: string, sha: string, gateSha: string): void {
  const releases = join(mirror, 'releases')
  const cycleDir = join(releases, `cos-cycle-${sha.slice(0, 9)}`)
  const feederDir = join(releases, `scheduled-scripts-${sha.slice(0, 9)}`)

  for (const [dir, paths] of [
    [cycleDir, ['scripts', 'src', 'package.json', 'tsconfig.json']],
    [feederDir, ['scripts/email-triage-fetch.py']],
  ] as Array<[string, string[]]>) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
      const tar = execFileSync('git', ['-C', mirror, 'archive', sha, ...paths], { maxBuffer: 1 << 30 })
      execFileSync('tar', ['-x', '-C', dir], { input: tar })
    }
  }
  writeFileSync(join(cycleDir, '.release-sha'), `${sha}\n`)
  // The feeder release is flat in production: scripts/<file> hoisted to <file>.
  const feederSrc = join(feederDir, 'scripts', 'email-triage-fetch.py')
  if (existsSync(feederSrc)) copyFileSync(feederSrc, join(feederDir, 'email-triage-fetch.py'))

  for (const p of [join(cycleDir, 'store'), join(cycleDir, 'node_modules')]) {
    if (!existsSync(p)) {
      symlinkSync(p.endsWith('store') ? join(mirror, 'store') : join(LIVE_REPO, 'node_modules'), p)
    }
  }
  // PROVENANCE, not just content. Between two candidates that ship an identical
  // feeder the hash check cannot discriminate; the marker can.
  writeFileSync(join(feederDir, '.release-sha'), `${sha}\n`)

  // The guard is itself a pinned artifact from THIS sha, not develop's copy.
  const guardDir = join(releases, `guard-${gateSha.slice(0, 9)}`)
  if (!existsSync(guardDir)) mkdirSync(guardDir, { recursive: true })
  writeFileSync(join(guardDir, 'run-pinned-cos-cycle.sh'),
    git(mirror, ['show', `${gateSha}:scripts/run-pinned-cos-cycle.sh`]))

  relink(join(releases, 'cos-cycle-current'), cycleDir)
  relink(join(releases, 'scheduled-scripts-current'), feederDir)
  relink(join(releases, 'guard-current'), guardDir)
  writePin(mirror, sha, gateSha)
}

function relink(link: string, target: string): void {
  rmSync(link, { force: true, recursive: false })
  symlinkSync(target, link)
}

/** The pin is the single statement of what the release-gate IS: it carries the
 *  candidate sha AND the digests of the two halves of the gate. Neither script
 *  can verify itself; each verifies the other against these values. */
function writePin(mirror: string, sha: string, gateSha: string): void {
  const guard = join(mirror, 'releases', `guard-${gateSha.slice(0, 9)}`, 'run-pinned-cos-cycle.sh')
  const preflight = join(mirror, 'scripts', 'cos-cycle-preflight.sh')
  writeFileSync(join(mirror, 'releases', 'dashboard-runtime-pin.json'), JSON.stringify({
    note: 'rollback drill mirror — not a production pin',
    deployedAt: new Date(0).toISOString(),
    activationCandidateSha: sha,
    gateSha,
    guardSha256: existsSync(guard) ? sha256(readFileSync(guard)) : '',
    preflightSha256: existsSync(preflight) ? sha256(readFileSync(preflight)) : '',
  }, null, 1))
}

function caseCounts(dbPath: string): { personal: number; zst: number; integrity: string } {
  const db = new Database(dbPath, { readonly: true })
  const one = (sql: string): number => {
    try { return (db.prepare(sql).get() as { n: number }).n } catch { return -1 }
  }
  const personal = one('SELECT count(*) AS n FROM personal_cases')
  const zst = one('SELECT count(*) AS n FROM zst_cases')
  const integrity = String((db.pragma('integrity_check') as Array<{ integrity_check: string }>)[0]?.integrity_check)
  db.close()
  return { personal, zst, integrity }
}

async function main(): Promise<void> {
  const from = arg('from')
  const to = arg('to')
  const keep = process.argv.includes('--keep')
  // Deliberately NOT under /tmp: /tmp is tmpfs on this box and the store copy is
  // ~180 MB, which would come out of the fleet's RAM.
  const mirror = arg('workdir', join(homedir(), `.marveen-rollback-drill-${Date.now()}`))

  console.error(`rollback drill: ${from.slice(0, 9)} -> ${to.slice(0, 9)} -> back to ${from.slice(0, 9)}`)
  console.error(`mirror: ${mirror}`)

  mkdirSync(join(mirror, 'store'), { recursive: true })
  mkdirSync(join(mirror, 'releases'), { recursive: true })

  // --- 1. isolation, asserted before anything else can run --------------------
  // `--shared` borrows the object store read-only; it never writes to the live
  // repo. The working tree is not checked out: the guard only needs `git show`.
  git(LIVE_REPO, ['clone', '--local', '--shared', '--no-checkout', LIVE_REPO, mirror + '/.gitrepo'])
  execFileSync('bash', ['-c', `mv ${JSON.stringify(mirror + '/.gitrepo/.git')} ${JSON.stringify(mirror + '/.git')} && rmdir ${JSON.stringify(mirror + '/.gitrepo')}`])
  git(mirror, ['config', 'core.bare', 'false'])

  const mirrorStore = join(mirror, 'store', 'claudeclaw.db')
  copyFileSync(LIVE_STORE, mirrorStore)
  const liveIno = statSync(LIVE_STORE).ino
  const mirrorIno = statSync(mirrorStore).ino
  if (liveIno === mirrorIno) throw new Error('ABORT: the mirror store is the LIVE file; refusing to drill')
  record('1. mirror store is isolated from the live store', 'different-inode',
    liveIno === mirrorIno ? 'SAME-INODE' : 'different-inode', `live=${liveIno} mirror=${mirrorIno}`)

  // Both halves of the release gate, installed the way production has them: the
  // PREFLIGHT at a stable path, the GUARD only as a pinned release artifact
  // (deploy() writes it). The drill invokes the preflight, never the guard
  // directly -- driving the guard directly would skip the very check the owner
  // asked for.
  mkdirSync(join(mirror, 'scripts'), { recursive: true })
  const preflightPath = join(mirror, 'scripts', 'cos-cycle-preflight.sh')
  writeFileSync(preflightPath, git(mirror, ['show', `${to}:scripts/cos-cycle-preflight.sh`]))
  const guardPath = preflightPath

  const baseline = caseCounts(mirrorStore)
  record('2. store baseline readable', 'ok', baseline.integrity,
    `personal=${baseline.personal} zst=${baseline.zst}`)

  // --- 3. deploy A, guard green ----------------------------------------------
  deploy(mirror, from, to)
  record('3. candidate A deployed, guard accepts', '0', String(runGuard(mirror, guardPath).code))

  // --- 4. roll forward to B ---------------------------------------------------
  deploy(mirror, to, to)
  record('4. rolled forward to B, guard accepts', '0', String(runGuard(mirror, guardPath).code))

  // --- 5. the RED half of the drill ------------------------------------------
  // A rollback that moves the PIN and forgets a consumer is the failure the
  // real cutover already made once (see the pin file's own correction note).
  // The drill has to show the guard catches it, not assume it.
  writePin(mirror, from, to)
  const halfPin = runGuard(mirror, guardPath)
  record('5a. pin rolled back, consumers not: guard REFUSES', '90', String(halfPin.code),
    /!=/.test(halfPin.out) ? 'reason names the sha mismatch' : `unexpected reason: ${halfPin.out.slice(0, 160)}`)

  writePin(mirror, to, to)
  relink(join(mirror, 'releases', 'scheduled-scripts-current'), join(mirror, 'releases', `scheduled-scripts-${from.slice(0, 9)}`))
  const halfFeeder = runGuard(mirror, guardPath)
  const feederIdentical = git(mirror, ['show', `${from}:scripts/email-triage-fetch.py`]) ===
    git(mirror, ['show', `${to}:scripts/email-triage-fetch.py`])
  // THE case the owner required: byte-identical feeder, WRONG release provenance.
  // Before the hardening this passed, because the check hashed content only.
  record('5b. feeder rolled back (identical BYTES, wrong release): guard REFUSES', '90',
    String(halfFeeder.code),
    feederIdentical
      ? 'A and B ship a byte-identical feeder, so ONLY the .release-sha marker can tell them apart -- this is the discriminating case'
      : 'A and B ship different feeder content; the hash check also bites here')
  record('5b-reason. the refusal names the feeder RELEASE, not its bytes', 'true',
    String(/declares release/.test(halfFeeder.out)), halfFeeder.out.slice(0, 200))
  relink(join(mirror, 'releases', 'scheduled-scripts-current'), join(mirror, 'releases', `scheduled-scripts-${to.slice(0, 9)}`))

  // 5c. Consumers and pin all correct -- but the GUARD ARTIFACT is not the pinned
  // one. The preflight must refuse BEFORE the guard runs (91, not 90).
  const guardArtifact = join(mirror, 'releases', 'guard-current', 'run-pinned-cos-cycle.sh')
  const guardGood = readFileSync(guardArtifact)
  writeFileSync(guardArtifact, `${guardGood.toString()}\n# mutated by the drill\n`)
  const mutatedGuard = runGuard(mirror, guardPath)
  record('5c. correct consumers/pin, MUTATED guard artifact: PREFLIGHT refuses', '91',
    String(mutatedGuard.code),
    /does not match the pin/.test(mutatedGuard.out) ? 'refusal names the pin mismatch' : mutatedGuard.out.slice(0, 160))

  // 5d. ...and the same when the hardened guard is REMOVED rather than edited.
  rmSync(guardArtifact, { force: true })
  const missingGuard = runGuard(mirror, guardPath)
  record('5d. hardened guard REMOVED: PREFLIGHT refuses', '91', String(missingGuard.code),
    /no pinned guard artifact/.test(missingGuard.out) ? 'refusal names the missing artifact' : missingGuard.out.slice(0, 160))
  writeFileSync(guardArtifact, guardGood)

  // 5e. The other half of the circle: the PREFLIGHT is tampered with, and the
  // guard -- which the preflight has just exec'd -- refuses on its behalf.
  const preflightGood = readFileSync(preflightPath)
  writeFileSync(preflightPath, `${preflightGood.toString()}\n# mutated by the drill\n`)
  const mutatedPreflight = runGuard(mirror, guardPath)
  record('5e. MUTATED preflight: the guard refuses (the circle closes)', '90',
    String(mutatedPreflight.code),
    /preflight launcher does not match/.test(mutatedPreflight.out) ? 'refusal names the preflight' : mutatedPreflight.out.slice(0, 160))
  writeFileSync(preflightPath, preflightGood)

  // --- 6. complete the rollback ------------------------------------------------
  deploy(mirror, from, to)
  record('6. full rollback to A, guard accepts', '0', String(runGuard(mirror, guardPath).code))

  // --- 7. the code really moved, by content and not by label -------------------
  const releasedCycle = readFileSync(join(mirror, 'releases', 'cos-cycle-current', 'scripts', 'cos-cycle.ts'))
  const wantA = sha256(git(mirror, ['show', `${from}:scripts/cos-cycle.ts`]))
  const wantB = sha256(git(mirror, ['show', `${to}:scripts/cos-cycle.ts`]))
  record('7a. running release content == A', wantA, sha256(releasedCycle))
  record('7b. ...and is NOT B', wantA === wantB ? 'IDENTICAL-SHAS' : 'differs',
    wantA === wantB ? 'IDENTICAL-SHAS' : (sha256(releasedCycle) === wantB ? 'MATCHES-B' : 'differs'),
    wantA === wantB ? 'A and B ship the same cos-cycle.ts; this assertion cannot discriminate' : undefined)

  // --- 8. data untouched by a code rollback ------------------------------------
  const after = caseCounts(mirrorStore)
  record('8a. store integrity after rollback', 'ok', after.integrity)
  record('8b. case counts unchanged by the code rollback',
    `${baseline.personal}/${baseline.zst}`, `${after.personal}/${after.zst}`)

  const failed = steps.filter((s) => !s.pass)
  console.log(JSON.stringify({
    drill: 'w14-rollback-code-layer', from, to, mirror: keep ? mirror : '(removed)',
    liveStoreInode: liveIno, mirrorStoreInode: mirrorIno,
    steps, failed: failed.map((f) => f.step), ok: failed.length === 0,
  }, null, 1))

  if (!keep) rmSync(mirror, { recursive: true, force: true })
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((err) => {
  console.log(JSON.stringify({ drill: 'w14-rollback-code-layer', ok: false, error: String(err?.message ?? err), steps }, null, 1))
  process.exitCode = 1
})
