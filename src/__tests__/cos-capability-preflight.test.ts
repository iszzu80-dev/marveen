// §19 / §26(28): capability preflight and WAIT_SYSTEM.
//
// The sentence being defended: **a system fault must not be "Needs István".**
// A dead connector, a missing key, an unreadable table — none of those are
// things the owner can act on, and putting them in front of him spends the
// scarcest resource in the system on nothing. Do it twice and he stops reading.
//
// The audit of 2026-08-13 called this the most misleading of all 31 points, and
// the reason is worth pinning in a test rather than a comment.
// `CAPABILITY_RECOVERED` has been in the §10.8 trigger vocabulary and in the run
// ledger's CHECK constraint since they were written, so a capability audit that
// greps the vocabulary reads "present". Grep `WAIT_SYSTEM` and the answer was
// zero: a doorbell with no door behind it.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { initProgressionSchema } from '../cos/schema.js'
import { createCase } from '../cos/case-store.js'
import { registerConnector, recordFailure, recordSuccess, setMode, DOWN_THRESHOLD, DEGRADED_THRESHOLD } from '../cos/connector-health.js'
import {
  preflight, checkCapabilities, enterWaitSystem, readWaitSystem, clearWaitSystem,
  capabilityRecovered, blocksProgression, CAPABILITY_RETRY_SEC,
} from '../cos/capability-preflight.js'
import { decideTrigger } from '../cos/progression-trigger.js'
import { runProgressionCycle, VALID_DECISIONS } from '../cos/progression-pipeline.js'
import { PROGRESSION_DECISIONS } from '../cos/reader.js'

const T0 = 1_700_000_000
const CASE = 'c1'

function seedCase(): void {
  const db = getDb()
  createCase(db, { caseId: CASE, title: 'Teszt ugy', caseType: 'ADMIN' }, T0)
  db.prepare(
    `INSERT INTO case_progression_state
       (domain, case_id, progression_enabled, progression_mode, last_effective_state, created_at, updated_at)
     VALUES ('personal', ?, 1, 'internal', 'already-reasoned', ?, ?)`,
  ).run(CASE, T0, T0)
}

/** A connector that is registered and healthy. */
function healthyConnector(id = 'gmail'): void {
  registerConnector(getDb(), id, 'EMAIL', 'READ_WRITE', T0)
  recordSuccess(getDb(), id, T0)
}

