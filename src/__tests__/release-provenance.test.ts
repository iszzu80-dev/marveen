import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  digestSourceTree, digestDistTree, writeBuildProvenance, verifyRuntimeProvenance,
  verifySourceShaAgainstGit, readProvenanceManifest, PROVENANCE_FILENAME,
} from '../release/provenance.js'

// RUNTIME BUILD PROVENANCE, 2026-08-31. The owner made this a P0 release-integrity
// blocker after the Checkpoint E repin exposed it:
//
//   "Ha a runtimeSha ugyanabból a pin fájlból származik, amit bizonyítani
//    akarunk, a readback tautológia."
//
// His acceptance list names six negative controls and one positive. Each is its
// own test below, in his order, because a control that only exists inside another
// test's setup is a control nobody has watched fail.

const SHA_A = 'a8c229552e2f798adc7ff0e053f062a504543bc5'
const SHA_B = '54ae4cf12499f4dd86546d9927b2a96c9fc61b92'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'prov-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** A dist that looks like a build output. */
function makeDist(name: string, files: Record<string, string>): string {
  const d = join(root, name)
  mkdirSync(join(d, 'cos'), { recursive: true })
  for (const [p, body] of Object.entries(files)) {
    const abs = join(d, p)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  return d
}

const CANDIDATE_FILES = { 'index.js': 'export const a = 1\n', 'cos/source-id.js': 'export const classify = () => 1\n' }
const DEVELOP_FILES = { 'index.js': 'export const a = 1\n' }

function built(name: string, sha: string, files: Record<string, string>): string {
  const d = makeDist(name, files)
  writeBuildProvenance(d, { sourceSha: sha, releaseId: `cos-cycle-${sha.slice(0, 9)}`, sourceTreeHash: 'src-' + sha, builder: 'test' })
  return d
}

describe('POSITIVE CONTROL -- the exact candidate artifact', () => {
  it('build -> deploy -> measured live provenance -> SHA match -> PASS', () => {
    const d = built('dist-a', SHA_A, CANDIDATE_FILES)
    const v = verifyRuntimeProvenance(d, SHA_A)
    expect(v.ok).toBe(true)
    expect(v.failure).toBeUndefined()
    // MEASURED from the files, not echoed from an input.
    expect(v.measured!.sourceSha).toBe(SHA_A)
    expect(v.measured!.distFileCount).toBe(2)
    expect(v.measured!.distHash).toHaveLength(64)
  })

  it('the manifest does not hash itself -- adding it does not change the dist hash', () => {
    // If the provenance file were inside its own digest, no manifest could ever
    // be written that verified.
    const d = makeDist('dist-x', CANDIDATE_FILES)
    const before = digestDistTree(d).hash
    writeBuildProvenance(d, { sourceSha: SHA_A, releaseId: 'r', sourceTreeHash: 's', builder: 'test' })
    expect(digestDistTree(d).hash).toBe(before)
  })
})

describe('NEGATIVE CONTROLS -- each must go red', () => {
  it('1. candidate A pin + candidate B dist', () => {
    // The literal defect: the pin says A, the deployed bytes are B.
    const d = built('dist-b', SHA_B, DEVELOP_FILES)
    const v = verifyRuntimeProvenance(d, SHA_A)
    expect(v.ok).toBe(false)
    expect(v.failure).toBe('SOURCE_MISMATCH')
    expect(v.detail).toContain(SHA_B)
    expect(v.detail).toContain(SHA_A)
  })

  it('2. shared develop differs from the candidate -- a develop build cannot pass as the candidate', () => {
    // What actually happened on 2026-08-31: dist came from develop, and the file
    // only the candidate has was missing.
    const devDist = built('dist-dev', SHA_B, DEVELOP_FILES)
    expect(existsSync(join(devDist, 'cos/source-id.js'))).toBe(false)
    expect(verifyRuntimeProvenance(devDist, SHA_A).failure).toBe('SOURCE_MISMATCH')

    const candDist = built('dist-cand', SHA_A, CANDIDATE_FILES)
    expect(existsSync(join(candDist, 'cos/source-id.js'))).toBe(true)
    expect(verifyRuntimeProvenance(candDist, SHA_A).ok).toBe(true)
  })

  it('3. artifact provenance is MISSING -- absence is a failure, not a pass', () => {
    const d = makeDist('dist-bare', CANDIDATE_FILES)
    const v = verifyRuntimeProvenance(d, SHA_A)
    expect(v.ok).toBe(false)
    expect(v.failure).toBe('MISSING')
    // And missing WITHOUT an expectation is still a failure: an artifact that
    // cannot say what it is has exactly the property this mechanism removes.
    expect(verifyRuntimeProvenance(d).ok).toBe(false)
  })

  it('4. manifest / source SHA manipulated -- caught by the git cross-check', () => {
    const d = built('dist-forged', SHA_B, DEVELOP_FILES)
    const mp = join(d, PROVENANCE_FILENAME)
    const m = JSON.parse(readFileSync(mp, 'utf8'))
    m.sourceSha = SHA_A                       // claim the candidate...
    writeFileSync(mp, JSON.stringify(m, null, 2))   // ...leave B's bytes alone

    // The hash-only check cannot see it: the dist digest was computed over the
    // real bytes and they did not change. Recorded so the boundary is explicit.
    expect(verifyRuntimeProvenance(d, SHA_A).ok).toBe(true)

    // The cross-check does see it. Commit A's source does not hash to the digest
    // the manifest carries, because that digest came from B.
    const stored = readProvenanceManifest(d)!
    const gitSays = (sha: string) => (sha === SHA_A ? 'src-' + SHA_A : sha === SHA_B ? 'src-' + SHA_B : null)
    const v = verifySourceShaAgainstGit(stored, gitSays)
    expect(v.ok).toBe(false)
    expect(v.failure).toBe('MANIFEST_FORGED')
    expect(v.detail).toContain(SHA_A)
  })

  it('4b. an honest manifest passes the same cross-check', () => {
    const d = built('dist-honest', SHA_A, CANDIDATE_FILES)
    const stored = readProvenanceManifest(d)!
    const gitSays = (sha: string) => (sha === SHA_A ? 'src-' + SHA_A : null)
    expect(verifySourceShaAgainstGit(stored, gitSays).ok).toBe(true)
  })

  it('4c. a commit git has never heard of is UNRESOLVABLE, not a pass', () => {
    const d = built('dist-ghost', SHA_A, CANDIDATE_FILES)
    const stored = readProvenanceManifest(d)!
    expect(verifySourceShaAgainstGit(stored, () => null).failure).toBe('SOURCE_UNRESOLVABLE')
  })

  it('4d. LEGACY, kept from the first cut of this test', () => {
    const d = built('dist-t', SHA_B, DEVELOP_FILES)
    // Rewrite the manifest to CLAIM the candidate, leaving the bytes alone.
    const mp = join(d, PROVENANCE_FILENAME)
    const m = JSON.parse(readFileSync(mp, 'utf8'))
    m.sourceSha = SHA_A
    writeFileSync(mp, JSON.stringify(m, null, 2))
    // It now claims A and the sha check would pass -- but the dist hash was
    // computed over the real bytes and still matches, so the LIE survives the
    // hash. This is why sourceSha must ALSO be measured against git at build
    // time (build-release-dist.ts), which is asserted separately below.
    const v = verifyRuntimeProvenance(d, SHA_A)
    expect(v.ok).toBe(true)   // documented limit of the manifest alone
    // The defence that does catch it: the manifest is not self-certifying, and
    // the builder verifies the source tree against `git archive` before writing
    // it. Recorded here so the boundary is visible rather than assumed.
    expect(m.sourceTreeHash).toBe('src-' + SHA_B)
    expect(m.sourceTreeHash).not.toBe('src-' + SHA_A)
  })

  it('5. dist content modified AFTER the build', () => {
    const d = built('dist-m', SHA_A, CANDIDATE_FILES)
    expect(verifyRuntimeProvenance(d, SHA_A).ok).toBe(true)
    writeFileSync(join(d, 'cos/source-id.js'), 'export const classify = () => 999 // slipped in\n')
    const v = verifyRuntimeProvenance(d, SHA_A)
    expect(v.ok).toBe(false)
    expect(v.failure).toBe('TAMPERED')
  })

  it('5b. a file ADDED after the build is tampering too, not just an edited one', () => {
    const d = built('dist-add', SHA_A, CANDIDATE_FILES)
    writeFileSync(join(d, 'cos/extra.js'), 'export const x = 1\n')
    expect(verifyRuntimeProvenance(d, SHA_A).failure).toBe('TAMPERED')
  })

  it('5c. a file REMOVED after the build is tampering too', () => {
    const d = built('dist-rm', SHA_A, CANDIDATE_FILES)
    rmSync(join(d, 'cos/source-id.js'))
    expect(verifyRuntimeProvenance(d, SHA_A).failure).toBe('TAMPERED')
  })

  it('6. rollback artifact does not match the declared rollback SHA', () => {
    // The rollback path asks the same question of a preserved artifact.
    const preserved = built('dist.pre-x', SHA_B, DEVELOP_FILES)
    expect(verifyRuntimeProvenance(preserved, SHA_A).failure).toBe('SOURCE_MISMATCH')
    expect(verifyRuntimeProvenance(preserved, SHA_B).ok).toBe(true)
  })

  it('an unreadable manifest is UNREADABLE, not silently absent', () => {
    const d = makeDist('dist-u', CANDIDATE_FILES)
    writeFileSync(join(d, PROVENANCE_FILENAME), '{ not json')
    expect(verifyRuntimeProvenance(d, SHA_A).failure).toBe('UNREADABLE')
  })

  it('a manifest from a future schema is refused, not guessed at', () => {
    const d = built('dist-s', SHA_A, CANDIDATE_FILES)
    const mp = join(d, PROVENANCE_FILENAME)
    const m = JSON.parse(readFileSync(mp, 'utf8')); m.schema = 99
    writeFileSync(mp, JSON.stringify(m, null, 2))
    expect(verifyRuntimeProvenance(d, SHA_A).failure).toBe('SCHEMA')
  })
})

describe('the source digest is a property of the TREE, not of the walk', () => {
  it('the same files in a different directory hash the same', () => {
    const a = join(root, 'r1'); const b = join(root, 'r2')
    for (const d of [a, b]) {
      mkdirSync(join(d, 'src', 'cos'), { recursive: true })
      writeFileSync(join(d, 'src', 'index.ts'), 'export const a = 1\n')
      writeFileSync(join(d, 'src', 'cos', 'x.ts'), 'export const b = 2\n')
      writeFileSync(join(d, 'package.json'), '{"name":"x"}')
      writeFileSync(join(d, 'tsconfig.json'), '{}')
    }
    expect(digestSourceTree(a)).toBe(digestSourceTree(b))
  })

  it('a one-byte source change changes it', () => {
    const a = join(root, 'r3')
    mkdirSync(join(a, 'src'), { recursive: true })
    writeFileSync(join(a, 'src', 'index.ts'), 'export const a = 1\n')
    writeFileSync(join(a, 'package.json'), '{"name":"x"}')
    const before = digestSourceTree(a)
    writeFileSync(join(a, 'src', 'index.ts'), 'export const a = 2\n')
    expect(digestSourceTree(a)).not.toBe(before)
  })

  it('MOVING a file changes it, even though every byte survives', () => {
    const a = join(root, 'r4')
    mkdirSync(join(a, 'src', 'cos'), { recursive: true })
    writeFileSync(join(a, 'src', 'x.ts'), 'export const a = 1\n')
    const before = digestSourceTree(a)
    rmSync(join(a, 'src', 'x.ts'))
    writeFileSync(join(a, 'src', 'cos', 'x.ts'), 'export const a = 1\n')
    expect(digestSourceTree(a)).not.toBe(before)
  })
})
