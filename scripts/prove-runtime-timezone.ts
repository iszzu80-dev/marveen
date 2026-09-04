// THE RUNTIME'S EFFECTIVE TIMEZONE, PROVEN RATHER THAN ASSUMED.
//
// Owner release gate, 2026-09-04: quiet hours are 22:00-07:00 Europe/Budapest,
// therefore the live application timezone may not depend on the host's. Prove
// what it is, where it comes from, that it is explicitly Europe/Budapest, and
// that none of it moves when the host is UTC.
//
// Measured against the PINNED RELEASE by default, because that is what runs.
// Point RUNTIME_DIR elsewhere to prove a different tree.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const RUNTIME = process.env.RUNTIME_DIR ?? '/home/iszzu/marveen/releases/cos-cycle-current'

/** Ask the runtime itself, in a child process, so the answer is ITS resolution
 *  and not this script's. `hostTz` is forced by the caller to prove invariance. */
function ask(hostTz: string): Record<string, unknown> {
  const src = `
    const { APP_TZ, SCHEDULER_TZ_CONFIGURED, APP_TZ_INVALID } = require('${RUNTIME}/src/config.ts')
    // The quiet-hours module may not exist in an OLDER pinned release. That is
    // a different answer from "the boundaries are wrong", and the proof says
    // which -- a gate that crashes cannot distinguish "not shipped yet" from
    // "shipped and broken".
    let R = null
    try { R = require('${RUNTIME}/src/cos/intelligence/reader.ts') } catch { R = null }
    const has = R && typeof R.isWithinQuietHours === 'function'
    const isWithinQuietHours = has ? R.isWithinQuietHours : () => null
    const clockInAppTz = has ? R.clockInAppTz : () => ({ hour: null })
    const QUIET_HOURS_START = has ? R.QUIET_HOURS_START : null
    const QUIET_HOURS_END = has ? R.QUIET_HOURS_END : null
    const at = (iso) => Math.floor(Date.parse(iso) / 1000)
    console.log('@@' + JSON.stringify({
      APP_TZ,
      source: SCHEDULER_TZ_CONFIGURED ? 'SCHEDULER_TZ (explicit)' : 'system-default (host fallback)',
      configured: SCHEDULER_TZ_CONFIGURED ?? null,
      rejected: APP_TZ_INVALID ?? null,
      hostIntl: Intl.DateTimeFormat().resolvedOptions().timeZone,
      quietHoursPresent: has,
      window: [QUIET_HOURS_START, QUIET_HOURS_END],
      // WINTER, CET = UTC+1. 21:59 and 22:00 local.
      winterBefore: isWithinQuietHours(at('2027-01-15T20:59:00Z')),
      winterStart:  isWithinQuietHours(at('2027-01-15T21:00:00Z')),
      winterBeforeEnd: isWithinQuietHours(at('2027-01-16T05:59:00Z')),
      winterEnd:       isWithinQuietHours(at('2027-01-16T06:00:00Z')),
      // SUMMER, CEST = UTC+2. The SAME local hours, one hour earlier in UTC --
      // which only holds if the zone is a real zone and not a fixed offset.
      summerBefore: isWithinQuietHours(at('2027-07-15T19:59:00Z')),
      summerStart:  isWithinQuietHours(at('2027-07-15T20:00:00Z')),
      summerBeforeEnd: isWithinQuietHours(at('2027-07-16T04:59:00Z')),
      summerEnd:       isWithinQuietHours(at('2027-07-16T05:00:00Z')),
      winterClock: clockInAppTz(at('2027-01-15T21:00:00Z')).hour,
      summerClock: clockInAppTz(at('2027-07-15T20:00:00Z')).hour,
    }))
  `
  const out = execFileSync('npx', ['tsx', '-e', src], {
    encoding: 'utf8', env: { ...process.env, TZ: hostTz }, cwd: RUNTIME,
  })
  const line = out.split('\n').find((l) => l.startsWith('@@'))
  if (!line) throw new Error(`no readback from the runtime:\n${out}`)
  return JSON.parse(line.slice(2)) as Record<string, unknown>
}

const checks: Array<[string, boolean, unknown]> = []
const check = (label: string, ok: boolean, detail?: unknown) => checks.push([label, ok, detail])

if (!existsSync(join(RUNTIME, 'src/config.ts'))) {
  console.error(`RUNTIME NOT READABLE: ${RUNTIME}`); process.exit(2)
}
console.log(`runtime: ${RUNTIME}\n`)

for (const hostTz of ['Europe/Budapest', 'UTC', 'America/New_York']) {
  const r = ask(hostTz)
  console.log(`host TZ=${hostTz.padEnd(17)} -> APP_TZ=${r.APP_TZ}  source=${r.source}`
    + (r.quietHoursPresent ? '' : '  [quiet-hours module NOT in this runtime]'))
  check(`[host ${hostTz}] the runtime HAS the quiet-hours module`, r.quietHoursPresent === true,
    r.quietHoursPresent)
  check(`[host ${hostTz}] effective zone is Europe/Budapest`, r.APP_TZ === 'Europe/Budapest', r.APP_TZ)
  check(`[host ${hostTz}] the zone is EXPLICIT, not a host fallback`,
    r.source === 'SCHEDULER_TZ (explicit)', r.source)
  check(`[host ${hostTz}] no rejected zone hiding behind the healthy path`, r.rejected === null, r.rejected)
  check(`[host ${hostTz}] window is 22:00-07:00`,
    Array.isArray(r.window) && (r.window as number[])[0] === 22 && (r.window as number[])[1] === 7, r.window)

  check(`[host ${hostTz}] WINTER 21:59 is not quiet, 22:00 is`,
    r.winterBefore === false && r.winterStart === true, [r.winterBefore, r.winterStart])
  check(`[host ${hostTz}] WINTER 06:59 is quiet, 07:00 is not`,
    r.winterBeforeEnd === true && r.winterEnd === false, [r.winterBeforeEnd, r.winterEnd])
  check(`[host ${hostTz}] SUMMER 21:59 is not quiet, 22:00 is (DST-aware)`,
    r.summerBefore === false && r.summerStart === true, [r.summerBefore, r.summerStart])
  check(`[host ${hostTz}] SUMMER 06:59 is quiet, 07:00 is not (DST-aware)`,
    r.summerBeforeEnd === true && r.summerEnd === false, [r.summerBeforeEnd, r.summerEnd])
  // The DST proof itself: two DIFFERENT UTC instants render as the same local
  // hour. A fixed +01:00 offset would fail this, and a fixed +02:00 would fail
  // the winter pair above.
  check(`[host ${hostTz}] the same local hour from two different UTC instants`,
    r.winterClock === 22 && r.summerClock === 22, [r.winterClock, r.summerClock])
}

const failed = checks.filter(([, ok]) => !ok)
console.log()
for (const [label, ok, detail] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${JSON.stringify(detail)}`}`)
}
console.log(`\nRUNTIME TZ PROOF: ${checks.length - failed.length}/${checks.length} passed`)
if (failed.length) process.exit(1)