describe('§19 the preflight itself', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()) })

  it('HEADLINE: declaring nothing changes nothing — the preflight is opt-in per caller', () => {
    // The property that makes this safe to wire into the live engine on the day
    // it is written. A caller that declares no capabilities takes no branch and
    // reads no row, so every existing path behaves exactly as before.
    expect(preflight(getDb(), undefined, T0)).toEqual({ ok: true, results: [] })
    expect(preflight(getDb(), [], T0)).toEqual({ ok: true, results: [] })
  })

  it('a down connector is UNAVAILABLE and retryable', () => {
    healthyConnector()
    for (let i = 0; i < DOWN_THRESHOLD; i++) recordFailure(getDb(), 'gmail', 'boom', T0 + i)
    const v = preflight(getDb(), ['CONNECTOR:gmail'], T0)
    expect(v.ok).toBe(false)
    expect(v.blocker?.state).toBe('UNAVAILABLE')
    expect(v.blocker?.retryable).toBe(true)
  })

  it('a DISABLED connector is UNAVAILABLE and NOT retryable — waiting will not undisable it', () => {
    healthyConnector()
    setMode(getDb(), 'gmail', 'DISABLED', T0)
    const v = preflight(getDb(), ['CONNECTOR:gmail'], T0)
    expect(v.blocker?.retryable).toBe(false)
  })

  it('READ_ONLY blocks a WRITE capability but not a READ one', () => {
    // "Can I read Gmail" and "can I send from Gmail" are different questions.
    // Collapsing them is how a READ_ONLY deployment looks capable of sending
    // right up to the moment it refuses.
    healthyConnector()
    setMode(getDb(), 'gmail', 'READ_ONLY', T0)
    expect(preflight(getDb(), ['CONNECTOR:gmail'], T0).ok).toBe(true)
    expect(preflight(getDb(), ['CONNECTOR_WRITE:gmail'], T0).ok).toBe(false)
  })

  it('DEGRADED does not block — the work can proceed, with a fallback stated', () => {
    healthyConnector()
    for (let i = 0; i < DEGRADED_THRESHOLD; i++) recordFailure(getDb(), 'gmail', 'flaky', T0 + i)
    const [p] = checkCapabilities(getDb(), ['CONNECTOR:gmail'], T0)
    expect(p.state).toBe('DEGRADED')
    expect(blocksProgression(p)).toBe(false)
    expect(p.fallback).toBeTruthy()
  })

  it('HEADLINE: an UNKNOWN capability blocks and is not retryable', () => {
    // The tempting alternative — "unknown, assume fine" — makes a typo in a
    // requirement list silently identical to declaring nothing, which is exactly
    // the failure this file exists to prevent. Not retryable because waiting
    // will not teach the system a name it does not have.
    healthyConnector()
    const v = preflight(getDb(), ['CONNECTOR:gmail', 'TELEPORTER'], T0)
    expect(v.ok).toBe(false)
    expect(v.blocker?.capability).toBe('TELEPORTER')
    expect(v.blocker?.retryable).toBe(false)
    expect(v.blocker?.detail).toMatch(/telepítési hiba/)
  })

  it('an unregistered connector is not the same as a healthy one', () => {
    expect(preflight(getDb(), ['CONNECTOR:nonexistent'], T0).ok).toBe(false)
  })

  it('reports the FIRST blocker, in the order the caller listed them', () => {
    healthyConnector()
    setMode(getDb(), 'gmail', 'DISABLED', T0)
    const v = preflight(getDb(), ['CONNECTOR:gmail', 'TELEPORTER'], T0)
    expect(v.blocker?.capability).toBe('CONNECTOR:gmail')
    expect(v.results).toHaveLength(2)
  })
})

describe('§19 the WAIT_SYSTEM state', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()); seedCase() })

  it('parks the case with a retry time, and reads back what it is waiting on', () => {
    const [p] = checkCapabilities(getDb(), ['TELEPORTER'], T0)
    enterWaitSystem(getDb(), 'personal', CASE, { ...p, retryable: true }, T0)
    const w = readWaitSystem(getDb(), 'personal', CASE)
    expect(w?.capability).toBe('TELEPORTER')
    expect(w?.retryAt).toBe(T0 + CAPABILITY_RETRY_SEC)
    const row = getDb().prepare(
      `SELECT next_progression_at FROM case_progression_state WHERE domain='personal' AND case_id=?`,
    ).get(CASE) as { next_progression_at: number | null }
    expect(row.next_progression_at).toBe(T0 + CAPABILITY_RETRY_SEC)
  })

  it('a NON-retryable blocker gets no retry time — the sweep budget is real', () => {
    // Re-checking a disabled connector every fifteen minutes burns a slot in a
    // bounded sweep on a state only a person can change.
    const [p] = checkCapabilities(getDb(), ['TELEPORTER'], T0)
    enterWaitSystem(getDb(), 'personal', CASE, p, T0)
    const row = getDb().prepare(
      `SELECT next_progression_at FROM case_progression_state WHERE domain='personal' AND case_id=?`,
    ).get(CASE) as { next_progression_at: number | null }
    expect(row.next_progression_at).toBeNull()
  })

  it('HEADLINE: parking does NOT touch the case status — the board stays clean', () => {
    // A case blocked on a dead connector is not BLOCKED in the owner-facing
    // sense. Moving it there would put a machine fault on the board he reads,
    // which is the exact thing §19 forbids, one layer over.
    const before = getDb().prepare(`SELECT status FROM personal_cases WHERE case_id=?`).get(CASE)
    const [p] = checkCapabilities(getDb(), ['TELEPORTER'], T0)
    enterWaitSystem(getDb(), 'personal', CASE, p, T0)
    expect(getDb().prepare(`SELECT status FROM personal_cases WHERE case_id=?`).get(CASE)).toEqual(before)
  })

  it('clearing says whether there was anything to clear', () => {
    expect(clearWaitSystem(getDb(), 'personal', CASE, T0)).toBe(false)
    const [p] = checkCapabilities(getDb(), ['TELEPORTER'], T0)
    enterWaitSystem(getDb(), 'personal', CASE, p, T0)
    expect(clearWaitSystem(getDb(), 'personal', CASE, T0 + 1)).toBe(true)
    expect(readWaitSystem(getDb(), 'personal', CASE)).toBeNull()
  })
})

