/**
 * The transitive import closure of a set of modules — shared, because two
 * boundaries now need it and a second copy is how the first one's fixes stop
 * reaching the second.
 *
 * Extracted from proactive-core-import-boundary.test.ts (2026-08-15) when the
 * SERVICE_QUOTE guard needed the same reasoning. The original guard there read
 * the whole file as TEXT, which is both too weak and too strong:
 *
 *   too strong  a COMMENT saying "this module never calls enqueueOutbox" made
 *               the guard fail — a true sentence about the code breaking the
 *               check on the code;
 *   too weak    a helper that sends, imported by the module, passed — the
 *               capability was one hop away and invisible.
 *
 * Reading the IMPORT LIST, transitively, fixes both: prose cannot trip it, and
 * a hop cannot hide from it.
 *
 * WHY A SOURCE-LEVEL CHECK IS LEGITIMATE HERE, when this codebase's standing
 * rule is to prove behaviour by driving it: the claim is an ABSENCE — "this
 * module cannot reach the outside world". An absence cannot be demonstrated by
 * running the code, because no run proves the path nobody took does not exist.
 * Where there IS a behavioural alternative, use it; here there is none.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'

export const REPO = process.cwd()

/** Comments removed, so PROSE about a forbidden name cannot trip a check that
 *  is supposed to be about code. */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !/^\s*(\/\/|\*)/.test(l))
    .join('\n')
}

/** The module specifiers a file imports, static and dynamic alike.
 *
 *  Dynamic `import()` and `require()` are included deliberately: they are the
 *  obvious way to acquire a forbidden dependency while keeping the static
 *  import list clean, and a boundary check that only reads the top of the file
 *  is a boundary check with a published bypass. */
export function importSpecifiers(file: string): string[] {
  const src = stripComments(readFileSync(join(REPO, file), 'utf8'))
  const out: string[] = []
  const patterns = [
    /\bimport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bexport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
  ]
  for (const re of patterns) {
    for (const m of src.matchAll(re)) out.push(m[1]!)
  }
  return out
}

/** Resolve a relative specifier to a repo-relative `.ts` path, or null when it
 *  is a package (judged by name instead). */
export function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const abs = resolve(join(REPO, dirname(fromFile)), spec)
  for (const cand of [abs.replace(/\.js$/, '.ts'), `${abs}.ts`, join(abs, 'index.ts')]) {
    if (existsSync(cand)) return relative(REPO, cand).replace(/\\/g, '/')
  }
  return null
}

/** Every production `.ts` under a root, recursively, tests excluded. */
export function sources(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(join(REPO, dir))) return
    for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) walk(rel)
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(rel)
    }
  }
  walk(root)
  return out
}

export interface Closure {
  /** Repo-relative local modules reachable from the entries, entries included. */
  files: Set<string>
  /** External package name -> the file that first pulled it in. */
  packages: Map<string, string>
}

/** The transitive closure of local modules reachable from `entries`, plus every
 *  external package anything in that closure imports. */
export function importClosure(entries: string[]): Closure {
  const files = new Set<string>()
  const packages = new Map<string, string>()
  const queue = [...entries]
  for (const f of queue) files.add(f)
  while (queue.length) {
    const file = queue.shift()!
    for (const spec of importSpecifiers(file)) {
      const local = resolveLocal(file, spec)
      if (local) {
        if (!files.has(local)) { files.add(local); queue.push(local) }
      } else if (!packages.has(spec)) {
        packages.set(spec, file)
      }
    }
  }
  return { files, packages }
}
