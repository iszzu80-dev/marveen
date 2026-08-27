// The cycle's READER, tested directly for the first time.
//
// Until 2026-08-27 this normaliser lived inside scripts/cos-cycle.ts, which
// spawns thirteen child processes on import -- so no test could reach it, and
// the only way to see it misbehave was to read a live heartbeat report. It
// misbehaved for three days: `recoveryQueue` came back UNKNOWN on every single
// pinned cycle from the 2026-08-24 cutover onward, and the reason was here,
// not in the step.
//
// The distinction these tests defend is the release invariant: UNKNOWN means
// "this step cannot say what it did". It must never be produced for a step that
// CAN say, and a step that says nothing must never be flattened into a
// confident zero.
import { describe, it, expect } from 'vitest'
import { cppResult } from '../cos/cycle-cpp.js'
import { deriveRunStatus } from '../cos/consumer-manifest.js'
import { recoveryStepPayload } from '../cos/recovery-queue-report.js'

/** What the cycle does with the result: the outcome only matters through this. */
const status = (payload: Record<string, unknown> | null) =>
  deriveRunStatus(cppResult('step', payload, null), 'NOT_APPLICABLE')

describe('CPP normaliser — UNKNOWN means the STEP cannot speak', () => {
  it('a payload with no counters at all is UNKNOWN, not a zero', () => {
    // The invariant, stated first: absence of evidence is not evidence of zero.
    const r = cppResult('mystery', { ok: true, note: 'done' }, null)
    expect(r.outcome).toBe('UNKNOWN')
    expect(status({ ok: true, note: 'done' })).toBe('UNKNOWN')
  })

  it('HEADLINE: the recoveryQueue payload as it was, and as it is now', () => {
    // EXACTLY what the live cycle printed on 2026-08-27 03:10 and 03:20. Four
    // status counts, no statement of what was looked at -- and the normaliser
    // was right to refuse to guess.
    const before = { enqueued: 0, resolved: 0, needsHuman: 0, pendingRetry: 0, needsHumanRows: [] }
    expect(cppResult('recoveryQueue', before, null).outcome).toBe('UNKNOWN')

    // The fix is that the step now says what it inspected. Note the counters
    // are REAL zeros here: an empty queue on a healthy store. The difference
    // between this and the line above is not the numbers, it is that these were
    // measured.
    const after = {
      enqueued: 0, resolved: 0, needsHuman: 0, pendingRetry: 0,
      examined: 0, inRecovery: 0, reChecked: 0, surfacesScanned: 3,
      matched: 0, acted: 0, needsHumanRows: [],
    }
    const r = cppResult('recoveryQueue', after, null)
    expect(r.outcome).not.toBe('UNKNOWN')
    expect(r.examined).toBe(0)
    expect(status(after)).toBe('SUCCESS')
  })

  it('a reconcile that scanned NO surfaces is a failure, not a quiet zero', () => {
    // The step reports failed:true itself, because examined:0 with
    // surfacesScanned:0 means "never looked" -- and that must not be able to
    // exit clean. Every row counter below is identical to the healthy case
    // above; only the witness differs.
    const p = {
      enqueued: 0, resolved: 0, needsHuman: 0, pendingRetry: 0,
      examined: 0, inRecovery: 0, reChecked: 0, surfacesScanned: 0,
      failed: true, error: 'recovery reconcile scanned ZERO source surfaces -- it did not run.',
    }
    expect(cppResult('recoveryQueue', p, null).outcome).toBe('FAILED')
    expect(status(p)).toBe('FAILED')
  })

  it('a busy recoveryQueue run reports the work it did', () => {
    const r = cppResult('recoveryQueue', {
      enqueued: 2, resolved: 1, needsHuman: 1, pendingRetry: 3,
      examined: 7, inRecovery: 4, reChecked: 3, matched: 4, acted: 3, needsHumanRows: [],
    }, null)
    expect(r.examined).toBe(7)
    expect(r.matched).toBe(4)
    expect(r.acted).toBe(3)     // enqueued + resolved: writes, not status counts
    expect(r.outcome).toBe('ACTED')
  })

  it('status counts alone must NOT be mistaken for action', () => {
    // The tempting shortcut when this was diagnosed: teach the reader the name
    // `pendingRetry`. A store with one parked row reports pendingRetry:1 on
    // every quiet cycle forever, so that reading would have claimed work on
    // every cycle that did none -- a fabricated ACTED, which is worse than the
    // honest UNKNOWN it replaced.
    const r = cppResult('recoveryQueue', {
      enqueued: 0, resolved: 0, needsHuman: 1, pendingRetry: 1,
      examined: 2, inRecovery: 1, reChecked: 1, matched: 1, acted: 0, needsHumanRows: [{ queueId: 'q1' }],
    }, null)
    expect(r.acted).toBe(0)
    expect(r.outcome).not.toBe('ACTED')
    expect(r.examined).toBe(2)   // it still looked, and says so
  })
})

