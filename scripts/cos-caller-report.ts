#!/usr/bin/env npx tsx
/**
 * Every exported COS function, with a count of its callers OUTSIDE the tests.
 *
 * The review's closing methodological note, and the single cheapest thing that
 * would have caught most of tonight's findings: "the proof that a module exists
 * (a file plus a test) was being booked as WIRED IN. Where the count is zero,
 * it is not done, it is a library."
 *
 * That one line describes the claim fence, the quota reservation, the campaign
 * revoke, the marker gate, the browser gate, backup, retention and store
 * permissions — all built, all tested, none called.
 *
 * A REPORT, NOT A LINT. A zero here is a question, not a defect: a fresh
 * capability legitimately has no caller yet, and an escape hatch kept for an
 * incident may never have one. What it must not be is a surprise. Run it and
 * put its output next to the next "done" claim.
 *
 * Deliberately crude — a regex over the source, not a TypeScript program
 * analysis. It over-counts (a name mentioned in a comment) and under-counts
 * (a re-export chain), and being approximately right at zero cost beats being
 * exactly right at a cost nobody pays. Read a zero as "go and look", never as
 * a verdict.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC_ROOTS = ['src', 'scripts']
const TARGET_DIRS = ['src/cos']

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) { walk(full, out); continue }
    if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full)
  }
  return out
}

const allFiles = SRC_ROOTS.flatMap(r => walk(r))
// "Outside the tests" is the whole point: a module's own tests prove it works,
// never that anything uses it.
const nonTest = allFiles.filter(f => !f.includes('__tests__') && !f.endsWith('.test.ts'))

const EXPORT_RE = /^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm

interface Row { file: string; name: string; callers: number; callerFiles: string[] }
const rows: Row[] = []

for (const file of nonTest.filter(f => TARGET_DIRS.some(d => f.startsWith(d)))) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(EXPORT_RE)) {
    const name = m[1]
    const use = new RegExp(`\\b${name}\\b`)
    const callerFiles = nonTest.filter(f => f !== file && use.test(readFileSync(f, 'utf8')))
    rows.push({ file, name, callers: callerFiles.length, callerFiles })
  }
}

const orphans = rows.filter(r => r.callers === 0).sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name))

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ exported: rows.length, orphans: orphans.map(o => ({ file: o.file, name: o.name })) }, null, 1))
} else {
  console.log(`${rows.length} exported COS symbols, ${orphans.length} with no caller outside the tests\n`)
  let last = ''
  for (const o of orphans) {
    if (o.file !== last) { console.log(`  ${o.file}`); last = o.file }
    console.log(`      ${o.name}`)
  }
  console.log('\nA zero is a question, not a defect. Answer it before calling the thing done.')
}
