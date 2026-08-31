#!/usr/bin/env npx tsx
/**
 * Roll the runtime back to a PRESERVED, PROVEN artifact. It never rebuilds.
 *
 * A rollback that rebuilds is not a rollback: it produces a NEW artifact from
 * whatever the checkout is on today and calls it yesterday's runtime. That is
 * the same defect the forward path had, and it matters more here -- a rollback
 * runs when something is already wrong, which is the worst moment to introduce
 * a build nobody has seen.
 *
 * So this installs bytes that already exist and already carry provenance, and
 * refuses anything it cannot verify.
 *
 * Usage:
 *   npx tsx scripts/cos-rollback-runtime.ts <sha> [--dry-run]
 *   npx tsx scripts/cos-rollback-runtime.ts <sha> --accept-unproven-legacy "<reason>"
 *
 * The legacy escape exists because artifacts built before provenance carry none,
 * and refusing every one of them would leave no rollback at all on the night this
 * shipped. It is deliberately awkward: it demands a written reason, and the reason
 * is stamped into the pin so the exception is visible for as long as it is in force.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { verifyRuntimeProvenance } from '../src/release/provenance.js'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const legacyIdx = argv.indexOf('--accept-unproven-legacy')
const legacyReason = legacyIdx >= 0 ? argv[legacyIdx + 1] : undefined
const REPO = process.env.MARVEEN_REPO_ROOT || join(homedir(), 'marveen')
const target = argv[0]

const die = (m: string): never => { console.error(`ROLLBACK REFUSED: ${m}`); process.exit(95) }
const say = (m: string) => console.log(`  ${m}`)

if (!target || target.startsWith('--')) die('no target sha given')
let sha = ''
try {
  sha = execFileSync('git', ['-C', REPO, 'rev-parse', '--verify', `${target}^{commit}`], { encoding: 'utf8' }).trim()
} catch { die(`not a commit: ${target}`) }
const short = sha.slice(0, 9)
console.log(`rollback target ${short}${DRY ? ' (DRY RUN)' : ''}`)

// ── find every preserved artifact that could BE this sha ────────────────────
const candidates: string[] = []
const releaseDist = join(REPO, 'releases', `cos-cycle-${short}`, 'dist')
if (existsSync(releaseDist)) candidates.push(releaseDist)
for (const name of readdirSync(REPO).sort().reverse()) {
  if (name.startsWith(`dist.pre-${short}-`)) candidates.push(join(REPO, name))
}
if (!candidates.length) die(`no preserved artifact for ${short}: nothing to roll back TO. Look for releases/cos-cycle-${short}/dist or dist.pre-${short}-*`)

say(`preserved artifacts found: ${candidates.length}`)
let chosen: string | null = null
let unproven: Array<{ dir: string; why: string }> = []
for (const dir of candidates) {
  const v = verifyRuntimeProvenance(dir, sha)
  if (v.ok) { chosen = dir; say(`PROVEN: ${dir} -- ${v.detail}`); break }
  unproven.push({ dir, why: `${v.failure}: ${v.detail}` })
  say(`unproven: ${dir} -- ${v.failure}`)
}

if (!chosen) {
  if (!legacyReason) {
    die(`no artifact PROVES ${short}. Every candidate failed:\n` +
        unproven.map((u) => `    ${u.dir}\n      ${u.why}`).join('\n') +
        `\n  Artifacts built before build provenance existed carry none. If this is one of\n` +
        `  those and you have another reason to trust it, re-run with\n` +
        `  --accept-unproven-legacy "<why you trust these bytes>"`)
  }
  chosen = candidates[0]
  say(`LEGACY EXCEPTION accepted for ${chosen}`)
  say(`reason: ${legacyReason}`)
}

if (DRY) { console.log(`dry run: would install ${chosen} as ${REPO}/dist and repin to ${short}`); process.exit(0) }

// keep what is being replaced, with whatever provenance it has
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
const cur = join(REPO, 'dist')
if (existsSync(cur)) {
  const curV = verifyRuntimeProvenance(cur)
  const curSha = curV.measured?.sourceSha?.slice(0, 9) ?? 'unproven'
  cpSync(cur, join(REPO, `dist.pre-${curSha}-${stamp}`), { recursive: true })
  say(`current runtime preserved as dist.pre-${curSha}-${stamp}`)
}
rmSync(cur, { recursive: true, force: true })
cpSync(chosen, cur, { recursive: true })
say(`installed ${chosen}`)

// Verify the DEPLOYED copy, not the source of the copy.
const after = verifyRuntimeProvenance(cur, legacyReason ? undefined : sha)
if (!after.ok) die(`the installed runtime does not verify: ${after.failure} -- ${after.detail}`)
say(`deployed runtime verified: ${after.detail}`)

const pinPath = join(REPO, 'releases', 'dashboard-runtime-pin.json')
const pin = JSON.parse(readFileSync(pinPath, 'utf8')) as Record<string, unknown>
pin.previousActivationCandidateSha = pin.activationCandidateSha
pin.activationCandidateSha = sha
pin.gateSha = sha
pin.deployedAt = new Date().toISOString()
pin.runtimeBuildProvenance = legacyReason
  ? `ROLLBACK to ${short} from ${chosen} under an ACCEPTED LEGACY EXCEPTION -- the artifact carries no build provenance. Reason given: ${legacyReason}`
  : `ROLLBACK to ${short} from ${chosen}, provenance-verified in place after install: ${after.detail}`
writeFileSync(pinPath, JSON.stringify(pin, null, 1) + '\n')
say('pin updated')
console.log('ROLLBACK STAGED. Restart the runtime, then re-measure with verify-runtime-provenance.ts --expect-from-pin')
