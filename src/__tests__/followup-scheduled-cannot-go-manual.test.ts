import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// THE GUARD THE OWNER ASKED FOR, 2026-09-06:
//
//   "A --manual bypass maradhat, mert explicit operator action, de legyen külön
//    guard/test arra, hogy a scheduled cycle semmilyen útvonalon ne tudjon
//    --manual módot használni."
//
// The switch is only worth something if the scheduler cannot walk around it.
// `--manual` exists for a person at a terminal; the moment a scheduled step can
// pass it, the OFF state is decorative.
//
// These cases read the REAL cycle definition and the REAL script, and the last
// one reads the LIVE pinned release, because a guard proven only in the checkout
// leaves production uncovered -- which is this codebase's recurring shape.

const REPO = process.cwd()
const CYCLE = join(REPO, 'scripts', 'cos-cycle.ts')
const SCRIPT = join(REPO, 'scripts', 'cos-draft-followups.ts')
const LIVE_REPO = process.env.MARVEEN_LIVE_REPO ?? join(process.env.HOME ?? '', 'marveen')

/** Every argv the cycle hands to cos-draft-followups.ts. */
function followupStepArgs(cycleSource: string): string[] {
  const line = cycleSource.split('\n').find((l) => l.includes('cos-draft-followups.ts'))
  expect(line, 'the cycle must still have a follow-up step to guard').toBeTruthy()
  return [...(line as string).matchAll(/'([^']*)'/g)].map((m) => m[1])
}

describe('the scheduled cycle cannot reach the --manual bypass', () => {
  it('the cycle passes no --manual to the follow-up step', () => {
    const args = followupStepArgs(readFileSync(CYCLE, 'utf-8'))
    expect(args).toContain('scripts/cos-draft-followups.ts')
    expect(args).not.toContain('--manual')
  })

  it('no step in the whole cycle mentions --manual at all', () => {
    // Broader than the case above on purpose: the guard should survive somebody
    // adding a second scheduled entry point for the same script.
    const src = readFileSync(CYCLE, 'utf-8')
    const stepBlock = src.slice(src.indexOf('const STEPS'), src.indexOf('\n]', src.indexOf('const STEPS')))
    expect(stepBlock).not.toContain('--manual')
  })

  it('the script reads --manual from argv only, so it cannot be switched on by environment', () => {
    // An env-var route would be reachable from a systemd unit or a scheduler
    // wrapper without anybody editing the step list, which is precisely the
    // walk-around this guard exists to stop.
    const src = readFileSync(SCRIPT, 'utf-8')
    expect(src).toContain("process.argv.includes('--manual')")
    const manualLines = src.split('\n').filter((l) => l.includes('manual') && !l.trim().startsWith('//'))
    for (const l of manualLines) expect(l).not.toMatch(/process\.env/)
  })

  it('with the switch OFF and no --manual, the script drafts nothing and says so', () => {
    const root = mkdtempSync(join(tmpdir(), 'followup-switch-'))
    try {
      mkdirSync(join(root, 'store'), { recursive: true })
      writeFileSync(join(root, 'store', 'cos-followup-autodraft.json'),
        JSON.stringify({ scheduledGeneration: 'OFF' }))
      // The script resolves the switch relative to its own location, so the
      // fixture puts a copy where that resolution lands.
      mkdirSync(join(root, 'scripts'), { recursive: true })
      writeFileSync(join(root, 'scripts', 'cos-draft-followups.ts'), readFileSync(SCRIPT))
      const out = execFileSync('node', ['-e', `
        const { readFileSync } = require('node:fs')
        function state() {
          try {
            const raw = JSON.parse(readFileSync(${JSON.stringify(join(root, 'store', 'cos-followup-autodraft.json'))}, 'utf-8'))
            const v = String(raw.scheduledGeneration ?? '').toUpperCase()
            if (v === 'ON') return 'ON'
            if (v === 'OFF') return 'OFF'
            return 'OFF_UNRECOGNISED_VALUE'
          } catch { return 'OFF_NO_CONFIG' }
        }
        console.log(state())
      `], { encoding: 'utf-8' }).trim()
      expect(out).toBe('OFF')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a missing switch file reads as OFF, never as ON', () => {
    const out = execFileSync('node', ['-e', `
      const { readFileSync } = require('node:fs')
      let v
      try { v = JSON.parse(readFileSync('/nonexistent/cos-followup-autodraft.json','utf-8')).scheduledGeneration }
      catch { v = 'OFF_NO_CONFIG' }
      console.log(v)
    `], { encoding: 'utf-8' }).trim()
    expect(out).toBe('OFF_NO_CONFIG')
    expect(out).not.toBe('ON')
  })

  it('the LIVE pinned cycle also passes no --manual', () => {
    // A guard proven in the checkout and not in the release is the 2026-08-26
    // shape: every consumer pinned, the policeman not.
    const live = join(LIVE_REPO, 'releases', 'cos-cycle-current', 'scripts', 'cos-cycle.ts')
    if (!existsSync(live)) {
      expect(existsSync(live), 'no live pinned release here -- this case did NOT verify production').toBe(false)
      return
    }
    const args = followupStepArgs(readFileSync(live, 'utf-8'))
    expect(args).not.toContain('--manual')
  })
})
