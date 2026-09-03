// RUNTIME BUILD PROVENANCE -- proving that the code which is RUNNING is the code
// the pin NAMES.
//
// THE DEFECT THIS CLOSES (found 2026-08-31, during the Checkpoint E repin).
// cos-pinned-cutover.sh built the runtime with `npm run build` inside the SHARED
// checkout, which sits on develop. So a clean cutover of a8c22955 produced a dist
// built from develop while the pin declared a8c22955 -- `dist/cos/source-id.js`,
// a file only the candidate has, did not exist. And the guard could not see it:
// run-pinned-cos-cycle.sh sets RUNTIME_SHA by reading `activationCandidateSha`
// OUT OF THE PIN FILE and compares it to the release's `.release-sha`. Both sides
// descend from the same declaration, so "runtime SHA = release SHA" passes over
// whatever dist happens to contain. A readback whose two sides come from the same
// claim is not a readback.
//
// THE RULE, in one line: THE PIN DECLARES, THE ARTIFACT PROVES.
//
// So provenance is produced BY THE BUILD, from the bytes it actually compiled,
// and travels INSIDE the artifact. Verification recomputes it from the deployed
// files. Nothing in this module reads the pin.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export const PROVENANCE_FILENAME = '.build-provenance.json'
export const PROVENANCE_SCHEMA = 2

/** Where the frontend lives INSIDE the built artifact. One name, used by the
 *  builder that puts it there and the runtime that serves it from there. */
export const STATIC_SUBDIR = 'static'

export interface FileDigest { path: string; sha256: string }

export interface BuildProvenance {
  schema: number
  /** The git commit the SOURCE came from. Recorded by the builder from the
   *  artifact it was handed, and checkable against `git archive <sha>`. */
  sourceSha: string
  /** Which release directory produced this, e.g. `cos-cycle-a8c229552`. */
  releaseId: string
  /** Digest over the SOURCE tree that was compiled. This is the link back to
   *  git: recomputing it over `git archive <sourceSha>` must give the same
   *  value, which is what makes `sourceSha` a measurement and not a label. */
  sourceTreeHash: string
  /** Digest over the BUILT tree, excluding this file. Recomputing it over the
   *  deployed dist is what detects a post-build edit. */
  distHash: string
  distFileCount: number
  /** Digest over the STATIC FRONTEND shipped inside the artifact (dist/static).
   *  Separate from distHash so a report can name which half moved, even though
   *  distHash covers these bytes too -- one number that changes tells you
   *  something is wrong, two tell you where. */
  staticTreeHash: string
  staticFileCount: number
  /** The frontend file list with content hashes, as the owner asked for it on
   *  2026-09-03. Kept in full rather than summarised: `coscontrol.js` moving
   *  must be readable off the manifest without recomputing anything. */
  staticFiles: FileDigest[]
  builtAt: string
  /** The builder that produced it, so a hand-made manifest is at least visible. */
  builder: string
}

/** Every file under `dir`, relative-pathed with forward slashes, sorted, each
 *  with its content digest. Sorted because a directory listing's order is not a
 *  property of the tree, and two identical trees must hash identically. */
export function digestTree(dir: string, opts: { exclude?: (rel: string) => boolean } = {}): FileDigest[] {
  const out: FileDigest[] = []
  const walk = (cur: string): void => {
    for (const name of readdirSync(cur).sort()) {
      const abs = join(cur, name)
      const st = statSync(abs)
      // Symlinks are NOT followed into: a release dir symlinks node_modules and
      // store, and hashing those would hash the whole machine.
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) { walk(abs); continue }
      if (!st.isFile()) continue
      const rel = relative(dir, abs).split(sep).join('/')
      if (opts.exclude?.(rel)) continue
      out.push({ path: rel, sha256: createHash('sha256').update(readFileSync(abs)).digest('hex') })
    }
  }
  walk(dir)
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out
}

/** One digest over a file list. The path is hashed with the content, so moving a
 *  file changes the tree hash even when every byte survives. */
export function treeHash(files: FileDigest[]): string {
  const h = createHash('sha256')
  for (const f of files) h.update(f.path).update('\0').update(f.sha256).update('\n')
  return h.digest('hex')
}

const isJsArtifact = (rel: string) => /\.(js|mjs|cjs|json|d\.ts)$/.test(rel)

/** The SOURCE digest: everything the RUNTIME is made of. package.json and
 *  tsconfig.json are included because they change the compiler's output.
 *
 *  `web/` IS SOURCE (owner ruling, 2026-09-03). It used to be left out, and the
 *  omission was not visible anywhere: the backend ran from an immutable pinned
 *  artifact while the frontend it served came from the shared checkout, so the
 *  live page moved every time develop moved and no digest disagreed. Including
 *  it here is what makes a tampered `web/coscontrol.js` in a release directory
 *  fail against `git archive <sha>` -- the same way a tampered `src/` already did. */