describe('§19 the recovery trigger is deterministic', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()); seedCase() })

  function park(): void {
    healthyConnector()
    for (let i = 0; i < DOWN_THRESHOLD; i++) recordFailure(getDb(), 'gmail', 'boom', T0 + i)
    const v = preflight(getDb(), ['CONNECTOR:gmail'], T0)
    enterWaitSystem(getDb(), 'personal', CASE, v.blocker!, T0)
  }

  it('HEADLINE: a parked case does not wake until the SAME capability is back', () => {
    park()
    expect(capabilityRecovered(getDb(), 'personal', CASE, T0 + 10_000).recovered).toBe(false)
    expect(decideTrigger(getDb(), 'personal', CASE, T0 + 10_000).shouldRun).toBe(false)

    // The connector comes back.
    recordSuccess(getDb(), 'gmail', T0 + 20_000)
    const rec = capabilityRecovered(getDb(), 'personal', CASE, T0 + 20_000)
    expect(rec.recovered).toBe(true)
    const t = decideTrigger(getDb(), 'personal', CASE, T0 + 20_000)
    expect(t.shouldRun).toBe(true)
    expect(t.trigger).toBe('CAPABILITY_RECOVERED')
  })

  it('HEADLINE: an overdue deadline does NOT pull a parked case out', () => {
    // Without this ordering, every sweep for the whole outage would wake the
    // case, run the preflight, and re-park it — once per case per sweep, for as
    // long as the connector is down.
    park()
    getDb().prepare(`UPDATE personal_cases SET follow_up_at = ? WHERE case_id = ?`).run(T0 - 100, CASE)
    const t = decideTrigger(getDb(), 'personal', CASE, T0 + 10_000)
    expect(t.shouldRun).toBe(false)
    expect(t.reason).toMatch(/capability/)
  })

  it('the wait does not survive the capability, and does not depend on the clock', () => {
    // Deterministic, as §19 requires: the answer is a function of the probe, not
    // of how long we have been waiting. Reproducible on a replay corpus.
    park()
    const late = capabilityRecovered(getDb(), 'personal', CASE, T0 + 999_999)
    expect(late.recovered).toBe(false)
  })

  it('a case with no wait is unaffected by any of this', () => {
    expect(capabilityRecovered(getDb(), 'personal', CASE, T0).recovered).toBe(false)
    // ...and whatever the ordinary rules decide, they decide it for their own
    // reasons. The capability branch must be invisible to a case that has none.
    expect(decideTrigger(getDb(), 'personal', CASE, T0).reason).not.toMatch(/capability/)
  })
})

