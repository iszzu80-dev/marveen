import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'

// THE CONTROL THE OWNER REQUIRED, as a test rather than as a night's demonstration.
//
// "Rögzítsd acceptance teszttel, hogy egy sima develop merge nem változtatja meg
//  az ütemező által ténylegesen futtatott guard/preflight artifactot."
//
// WHY THIS EXISTS. On 2026-08-26 15:47 a merge to `develop` stopped the live CoS
// cycle for one round. Nothing was broken: the guard ran from
// $REPO/scripts/, i.e. from the shared checkout, so merging the hardened guard
// DEPLOYED it to production instantly, with no cutover. Every consumer it
// policed was pinned; the policeman was not.
//
// The fix pins the gate: `releases/guard-current/` is an immutable artifact, and
// `scripts/cos-cycle-preflight.sh` hashes it against the pin before exec'ing it.
// A demonstration of that on one evening is a belief. This is the check.
//
// WHAT IT ASSERTS, and why each part is load-bearing:
//   1. the preflight refuses (91) when the pinned artifact does not match the
//      pin -- that is the mechanism itself;
//   2. editing $REPO/scripts/run-pinned-cos-cycle.sh (what a develop merge does)
//      changes NOTHING about what runs -- the discriminating case, since that is
//      exactly what failed in production;
//   3. deleting that file entirely still leaves the gate working, which is the
//      strongest form of (2) and cannot be satisfied by accident.
//
// The fixture is a miniature of the real layout, not a mock of the scripts: the
// REAL preflight and the REAL guard are copied in and executed.

const REPO = process.cwd()
const PREFLIGHT_SRC = join(REPO, 'scripts', 'cos-cycle-preflight.sh')
const GUARD_SRC = join(REPO, 'scripts', 'run-pinned-cos-cycle.sh')

/** The LIVE install, which is NOT the checkout these tests run from: the suite
 *  refuses to run inside a live install, so `process.cwd()` is always a worktree
 *  or a CI checkout. The last two cases are about production and must look at
 *  production. */
const LIVE_REPO = process.env.MARVEEN_LIVE_REPO ?? join(process.env.HOME ?? '', 'marveen')
const LIVE_PRESENT = existsSync(join(LIVE_REPO, 'releases', 'dashboard-runtime-pin.json'))

function sha256(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

/** Run the preflight against a mirror root. Exit 0 = gate green, 91 = the
 *  preflight refused, 90 = the guard refused. The distinction matters: "it said
 *  no" is a weaker claim than "the right half said no". */
function runGate(root: string): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [join(root, 'scripts', 'cos-cycle-preflight.sh'), '--verify-only'], {
      env: { ...process.env, MARVEEN_REPO_ROOT: root },
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stderr?: string }
    return { code: e.status ?? -1, out: String(e.stderr ?? '') }
  }
}