export function digestSourceTree(releaseDir: string): string {
  const parts: FileDigest[] = []
  const srcDir = join(releaseDir, 'src')
  if (existsSync(srcDir)) {
    for (const f of digestTree(srcDir)) parts.push({ path: `src/${f.path}`, sha256: f.sha256 })
  }
  const webDir = join(releaseDir, 'web')
  if (existsSync(webDir)) {
    for (const f of digestTree(webDir)) parts.push({ path: `web/${f.path}`, sha256: f.sha256 })
  }
  for (const name of ['package.json', 'tsconfig.json']) {
    const p = join(releaseDir, name)
    if (existsSync(p)) parts.push({ path: name, sha256: createHash('sha256').update(readFileSync(p)).digest('hex') })
  }
  parts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return treeHash(parts)
}

/** The BUILT digest, excluding the provenance file itself -- it cannot contain
 *  its own hash. */
export function digestDistTree(distDir: string): { hash: string; count: number } {
  const files = digestTree(distDir, { exclude: (rel) => rel === PROVENANCE_FILENAME })
    // `static/` is included WHOLESALE, not through the isJsArtifact filter: the
    // frontend is html, css and images as much as it is js, and a filter that
    // covered only the js would leave the page's markup outside the artifact
    // hash while claiming the artifact was covered.
    .filter((f) => isJsArtifact(f.path) || f.path === STATIC_SUBDIR || f.path.startsWith(`${STATIC_SUBDIR}/`))
  return { hash: treeHash(files), count: files.length }
}

/** The frontend's own digest and file list, measured from the built artifact. */
export function digestStaticTree(distDir: string): { hash: string; count: number; files: FileDigest[] } {
  const dir = join(distDir, STATIC_SUBDIR)
  if (!existsSync(dir)) return { hash: '', count: 0, files: [] }
  const files = digestTree(dir).map((f) => ({ path: `${STATIC_SUBDIR}/${f.path}`, sha256: f.sha256 }))
  return { hash: treeHash(files), count: files.length, files }
}

export function writeBuildProvenance(
  distDir: string,
  input: { sourceSha: string; releaseId: string; sourceTreeHash: string; builder: string; now?: Date },
): BuildProvenance {
  const { hash, count } = digestDistTree(distDir)
  const st = digestStaticTree(distDir)
  const p: BuildProvenance = {
    schema: PROVENANCE_SCHEMA,
    sourceSha: input.sourceSha,
    releaseId: input.releaseId,
    sourceTreeHash: input.sourceTreeHash,
    distHash: hash,
    distFileCount: count,
    staticTreeHash: st.hash,
    staticFileCount: st.count,
    staticFiles: st.files,
    builtAt: (input.now ?? new Date()).toISOString(),
    builder: input.builder,
  }
  writeFileSync(join(distDir, PROVENANCE_FILENAME), JSON.stringify(p, null, 2) + '\n')
  return p
}

/**
 * The manifest is not self-certifying, and this is the check that says so.
 *
 * A manifest whose `sourceSha` has been edited to name a different commit still
 * hashes consistently -- the dist digest was computed over the real bytes and
 * those bytes did not change. So `verifyRuntimeProvenance` alone cannot catch a
 * rewritten sourceSha, and pretending otherwise would leave the owner's fourth
 * negative control passing.
 *
 * What catches it is the OTHER digest. `sourceTreeHash` was computed over the
 * source that was compiled; recomputing it from `git archive <sourceSha>` must
 * give the same value. A manifest that claims commit A while carrying commit B's
 * source digest fails, because A's tree does not hash to B's.
 *
 * The resolver is injected so this stays a pure function and can be driven red
 * without a git repository.
 */
export function verifySourceShaAgainstGit(
  m: Pick<BuildProvenance, 'sourceSha' | 'sourceTreeHash'>,
  resolveSourceTreeHash: (sha: string) => string | null,
): ProvenanceVerdict {
  let fromGit: string | null
  try {
    fromGit = resolveSourceTreeHash(m.sourceSha)
  } catch (e) {
    return { ok: false, failure: 'SOURCE_UNRESOLVABLE', detail: `cannot resolve ${m.sourceSha} in git: ${(e as Error).message}` }
  }
  if (fromGit === null) {
    return { ok: false, failure: 'SOURCE_UNRESOLVABLE', detail: `commit ${m.sourceSha} is not in this repository, so the manifest's claim cannot be checked at all` }
  }
  if (fromGit !== m.sourceTreeHash) {
    return {
      ok: false, failure: 'MANIFEST_FORGED',
      detail: `the manifest claims ${m.sourceSha}, but that commit's source hashes to ${fromGit.slice(0, 16)} while the manifest carries ${m.sourceTreeHash.slice(0, 16)}`,
    }
  }
  return { ok: true, detail: `sourceSha ${m.sourceSha.slice(0, 9)} confirmed against git` }
}

