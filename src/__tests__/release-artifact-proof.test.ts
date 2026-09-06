import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  symlinkSync, linkSync, appendFileSync, utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// THE CONTROL THE OWNER REQUIRED, 2026-09-06, as a test rather than as a story
// about one afternoon.
//
//     "PIN DECLARES, ARTIFACT PROVES."
//     "írj negatív kontrollt pontosan arra, ami ma történt:
//      pin változatlan + dist csendben lecserélve -> gate MUST FAIL"
//
// WHAT HAPPENED. Preparing a cutover, I ran a plain `npx tsc` in the live
// checkout. It replaced `dist/` -- the code the dashboard loads -- with a build
// of a different commit. The pin was not touched. Twenty minutes later the
// release gate ran and returned `problems: []`, exit 0.
//
// It was green because every check it had compared two DECLARATIONS:
// `activationCandidateSha` in the pin against `.release-sha` in the release
// directory. Both say what the runtime SHOULD be. Neither had ever looked at
// what it IS. The running process survived only by accident -- it had loaded the
// old code hours before -- so any restart would have deployed unapproved code
// under a green gate.
//
// A declaration cannot be wrong about itself, so the fix is a measurement: the
// gate now hashes the deployed tree and compares it to a hash the pin declares.
// The case that matters is the second one below, and it is written to fail if
// the measurement is ever removed or weakened.

const REPO = process.cwd()
const PREFLIGHT_SRC = join(REPO, 'scripts', 'cos-cycle-preflight.sh')
const GUARD_SRC = join(REPO, 'scripts', 'run-pinned-cos-cycle.sh')
const MANIFEST_SRC = join(REPO, 'scripts', 'artifact-manifest.py')

function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

function treeHash(dir: string): { treeHash: string; fileCount: number } {
  const out = execFileSync('python3', [MANIFEST_SRC, dir], { encoding: 'utf-8' })
  return JSON.parse(out) as { treeHash: string; fileCount: number }
}

interface GateResult { code: number; out: string }

function runGate(root: string): GateResult {
  // BOTH streams, on BOTH paths. The gate writes its verdict line to stderr,
  // including when it passes, so reading only stdout on success yields an empty
  // string -- and an assertion against an empty string fails in a way that looks
  // like the check is missing rather than unread.
  const r = spawnSync('bash', [join(root, 'scripts', 'cos-cycle-preflight.sh'), '--verify-only'], {
    env: { ...process.env, MARVEEN_REPO_ROOT: root },
    encoding: 'utf-8',
  })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf-8' }).trim()
}

/** Set the pin's distTreeHash to whatever the deployed tree currently measures,
 *  i.e. a correctly performed cutover. */
function repin(root: string): void {
  const pinPath = join(root, 'releases', 'dashboard-runtime-pin.json')
  const pin = JSON.parse(readFileSync(pinPath, 'utf-8')) as Record<string, unknown>
  const m = treeHash(join(root, 'dist'))
  pin.distTreeHash = m.treeHash
  pin.distFileCount = m.fileCount
  writeFileSync(pinPath, JSON.stringify(pin, null, 1))
}

