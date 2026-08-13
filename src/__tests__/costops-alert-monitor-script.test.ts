// COS-OPS-M5: source-level pins for ops/scheduled-tasks/costops-alert-monitor/check.py.
//
// There is no Python test harness in this repo, so the monitor script's
// regression-prone invariants are asserted at the source level -- the same
// standard dispatch-outcome-writers.test.ts uses for the tmux-driven worker
// writers. Each pin goes red if the specific fix regresses:
//
//  (a) any valid-JSON response used to be treated as authoritative coverage --
//      a 401/500 JSON body dropped every stored dedup key for that prefix and
//      re-pushed duplicate alerts on recovery. The fetch helper must check the
//      HTTP status is 200 before claiming ok.
//  (b) the severity filter read ('high','critical') and silently never pushed
//      'blocked' -- the MOST severe tier in warnings.ts's ladder
//      (low < medium < high < critical < blocked, warnings.ts:20).
//  (c) the covered_prefixes accumulator was dead code (appended, never read).
//  (d) state saving was a direct open(...,'w') -- a crash mid-write left a
//      truncated file that load_state() read as "nothing ever alerted",
//      re-pushing every standing alert. It must write a temp file and
//      os.replace() it into place (atomic on POSIX).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SCRIPT = readFileSync(
  join(__dirname, '..', '..', 'ops', 'scheduled-tasks', 'costops-alert-monitor', 'check.py'),
  'utf-8',
)

describe('costops-alert-monitor check.py (COS-OPS-M5 source pins)', () => {
  it('(a) verifies the HTTP status is 200 before treating a response as authoritative', () => {
    // curl is asked to append the status code, and the helper compares it to 200
    expect(SCRIPT).toContain("%{http_code}")
    expect(SCRIPT).toMatch(/status\.strip\(\)\s*!=\s*'200'/)
    // failure path keeps prior state (carry-forward), never an empty authoritative set
    expect(SCRIPT).toContain('return False, None')
  })

  it("(a) each source also verifies the expected payload shape before its keys become authoritative", () => {
    expect(SCRIPT).toMatch(/isinstance\(lim,\s*dict\)\s*and\s*isinstance\(lim\.get\('limits'\),\s*list\)/)
    expect(SCRIPT).toMatch(/isinstance\(w\.get\('warnings'\),\s*list\)/)
    expect(SCRIPT).toMatch(/isinstance\(sub\.get\('subscriptions'\),\s*list\)/)
  })

  it("(b) the severity filter includes 'blocked' -- the most severe warnings.ts tier", () => {
    expect(SCRIPT).toContain("('high', 'critical', 'blocked')")
    // and the old, blocked-less tuple is gone
    expect(SCRIPT).not.toMatch(/\('high',\s*'critical'\)/)
  })

  it('(c) the dead covered_prefixes accumulation is deleted', () => {
    expect(SCRIPT).not.toContain('covered_prefixes')
  })

  it('(d) save_state is atomic: temp file + os.replace', () => {
    expect(SCRIPT).toContain('os.replace(tmp, STATE_FILE)')
    // the json dump goes to the temp file handle, not directly to STATE_FILE
    expect(SCRIPT).not.toMatch(/open\(STATE_FILE,\s*'w'\)/)
  })
})