export type ProvenanceFailure =
  | 'MISSING'            // no manifest: an artifact that cannot say what it is
  | 'UNREADABLE'         // present and not a manifest
  | 'SCHEMA'             // a manifest this verifier does not understand
  | 'TAMPERED'           // dist no longer hashes to what the build recorded
  | 'SOURCE_MISMATCH'    // the artifact proves a DIFFERENT commit than expected
  | 'MANIFEST_FORGED'    // the manifest's sourceSha does not match its own source digest
  | 'SOURCE_UNRESOLVABLE' // the claimed commit cannot be checked against git at all
  | 'STATIC_MISSING'     // a built artifact that ships no frontend at all
  | 'STATIC_TAMPERED'    // the frontend no longer hashes to what the build recorded

export interface ProvenanceVerdict {
  ok: boolean
  failure?: ProvenanceFailure
  detail: string
  /** MEASURED from the deployed files, never from the pin. */
  measured?: {
    sourceSha: string; distHash: string; distFileCount: number; releaseId: string
    staticTreeHash: string; staticFileCount: number
  }
}

/**
 * Measure the deployed artifact and, when `expectedSha` is given, decide whether
 * it is the one that was meant to be deployed.
 *
 * FAIL CLOSED at every step. A missing manifest is a failure, not a pass with a
 * shrug: an artifact that cannot prove what it is has exactly the property this
 * whole mechanism exists to remove.
 */
/** The manifest as stored, or null. For callers that need to cross-check it. */
export function readProvenanceManifest(distDir: string): BuildProvenance | null {
  const p = join(distDir, PROVENANCE_FILENAME)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) as BuildProvenance } catch { return null }
}

export function verifyRuntimeProvenance(distDir: string, expectedSha?: string): ProvenanceVerdict {
  const manifestPath = join(distDir, PROVENANCE_FILENAME)
  if (!existsSync(manifestPath)) {
    return { ok: false, failure: 'MISSING', detail: `no ${PROVENANCE_FILENAME} in ${distDir}: this artifact cannot say which commit it was built from` }
  }
  let m: BuildProvenance
  try {
    m = JSON.parse(readFileSync(manifestPath, 'utf8')) as BuildProvenance
  } catch (e) {
    return { ok: false, failure: 'UNREADABLE', detail: `${PROVENANCE_FILENAME} is not readable JSON: ${(e as Error).message}` }
  }
  if (m?.schema !== PROVENANCE_SCHEMA || typeof m.sourceSha !== 'string' || typeof m.distHash !== 'string') {
    return { ok: false, failure: 'SCHEMA', detail: `unexpected provenance schema: ${JSON.stringify(m?.schema)}` }
  }

  const { hash, count } = digestDistTree(distDir)
  const st = digestStaticTree(distDir)
  const measured = {
    sourceSha: m.sourceSha, distHash: hash, distFileCount: count, releaseId: m.releaseId,
    staticTreeHash: st.hash, staticFileCount: st.count,
  }

  // THE FRONTEND IS PART OF THE RELEASE, so an artifact without one cannot pass.
  // Checked BEFORE the dist hash, because "there is no frontend" and "the
  // frontend changed" are different sentences and the reader deserves the right
  // one. A manifest that records a frontend over a dist that has none would
  // otherwise surface as a generic TAMPERED and send someone hunting a diff.
  if (m.staticFileCount > 0 && st.count === 0) {
    return {
      ok: false, failure: 'STATIC_MISSING', measured,
      detail: `the manifest records ${m.staticFileCount} frontend files but ${join(distDir, STATIC_SUBDIR)} does not exist: this runtime would serve a frontend from somewhere else`,
    }
  }
  if (st.hash !== m.staticTreeHash) {
    return {
      ok: false, failure: 'STATIC_TAMPERED', measured,
      detail: `the shipped frontend has changed since it was built: recorded ${String(m.staticTreeHash).slice(0, 16)} over ${m.staticFileCount} files, measured ${st.hash.slice(0, 16)} over ${st.count}`,
    }
  }

  // Recomputed FIRST, before the sha comparison: a tampered dist whose manifest
  // still names the right commit would otherwise pass on the strength of the
  // string it carries.
  if (hash !== m.distHash) {
    return {
      ok: false, failure: 'TAMPERED', measured,
      detail: `dist has changed since it was built: recorded ${m.distHash.slice(0, 16)}, measured ${hash.slice(0, 16)} over ${count} files (recorded ${m.distFileCount})`,
    }
  }
  if (expectedSha && m.sourceSha !== expectedSha) {
    return {
      ok: false, failure: 'SOURCE_MISMATCH', measured,
      detail: `deployed artifact was built from ${m.sourceSha}, expected ${expectedSha}`,
    }
  }
  return {
    ok: true, measured,
    detail: `artifact proves ${m.sourceSha} (${count} files, dist ${hash.slice(0, 16)}, frontend ${st.count} files ${st.hash.slice(0, 16)})`,
  }
}