describe('release artifact proof — the pin declares, the artifact proves', () => {
  let root: string
  let releaseSha: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'artifact-proof-'))

    // A miniature of the real layout. The REAL preflight, guard and manifest
    // tool are copied in and executed -- nothing here is a mock of the thing
    // under test.
    mkdirSync(join(root, 'scripts'), { recursive: true })
    mkdirSync(join(root, 'store'), { recursive: true })
    mkdirSync(join(root, 'dist'), { recursive: true })

    writeFileSync(join(root, 'scripts', 'cos-cycle-preflight.sh'), readFileSync(PREFLIGHT_SRC))
    writeFileSync(join(root, 'scripts', 'run-pinned-cos-cycle.sh'), readFileSync(GUARD_SRC))
    writeFileSync(join(root, 'scripts', 'artifact-manifest.py'), readFileSync(MANIFEST_SRC))

    // The guard resolves the release content out of git, so the fixture is a
    // real repository with a real commit rather than a stubbed sha.
    git(root, 'init', '-q')
    git(root, 'config', 'user.email', 'fixture@example.invalid')
    git(root, 'config', 'user.name', 'fixture')
    writeFileSync(join(root, 'scripts', 'cos-cycle.ts'), '// fixture cycle\n')
    writeFileSync(join(root, 'scripts', 'email-triage-fetch.py'), '# fixture feeder\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'fixture release')
    releaseSha = git(root, 'rev-parse', 'HEAD')

    // The pinned release directory: a COPY built from the commit, as in production.
    const release = join(root, 'releases', `cos-cycle-${releaseSha.slice(0, 9)}`)
    mkdirSync(join(release, 'scripts'), { recursive: true })
    mkdirSync(join(release, 'store'), { recursive: true })
    writeFileSync(join(release, '.release-sha'), releaseSha)
    writeFileSync(join(release, 'scripts', 'cos-cycle.ts'), '// fixture cycle\n')
    symlinkSync(release, join(root, 'releases', 'cos-cycle-current'))

    // The store check compares INODES, so the release must hold the same file.
    writeFileSync(join(root, 'store', 'claudeclaw.db'), 'fixture db')
    linkSync(join(root, 'store', 'claudeclaw.db'), join(release, 'store', 'claudeclaw.db'))

    const feeder = join(root, 'releases', `scheduled-scripts-${releaseSha.slice(0, 9)}`)
    mkdirSync(feeder, { recursive: true })
    writeFileSync(join(feeder, 'email-triage-fetch.py'), '# fixture feeder\n')
    writeFileSync(join(feeder, '.release-sha'), releaseSha)
    symlinkSync(feeder, join(root, 'releases', 'scheduled-scripts-current'))

    const guardDir = join(root, 'releases', `guard-${releaseSha.slice(0, 9)}`)
    mkdirSync(guardDir, { recursive: true })
    writeFileSync(join(guardDir, 'run-pinned-cos-cycle.sh'), readFileSync(GUARD_SRC))
    symlinkSync(guardDir, join(root, 'releases', 'guard-current'))

    // The deployed artifact.
    mkdirSync(join(root, 'dist', 'cos'), { recursive: true })
    writeFileSync(join(root, 'dist', 'index.js'), 'console.log("fixture runtime")\n')
    writeFileSync(join(root, 'dist', 'cos', 'claim-store.js'), 'export const x = 1\n')
    writeFileSync(join(root, 'dist', 'cos', 'case-store.js'), 'export const y = 2\n')

    writeFileSync(join(root, 'releases', 'dashboard-runtime-pin.json'), JSON.stringify({
      note: 'test fixture',
      activationCandidateSha: releaseSha,
      guardSha256: sha256File(join(guardDir, 'run-pinned-cos-cycle.sh')),
      preflightSha256: sha256File(join(root, 'scripts', 'cos-cycle-preflight.sh')),
    }, null, 1))

    repin(root)
  })

  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('a correctly cut-over runtime passes, and says WHICH artifact it measured', () => {
    const ok = runGate(root)
    expect(ok.code, ok.out).toBe(0)
    expect(ok.out).toContain('"distCheck":"verified"')
    const measured = treeHash(join(root, 'dist'))
    expect(ok.out).toContain(`"distTreeHash":"${measured.treeHash.slice(0, 16)}"`)
    expect(ok.out).toContain(`"distFileCount":"${measured.fileCount}"`)
  })

  // ---- THE NEGATIVE CONTROL --------------------------------------------------
  it('pin unchanged + dist silently replaced -> the gate MUST FAIL', () => {
    const before = runGate(root)
    expect(before.code, 'baseline must be green or the control proves nothing').toBe(0)

    const pinPath = join(root, 'releases', 'dashboard-runtime-pin.json')
    const pinBefore = readFileSync(pinPath, 'utf-8')

    // Exactly 2026-09-06: a build lands on top of the active runtime and nobody
    // touches the pin. One byte is enough -- the defect is not about size.
    appendFileSync(join(root, 'dist', 'cos', 'claim-store.js'), '// a different build\n')

    const after = runGate(root)
    expect(readFileSync(pinPath, 'utf-8'), 'the pin must be untouched, that is the point').toBe(pinBefore)
    expect(after.code, 'a silently replaced dist must not pass').toBe(90)
    expect(after.out).toContain('DEPLOYED ARTIFACT IS NOT THE PINNED ONE')
  })

  it('a file ADDED to the deployed tree fails, even though every existing file matches', () => {
    writeFileSync(join(root, 'dist', 'cos', 'smuggled.js'), 'export const z = 3\n')
    const out = runGate(root)
    expect(out.code).toBe(90)
    expect(out.out).toContain('DEPLOYED ARTIFACT IS NOT THE PINNED ONE')
  })

  it('a file REMOVED from the deployed tree fails', () => {
    rmSync(join(root, 'dist', 'cos', 'case-store.js'))
    const out = runGate(root)
    expect(out.code).toBe(90)
    expect(out.out).toContain('DEPLOYED ARTIFACT IS NOT THE PINNED ONE')
  })

  it('a RENAMED file fails, because layout is part of the identity', () => {
    // Same bytes, same file count, different tree. A content-only digest would
    // pass this and it must not: the module graph is addressed by path.
    const from = join(root, 'dist', 'cos', 'case-store.js')
    writeFileSync(join(root, 'dist', 'cos', 'case-store-renamed.js'), readFileSync(from))
    rmSync(from)
    const out = runGate(root)
    expect(out.code).toBe(90)
    expect(out.out).toContain('DEPLOYED ARTIFACT IS NOT THE PINNED ONE')
  })

  it("the artifact's own manifest is checked, never trusted", () => {
    execFileSync('python3', [MANIFEST_SRC, join(root, 'dist'), '--write', releaseSha])
    repin(root)
    const withManifest = runGate(root)
    expect(withManifest.code, withManifest.out).toBe(0)
    expect(withManifest.out).toContain('"distCheck":"verified+self-declared"')

    // Whatever can rewrite the tree can rewrite the manifest, so a manifest that
    // agrees with itself proves nothing. Here it claims a release it is not.
    const mPath = join(root, 'dist', '.artifact-manifest.json')
    const m = JSON.parse(readFileSync(mPath, 'utf-8')) as Record<string, unknown>
    m.releaseSha = '0'.repeat(40)
    writeFileSync(mPath, JSON.stringify(m, null, 1))
    const lying = runGate(root)
    expect(lying.code).toBe(90)
    expect(lying.out).toContain('declares release')
  })

  it('a manifest claiming the wrong tree hash fails', () => {
    execFileSync('python3', [MANIFEST_SRC, join(root, 'dist'), '--write', releaseSha])
    repin(root)
    const mPath = join(root, 'dist', '.artifact-manifest.json')
    const m = JSON.parse(readFileSync(mPath, 'utf-8')) as Record<string, unknown>
    m.treeHash = 'f'.repeat(64)
    writeFileSync(mPath, JSON.stringify(m, null, 1))
    const out = runGate(root)
    expect(out.code).toBe(90)
    expect(out.out).toContain('manifest claims tree')
  })

  it('a pin with no distTreeHash still runs, but REPORTS the skip out loud', () => {
    // Tolerated so a pin written before this hardening keeps the live cycle
    // running. It must never look like a pass.
    const pinPath = join(root, 'releases', 'dashboard-runtime-pin.json')
    const pin = JSON.parse(readFileSync(pinPath, 'utf-8')) as Record<string, unknown>
    delete pin.distTreeHash
    writeFileSync(pinPath, JSON.stringify(pin, null, 1))

    const out = runGate(root)
    expect(out.code).toBe(0)
    expect(out.out).toContain('"distCheck":"SKIPPED_PIN_DECLARES_NO_DIST_TREE_HASH"')
    expect(out.out).not.toContain('"distCheck":"verified"')
  })

  it('with no runtime process, freshness is reported as unchecked rather than as verified', () => {
    const out = runGate(root)
    expect(out.code).toBe(0)
    expect(out.out).toContain('"runtimeFreshness":"NO_RUNTIME_PROCESS_NOT_CHECKED"')
  })

  describe('freshness against a real running process', () => {
    let child: ChildProcess | undefined

    afterEach(() => { child?.kill('SIGKILL'); child = undefined })

    it('a dist modified AFTER the runtime started fails, even when the hash matches', async () => {
      // The mirror image of the negative control, and the same defect: what runs
      // and what is on disk are two different things. Here the tree hash AGREES
      // with the pin -- the file is edited and the pin re-derived -- so only the
      // freshness check can catch it.
      writeFileSync(join(root, 'dist', 'index.js'),
        'setTimeout(() => {}, 60000)\n')
      repin(root)

      child = spawn('node', [join(root, 'dist', 'index.js')], { stdio: 'ignore', detached: false })
      await new Promise((r) => setTimeout(r, 1200))
      expect(child.pid, 'the fixture runtime must be running').toBeGreaterThan(0)

      const green = runGate(root)
      expect(green.code, green.out).toBe(0)
      expect(green.out).toContain('"runtimeFreshness":"verified"')

      // Now the 2026-09-06 move, but with the pin kept honest afterwards: the
      // hash check is satisfied and the process is still running the old bytes.
      await new Promise((r) => setTimeout(r, 1200))
      writeFileSync(join(root, 'dist', 'cos', 'claim-store.js'), 'export const x = 99\n')
      repin(root)

      const red = runGate(root)
      expect(red.code, 'a dist newer than the process it feeds must not pass').toBe(90)
      expect(red.out).toContain('modified AFTER the runtime started')
    })

    it('an artifact left untouched since boot passes freshness', async () => {
      writeFileSync(join(root, 'dist', 'index.js'), 'setTimeout(() => {}, 60000)\n')
      repin(root)
      // Backdate every dist file so "older than the process" is unambiguous
      // rather than a same-second coincidence.
      const old = Date.now() / 1000 - 600
      for (const f of ['index.js', 'cos/claim-store.js', 'cos/case-store.js']) {
        utimesSync(join(root, 'dist', f), old, old)
      }
      child = spawn('node', [join(root, 'dist', 'index.js')], { stdio: 'ignore', detached: false })
      await new Promise((r) => setTimeout(r, 1200))

      const out = runGate(root)
      expect(out.code, out.out).toBe(0)
      expect(out.out).toContain('"runtimeFreshness":"verified"')
    })
  })

  it('the live install carries a distTreeHash, so production is actually covered', () => {
    // A fixture can prove the mechanism and leave production uncovered. That is
    // the 2026-08-26 shape and it must not be repeated one layer up.
    const liveRepo = process.env.MARVEEN_LIVE_REPO ?? join(process.env.HOME ?? '', 'marveen')
    const pinPath = join(liveRepo, 'releases', 'dashboard-runtime-pin.json')
    if (!existsSync(pinPath)) {
      expect(existsSync(pinPath), 'no live install here -- this case did NOT verify production').toBe(false)
      return
    }
    const pin = JSON.parse(readFileSync(pinPath, 'utf-8')) as { distTreeHash?: string }
    expect(pin.distTreeHash, 'the live pin must declare the artifact identity it expects').toMatch(/^[0-9a-f]{64}$/)
  })
})