describe('CPP normaliser — failure beats every counter', () => {
  it('a hard failure is FAILED even with healthy-looking counters', () => {
    const r = cppResult('step', { examined: 10, acted: 10 }, 'exit 1')
    expect(r.outcome).toBe('FAILED')
    expect(r.failed).toBeGreaterThan(0)
  })

  it('a non-empty failures array is FAILED, and acted>0 makes the run PARTIAL', () => {
    // PARTIAL here comes from the FAILED branch (acted > 0 alongside a failure),
    // not from the verification -- which is why it still holds after the
    // 2026-08-27 fix that stopped NOT_APPLICABLE reading as a failed readback.
    const r = cppResult('channel', { pending: 1, sent: 1, failures: [{ caseId: 'c1', error: 'boom' }] }, null)
    expect(r.outcome).toBe('FAILED')
    expect(deriveRunStatus(r, 'NOT_APPLICABLE')).toBe('PARTIAL')
  })

  it('failed:true nested under a subsystem is caught (the dead-Reader shape)', () => {
    const r = cppResult('progression', { heartbeat: { read: 0, failed: true } }, null)
    expect(r.outcome).toBe('FAILED')
  })

  it('an EMPTY failures array is not a failure', () => {
    // The counter-case: a detector that fires on every healthy run is not one.
    expect(cppResult('channel', { pending: 0, sent: 0, failures: [] }, null).outcome).not.toBe('FAILED')
  })
})

describe('CPP normaliser — the nested/aliased readings that UNKNOWN once hid', () => {
  it('personal+zst branches are summed rather than declared unknowable', () => {
    // 2026-08-24: five of ten steps reported UNKNOWN and every one of them was
    // in fact exposing usable numbers, just nested. UNKNOWN was describing the
    // reader.
    const r = cppResult('deadlineAudit', {
      personal: { examined: 76, proseOnly: [] },
      zst: { examined: 70, proseOnly: [] },
    }, null)
    expect(r.examined).toBe(146)
    expect(r.outcome).not.toBe('UNKNOWN')
  })

  it('drafted:[] plus skipped:N is measured, not unknowable', () => {
    const r = cppResult('followups', { drafted: [], skipped: 17 }, null)
    expect(r.examined).toBe(17)
    expect(r.acted).toBe(0)
    expect(r.outcome).not.toBe('UNKNOWN')
  })

  it('a digest that posted nothing reports a measured zero action', () => {
    const r = cppResult('plannedDigest', { posted: false, alreadyToday: true, count: 1 }, null)
    expect(r.examined).toBe(1)
    expect(r.acted).toBe(0)
    expect(r.outcome).not.toBe('UNKNOWN')
  })
})

// ── The step's own reporting adapter, and the guard inside it ────────────────
describe('recovery step payload — the scanned-nothing guard', () => {
  const healthy = {
    enqueued: 0, resolved: 0, needsHuman: 0, pendingRetry: 0,
    examined: 0, inRecovery: 0, reChecked: 0, surfacesScanned: 3,
  }

  it('a healthy empty run is reported as clean, with CPP names attached', () => {
    const p = recoveryStepPayload(healthy, [])
    expect(p.failed).toBeUndefined()
    expect(p.matched).toBe(0)
    expect(p.acted).toBe(0)
    expect(p.examined).toBe(0)
    expect(status(p)).toBe('SUCCESS')
  })

  it('HEADLINE: identical row counters, zero surfaces scanned -- FAILED', () => {
    // Every number below is the same as the healthy case except the witness.
    // This is the whole point of the witness: on the live store the row
    // counters cannot tell these two runs apart, and one of them is a step
    // that did not run.
    const p = recoveryStepPayload({ ...healthy, surfacesScanned: 0 }, [])
    expect(p.failed).toBe(true)
    expect(String(p.error)).toMatch(/scanned ZERO source surfaces/)
    expect(status(p)).toBe('FAILED')
  })

  it('work is reported as acted; status counts are not', () => {
    const p = recoveryStepPayload(
      { enqueued: 2, resolved: 1, needsHuman: 4, pendingRetry: 9, examined: 7, inRecovery: 4, reChecked: 3, surfacesScanned: 3 },
      [{ queueId: 'q1' }],
    )
    expect(p.acted).toBe(3)      // 2 enqueued + 1 resolved
    expect(p.matched).toBe(4)    // rows in a recovery state
    expect(p.needsHumanRows).toHaveLength(1)
  })
})
