#!/usr/bin/env npx tsx
/**
 * Build the runtime FROM AN IMMUTABLE RELEASE ARTIFACT, and make it prove what
 * it is.
 *
 * The cutover script used to run `npm run build` in the shared checkout, so the
 * artifact it deployed was whatever that checkout happened to be on. This builds
 * only inside `releases/cos-cycle-<short>/`, which the cutover extracted with
 * `git archive` from the object store, and then:
 *
 *   1. MEASURES the source tree it is about to compile and checks that digest
 *      against a fresh `git archive <sha>` -- so `sourceSha` is a measurement,
 *      not a label somebody typed into a file;
 *   2. compiles;
 *   3. writes the provenance manifest INTO the dist, from the bytes it produced.
 *
 * Usage: npx tsx scripts/build-release-dist.ts <releaseDir> [--expect-sha <sha>]
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { digestSourceTree, writeBuildProvenance, verifyRuntimeProvenance, STATIC_SUBDIR } from '../src/release/provenance.js'

const args = process.argv.slice(2)
const releaseDir = args[0]
const expectIdx = args.indexOf('--expect-sha')
const expectSha = expectIdx >= 0 ? args[expectIdx + 1] : undefined
const REPO = process.env.MARVEEN_REPO_ROOT || join(homedir(), 'marveen')

const die = (msg: string): never => { console.error(`BUILD REFUSED: ${msg}`); process.exit(93) }

if (!releaseDir || !existsSync(releaseDir)) die(`no such release dir: ${releaseDir}`)
const shaFile = join(releaseDir, '.release-sha')
if (!existsSync(shaFile)) die(`${releaseDir} carries no .release-sha -- it is not a release artifact`)
const sourceSha = readFileSync(shaFile, 'utf8').trim()
if (!/^[0-9a-f]{40}$/.test(sourceSha)) die(`.release-sha is not a commit sha: ${sourceSha}`)
if (expectSha && sourceSha !== expectSha) die(`this artifact is ${sourceSha}, expected ${expectSha}`)

// THE FRONTEND IS PART OF THE RELEASE (owner ruling, 2026-09-03). A candidate
// that ships no web/ cannot be built, because the runtime it would produce could
// only serve a frontend from somewhere outside its own identity -- which is the
// exact defect this change exists to close. Refusing here rather than warning is
// the point: a release that quietly builds without a frontend is indistinguishable
// from one that has it.
const webSrc = join(releaseDir, 'web')
if (!existsSync(webSrc)) {
  die(`${releaseDir} ships no web/ -- the frontend is part of the release artifact and this candidate has none`)
}

// ── 1. the source tree is MEASURED against git, not trusted ──────────────────
// This is the step that turns .release-sha from a claim into a fact. A release
// dir edited by hand -- the exact thing check 2 of the pinned guard exists for --
// fails here, before anything is compiled.
const built = digestSourceTree(releaseDir)
const scratch = mkdtempSync(join(tmpdir(), 'relverify-'))
let fromGit: string
try {
  mkdirSync(join(scratch, 'x'), { recursive: true })
  const tar = execFileSync('git', ['-C', REPO, 'archive', sourceSha, 'src', 'web', 'package.json', 'tsconfig.json'], {
    maxBuffer: 512 * 1024 * 1024, encoding: 'buffer',
  })
  const tarPath = join(scratch, 'a.tar')
  writeFileSync(tarPath, tar)
  execFileSync('tar', ['-x', '-f', tarPath, '-C', join(scratch, 'x')])
  fromGit = digestSourceTree(join(scratch, 'x'))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
if (built !== fromGit) {
  die(`the release dir's source does NOT match git ${sourceSha.slice(0, 9)}:\n` +
      `  release dir: ${built}\n  git archive: ${fromGit}\n` +
      `Something edited the artifact after it was extracted.`)
}
console.log(`source verified against git ${sourceSha.slice(0, 9)}: ${built.slice(0, 16)}`)

// ── 2. compile, inside the artifact ─────────────────────────────────────────
const distDir = join(releaseDir, 'dist')
rmSync(distDir, { recursive: true, force: true })
try {
  execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: releaseDir, stdio: 'inherit' })
} catch {
  die('tsc failed inside the release artifact')
}
if (!existsSync(distDir)) die('tsc produced no dist')

// ── 2b. the frontend moves INTO the artifact ────────────────────────────────
// Copied, not symlinked and not left behind: the thing that gets installed as
// $REPO/dist has to CONTAIN the page it serves, or the two halves can be
// separated again by anything that moves the source directory afterwards.
const staticDir = join(distDir, STATIC_SUBDIR)
rmSync(staticDir, { recursive: true, force: true })
cpSync(webSrc, staticDir, { recursive: true, dereference: true })
if (!existsSync(join(staticDir, 'index.html'))) {
  die(`the frontend copy produced no ${STATIC_SUBDIR}/index.html -- refusing to ship an artifact whose page is missing`)
}

// ── 3. provenance, written from what was actually produced ──────────────────
const p = writeBuildProvenance(distDir, {
  sourceSha,
  releaseId: releaseDir.split('/').filter(Boolean).pop() ?? 'unknown',
  sourceTreeHash: built,
  builder: 'build-release-dist.ts',
})
console.log(`built ${p.distFileCount} files, dist ${p.distHash.slice(0, 16)}, provenance written`)
console.log(`frontend shipped inside the artifact: ${p.staticFileCount} files, ${p.staticTreeHash.slice(0, 16)}`)

// ── 4. the builder verifies its own output, or the whole thing is theatre ────
const v = verifyRuntimeProvenance(distDir, sourceSha)
if (!v.ok) die(`the build cannot verify its own artifact: ${v.failure} -- ${v.detail}`)
console.log(`SELF-VERIFIED: ${v.detail}`)