describe('§19 the cycle parks instead of asking the owner', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()); seedCase() })

  it('HEADLINE: a capability failure yields WAIT_SYSTEM, not an owner-facing decision', () => {
    const r = runProgressionCycle(getDb(), 'personal', CASE, T0, {
      triggerType: 'MANUAL_REVIEW_REQUEST',
      requiredCapabilities: ['CONNECTOR:gmail'],
    })
    expect(r.decision).toBe('WAIT_SYSTEM')
    // Every other terminal decision either advances the case or asks him
    // something. This one does neither, which is the point.
    expect(['ASK_INFORMATION', 'REQUEST_DECISION', 'REQUEST_APPROVAL', 'MANUAL_ACTION_REQUIRED', 'CALL_REQUIRED'])
      .not.toContain(r.decision)
  })

  it('the run is COMPLETED, not FAILED — the engine did its job', () => {
    // FAILED would put a system outage in the same bucket as an engine defect,
    // and the reconcile's cycleErrors — which exists to find engine defects —
    // would fill up with weather.
    const r = runProgressionCycle(getDb(), 'personal', CASE, T0, {
      requiredCapabilities: ['CONNECTOR:gmail'],
    })
    expect(r.status).toBe('COMPLETED')
    expect(r.errorCode).toBeNull()
    const row = getDb().prepare(
      `SELECT status, decision FROM case_progression_runs WHERE progression_run_id = ?`,
    ).get(r.runId) as { status: string; decision: string }
    expect(row).toEqual({ status: 'COMPLETED', decision: 'WAIT_SYSTEM' })
  })

  it('and the case is parked, so the next sweep does not re-reason it', () => {
    runProgressionCycle(getDb(), 'personal', CASE, T0, { requiredCapabilities: ['CONNECTOR:gmail'] })
    expect(readWaitSystem(getDb(), 'personal', CASE)?.capability).toBe('CONNECTOR:gmail')
    expect(decideTrigger(getDb(), 'personal', CASE, T0 + 10_000).shouldRun).toBe(false)
  })

  it('a healthy capability leaves the cycle exactly as it was', () => {
    healthyConnector()
    const withReq = runProgressionCycle(getDb(), 'personal', CASE, T0, {
      requiredCapabilities: ['CONNECTOR:gmail'],
    })
    expect(withReq.decision).not.toBe('WAIT_SYSTEM')
  })

  it('running with the capability restored clears the wait', () => {
    runProgressionCycle(getDb(), 'personal', CASE, T0, { requiredCapabilities: ['CONNECTOR:gmail'] })
    expect(readWaitSystem(getDb(), 'personal', CASE)).not.toBeNull()
    healthyConnector()
    runProgressionCycle(getDb(), 'personal', CASE, T0 + 1000, { requiredCapabilities: ['CONNECTOR:gmail'] })
    expect(readWaitSystem(getDb(), 'personal', CASE)).toBeNull()
  })
})

describe('STANDING CHECK: WAIT_SYSTEM is engine-only', () => {
  it('the Reader may not propose it', () => {
    // A Reader that could offer WAIT_SYSTEM could excuse itself from a case by
    // asserting a fault, and nothing downstream would check. So the two lists
    // are deliberately different, and this is the assertion that keeps them so:
    // the Reader's vocabulary must be a STRICT SUBSET of the engine's.
    expect(PROGRESSION_DECISIONS as readonly string[]).not.toContain('WAIT_SYSTEM')
    expect(VALID_DECISIONS as readonly string[]).toContain('WAIT_SYSTEM')
    const extra = (PROGRESSION_DECISIONS as readonly string[])
      .filter(d => !(VALID_DECISIONS as readonly string[]).includes(d))
    expect(extra).toEqual([])
  })

  it('nothing outside the preflight and the pipeline writes the decision', () => {
    // The other half a type cannot enforce. If a third module starts writing
    // WAIT_SYSTEM, this fails and somebody has to defend the addition — the same
    // shape as the gate-permit minting check.
    const REPO = process.cwd()
    const allowed = new Set([
      'src/cos/capability-preflight.ts',
      'src/cos/progression-pipeline.ts',
      'src/cos/progression-trigger.ts',
    ])
    const offenders = ['src/cos', 'src/web', 'scripts']
      .flatMap(root => walk(join(REPO, root), REPO))
      .filter(f => !allowed.has(f))
      .filter(f => /['"`]WAIT_SYSTEM['"`]/.test(readFileSync(join(REPO, f), 'utf8')))
      .sort()
    expect(offenders).toEqual([])
  })
})

/** Production `.ts` files under a directory, repo-relative. */
function walk(dir: string, repo: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue
      out.push(...walk(full, repo))
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      out.push(full.slice(repo.length + 1).replace(/\\/g, '/'))
    }
  }
  return out
}