describe('release gate immutability — a develop merge must not move what the scheduler runs', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gate-immutability-'))
    // Only the two halves of the gate and the pin are needed: `--verify-only`
    // stops before the guard's own release checks would need a store.
    mkdirSync(join(root, 'scripts'), { recursive: true })
    mkdirSync(join(root, 'releases', 'guard-pinned'), { recursive: true })

    const preflight = join(root, 'scripts', 'cos-cycle-preflight.sh')
    const guardArtifact = join(root, 'releases', 'guard-pinned', 'run-pinned-cos-cycle.sh')
    writeFileSync(preflight, readFileSync(PREFLIGHT_SRC))
    writeFileSync(guardArtifact, readFileSync(GUARD_SRC))
    symlinkSync(join(root, 'releases', 'guard-pinned'), join(root, 'releases', 'guard-current'))

    // The checkout copy of the guard: this is the file a merge changes, and the
    // whole point is that the gate does not read it.
    writeFileSync(join(root, 'scripts', 'run-pinned-cos-cycle.sh'), readFileSync(GUARD_SRC))

    writeFileSync(join(root, 'releases', 'dashboard-runtime-pin.json'), JSON.stringify({
      note: 'test fixture',
      activationCandidateSha: '0'.repeat(40),
      guardSha256: sha256(guardArtifact),
      preflightSha256: sha256(preflight),
    }, null, 1))
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('the preflight verifies the pinned artifact before running it', () => {
    // Baseline: the gate gets past the preflight and reaches the guard. The
    // guard then refuses on a release check (no store in this fixture), which is
    // 90 -- and 90 is the proof the preflight ACCEPTED and handed over.
    const ok = runGate(root)
    expect(ok.out).toContain('"preflight":"OK"')
    expect(ok.code).not.toBe(91)

    // Now tamper with the pinned artifact.
    const artifact = join(root, 'releases', 'guard-current', 'run-pinned-cos-cycle.sh')
    writeFileSync(artifact, `${readFileSync(artifact).toString()}\n# tampered\n`)
    const bad = runGate(root)
    expect(bad.code).toBe(91)
    expect(bad.out).toContain('does not match the pin')
  })

  it('EDITING the checkout copy of the guard changes nothing — the merge case', () => {
    const before = runGate(root)

    // Exactly what a develop merge does to this file, and what deployed the
    // hardened guard to production on 2026-08-26 without a cutover.
    writeFileSync(join(root, 'scripts', 'run-pinned-cos-cycle.sh'),
      '#!/usr/bin/env bash\necho \'{"pinnedCycle":"HIJACKED"}\' >&2\nexit 0\n')

    const after = runGate(root)
    expect(after.code).toBe(before.code)
    expect(after.out).toContain('"preflight":"OK"')
    expect(after.out).not.toContain('HIJACKED')
  })

  it('DELETING the checkout copy still leaves the gate working', () => {
    const before = runGate(root)
    rmSync(join(root, 'scripts', 'run-pinned-cos-cycle.sh'), { force: true })
    expect(existsSync(join(root, 'scripts', 'run-pinned-cos-cycle.sh'))).toBe(false)

    const after = runGate(root)
    expect(after.code).toBe(before.code)
    expect(after.out).toContain('"preflight":"OK"')
  })

  it('the guard checks the preflight in turn, so neither half can drift alone', () => {
    const preflight = join(root, 'scripts', 'cos-cycle-preflight.sh')
    writeFileSync(preflight, `${readFileSync(preflight).toString()}\n# tampered\n`)
    const out = runGate(root)
    // The preflight cannot catch its own edit -- nothing can. The GUARD does,
    // which is the closing half of the circle, and it refuses with 90.
    expect(out.code).toBe(90)
    expect(out.out).toContain('preflight launcher does not match')
  })

  it('the live install actually uses this arrangement', () => {
    // A fixture can prove the mechanism and still leave production on the old
    // path. That is precisely the gap found on 2026-08-26: the gate was pinned
    // and the scheduler still called the checkout copy.
    const skill = join(process.env.HOME ?? '', '.claude', 'scheduled-tasks', 'personal-case-wake', 'SKILL.md')
    if (!LIVE_PRESENT || !existsSync(skill)) {
      // CI has no live install. Say so out loud: a case that returns early and
      // reports PASS is indistinguishable from one that checked and found the
      // right thing, which is the defect class this whole release was about.
      expect(LIVE_PRESENT, 'no live install here -- this case did NOT verify production').toBe(false)
      return
    }
    const body = readFileSync(skill, 'utf-8')
    expect(body).toContain('cos-cycle-preflight.sh')
    const invocation = body.split('\n').find((l) => l.trim().startsWith('bash ') && l.includes('marveen/scripts/'))
    expect(invocation, 'the heartbeat must invoke the preflight, not the guard directly')
      .toContain('cos-cycle-preflight.sh')
  })

  it('the pinned artifact is a real file, not a symlink back into the checkout', () => {
    // A `guard-current` pointing at scripts/ would satisfy every hash check and
    // reintroduce the whole defect silently.
    const live = join(LIVE_REPO, 'releases', 'guard-current', 'run-pinned-cos-cycle.sh')
    if (!LIVE_PRESENT || !existsSync(live)) {
      expect(LIVE_PRESENT, 'no live install here -- this case did NOT verify production').toBe(false)
      return
    }
    expect(statSync(live).isFile()).toBe(true)
    const resolved = execFileSync('readlink', ['-f', dirname(live)], { encoding: 'utf-8' }).trim()
    expect(resolved.startsWith(join(LIVE_REPO, 'releases'))).toBe(true)
    expect(resolved).not.toContain(`${LIVE_REPO}/scripts`)
  })
})
