import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  digestSourceTree, digestDistTree, digestStaticTree, writeBuildProvenance,
  verifyRuntimeProvenance, STATIC_SUBDIR,
} from '../release/provenance.js'
import { resolveWebDir } from '../config.js'

// THE FRONTEND IS PART OF THE RELEASE ARTIFACT (owner ruling, 2026-09-03).
//
// The defect these tests fence: on 2026-09-03 the 560ed6f5f cutover installed a
// provenance-verified BACKEND while the page it served still came out of the
// shared checkout on develop -- so a release could be "proven" and still show a
// UI nobody had released. No digest disagreed, because no digest covered the
// frontend at all.
//
// The owner's negative controls, each its own test because a control that only
// lives inside another test's setup is a control nobody has watched fail.

const SHA = '560ed6f5fec2c5050e67c6202a76c0483c49ab8e'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'relfe-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** A release directory shaped like the one `git archive` produces. */
function makeReleaseDir(opts: { withWeb?: boolean; coscontrol?: string } = {}): string {
  const dir = join(root, 'release')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1\n')
  writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n')
  writeFileSync(join(dir, 'tsconfig.json'), '{}\n')
  if (opts.withWeb !== false) {
    mkdirSync(join(dir, 'web'), { recursive: true })
    writeFileSync(join(dir, 'web', 'index.html'), '<html></html>\n')
    writeFileSync(join(dir, 'web', 'coscontrol.js'), opts.coscontrol ?? 'export const gate = "NOT_EVALUATED"\n')
  }
  return dir
}

/** A built artifact: compiled js plus the frontend copied in, as the builder does. */
function makeDist(opts: { withStatic?: boolean; coscontrol?: string } = {}): string {
  const dist = join(root, 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.js'), 'export const x = 1\n')
  if (opts.withStatic !== false) {
    mkdirSync(join(dist, STATIC_SUBDIR), { recursive: true })
    writeFileSync(join(dist, STATIC_SUBDIR, 'index.html'), '<html></html>\n')
    writeFileSync(join(dist, STATIC_SUBDIR, 'coscontrol.js'), opts.coscontrol ?? 'export const gate = "NOT_EVALUATED"\n')
  }
  return dist
}

describe('the frontend is part of the release identity', () => {
  it('B: tampering with the release dir\'s web/coscontrol.js moves the SOURCE digest', () => {
    // The source digest is what gets cross-checked against `git archive <sha>`.
    // Before this change web/ was outside it, so a hand-edited frontend in a
    // release directory verified clean.
    const clean = digestSourceTree(makeReleaseDir())
    rmSync(join(root, 'release'), { recursive: true, force: true })
    const tampered = digestSourceTree(makeReleaseDir({ coscontrol: 'window.alert("mine now")\n' }))
    expect(tampered).not.toBe(clean)
  })

  it('C: a candidate with no web/ hashes differently from one with it, so the absence cannot pass as equal', () => {
    const withWeb = digestSourceTree(makeReleaseDir())
    rmSync(join(root, 'release'), { recursive: true, force: true })
    const without = digestSourceTree(makeReleaseDir({ withWeb: false }))
    expect(without).not.toBe(withWeb)
  })

  it('F: the served frontend is inside the artifact hash, file by file', () => {
    const dist = makeDist()
    const st = digestStaticTree(dist)
    expect(st.count).toBe(2)
    expect(st.files.map(f => f.path).sort()).toEqual(['static/coscontrol.js', 'static/index.html'])
    // and the dist digest covers them too -- not only the .js files it used to
    const covered = digestDistTree(dist).count
    expect(covered).toBeGreaterThanOrEqual(3)
  })

  it('D: a frontend swapped under a built artifact is refused (STATIC_TAMPERED)', () => {
    const dist = makeDist()
    writeBuildProvenance(dist, { sourceSha: SHA, releaseId: 'cos-cycle-test', sourceTreeHash: 'st', builder: 'test' })
    expect(verifyRuntimeProvenance(dist, SHA).ok).toBe(true)

    // Backend A, frontend B: only the page is replaced.
    writeFileSync(join(dist, STATIC_SUBDIR, 'coscontrol.js'), 'export const gate = "PASS"\n')
    const v = verifyRuntimeProvenance(dist, SHA)
    expect(v.ok).toBe(false)
    expect(v.failure).toBe('STATIC_TAMPERED')
  })

  it('an artifact whose frontend has been deleted is refused (STATIC_MISSING), not reported as a diff', () => {
    const dist = makeDist()
    writeBuildProvenance(dist, { sourceSha: SHA, releaseId: 'cos-cycle-test', sourceTreeHash: 'st', builder: 'test' })
    rmSync(join(dist, STATIC_SUBDIR), { recursive: true, force: true })
    const v = verifyRuntimeProvenance(dist, SHA)
    expect(v.ok).toBe(false)
    expect(v.failure).toBe('STATIC_MISSING')
    expect(v.detail).toMatch(/serve a frontend from somewhere else/)
  })

  it('the manifest carries the frontend file list with content hashes, coscontrol.js included', () => {
    const dist = makeDist()
    const p = writeBuildProvenance(dist, { sourceSha: SHA, releaseId: 'cos-cycle-test', sourceTreeHash: 'st', builder: 'test' })
    expect(p.staticFileCount).toBe(2)
    expect(p.staticTreeHash).not.toBe('')
    const cos = p.staticFiles.find(f => f.path === 'static/coscontrol.js')
    expect(cos?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('resolveWebDir names WHICH half it got, and running from source says checkout out loud', () => {
    // In the suite this module runs from src/, which has no static/ beside it.
    // The value of the assertion is the SOURCE field: a caller can no longer be
    // handed a directory without being told where it came from.
    const r = resolveWebDir()
    expect(r.source).toBe('checkout')
    expect(r.reason).toMatch(/working tree|MUTABLE checkout/)
    expect(r.dir.endsWith('/web')).toBe(true)
  })
})
