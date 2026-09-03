#!/usr/bin/env npx tsx
/**
 * Measure what is DEPLOYED and say which commit it proves.
 *
 * The readback this replaces was `pin.activationCandidateSha` compared against
 * `release/.release-sha` -- two values descended from the same declaration, so
 * it passed over a dist built from a different branch entirely. This one reads
 * the deployed files.
 *
 * Usage: npx tsx scripts/verify-runtime-provenance.ts [--dist <dir>] [--expect <sha>] [--expect-from-pin]
 *
 * `--expect-from-pin` takes the EXPECTATION from the pin -- which is the pin's
 * only legitimate role: it declares what SHOULD run. The evidence still comes
 * from the artifact.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  verifyRuntimeProvenance, verifySourceShaAgainstGit, readProvenanceManifest, digestSourceTree,
} from '../src/release/provenance.js'

/** Recompute a commit's source digest straight from the object store. Null when
 *  the repository has never heard of the commit -- which is itself a refusal,
 *  not a pass. */
function sourceTreeHashFromGit(repo: string, sha: string): string | null {
  try { execFileSync('git', ['-C', repo, 'cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' }) } catch { return null }
  const scratch = mkdtempSync(join(tmpdir(), 'provgit-'))
  try {
    const x = join(scratch, 'x'); mkdirSync(x, { recursive: true })
    const tarPath = join(scratch, 'a.tar')
    writeFileSync(tarPath, execFileSync('git', ['-C', repo, 'archive', sha, 'src', 'web', 'package.json', 'tsconfig.json'],
      { maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' }))
    execFileSync('tar', ['-x', '-f', tarPath, '-C', x])
    return digestSourceTree(x)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

const argv = process.argv.slice(2)
const val = (flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}
const REPO = process.env.MARVEEN_REPO_ROOT || join(homedir(), 'marveen')
const distDir = val('--dist') ?? join(REPO, 'dist')
let expect = val('--expect')

if (argv.includes('--expect-from-pin')) {
  const pinPath = join(REPO, 'releases', 'dashboard-runtime-pin.json')
  if (!existsSync(pinPath)) { console.error('no pin file'); process.exit(94) }
  expect = (JSON.parse(readFileSync(pinPath, 'utf8')) as { activationCandidateSha: string }).activationCandidateSha
  console.log(`pin DECLARES: ${expect}`)
}

const v = verifyRuntimeProvenance(distDir, expect)

// THE SECOND HALF, and it is not optional. The hash check proves the deployed
// bytes are the ones the manifest recorded; it cannot prove the manifest names
// the right commit, because a rewritten sourceSha leaves every hash consistent.
// Cross-checking sourceTreeHash against `git archive <sourceSha>` is what makes
// the manifest non-self-certifying. `--no-git-crosscheck` exists for a host with
// no repository, and it SAYS so in the output rather than quietly degrading.
let cross: { ok: boolean; failure?: string; detail: string } | null = null
const skipCross = argv.includes('--no-git-crosscheck')
const m = readProvenanceManifest(distDir)
if (!skipCross && m) {
  cross = verifySourceShaAgainstGit(m, (sha) => sourceTreeHashFromGit(REPO, sha))
}

const ok = v.ok && (skipCross || cross?.ok === true)
console.log(JSON.stringify({
  dist: distDir,
  ok,
  hashCheck: { ok: v.ok, failure: v.failure ?? null, detail: v.detail },
  gitCrossCheck: skipCross ? 'SKIPPED (--no-git-crosscheck)' : cross,
  measured: v.measured ?? null,
  // The frontend, named separately in the output. The owner has to be able to
  // read "which page is this runtime serving" off one command, without knowing
  // that it is folded into distHash.
  frontend: m ? {
    inArtifact: (v.measured?.staticFileCount ?? 0) > 0,
    files: v.measured?.staticFileCount ?? 0,
    treeHash: v.measured?.staticTreeHash ?? null,
    coscontrolJs: m.staticFiles?.find((f) => f.path === 'static/coscontrol.js')?.sha256 ?? null,
  } : null,
  expected: expect ?? null,
}, null, 2))
process.exit(ok ? 0 : 94)
