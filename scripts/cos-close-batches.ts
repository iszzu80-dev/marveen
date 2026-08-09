// Close the inbound chain for every open batch (§8 second half).
//
// Invoked by personal-case-wake. Separate from the daily reconcile on purpose:
// the reconcile is read-only and diagnoses, this one acts.
//
// The policy that allows the cursor to advance without a source-side write lives
// in store/cos-source-commit-policy.json, NOT in this file — a policy buried in
// a script is a policy nobody can find or revoke.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, initDatabase } from '../src/db.js'
import { closeOpenBatches, NoSourceWriteCommitter } from '../src/cos/source-commit.js'
import type { QuarantineDeps } from '../src/cos/poison-quarantine.js'

const REPO = join(import.meta.dirname, '..')
const POLICY = join(REPO, 'store', 'cos-source-commit-policy.json')

interface Policy { allowCursorAdvanceWithoutSourceWrite?: boolean; reason?: string }

let policy: Policy = {}
try {
  policy = JSON.parse(readFileSync(POLICY, 'utf8')) as Policy
} catch {
  // No policy file = no exception. The chain stays visibly open, which is the
  // honest default: better a loud gap than a quiet assumption.
}

initDatabase()
const now = Math.floor(Date.now() / 1000)

// A.1 conditions 2 and 3, wired to real surfaces. If either write fails the
// condition is false and the message is NOT quarantined — the batch stays
// blocked, which is the visible failure we want.
const quarantine: QuarantineDeps = {
  raiseAlert: (acct, mid, reason) => {
    try {
      getDb().prepare(
        `INSERT INTO agent_messages (from_agent, to_agent, content, created_at)
         VALUES ('marveen','marveen',@c,@now)`
      ).run({ c: `[KRITIKUS] Karantenba kerulo level: ${acct}/${mid} -- ${reason}. A pozicio atlep felette, ezert kezi ellenorzes kell.`, now })
      return true
    } catch { return false }
  },
  createReviewTask: (acct, mid, reason) => {
    try {
      getDb().prepare(
        `INSERT INTO kanban_cards (id, title, description, status, priority, created_at, updated_at)
         VALUES (@id, @t, @d, 'planned', 'high', @now, @now)`
      ).run({
        id: `qtn-${mid}`.slice(0, 36),
        t: `COS karanten: feldolgozhatatlan level (${acct}/${mid})`,
        d: `Ok: ${reason}\n\nA level a Gmailben MEGVAN (message id: ${mid}); a COS nem tudta feldolgozni, ezert a pozicio atlepett felette. Nezd meg kezzel, mi van benne.`,
        now,
      })
      return true
    } catch { return false }
  },
  // Condition 5 shares the same policy file as the source-write exception: one
  // place where the owner allows the cursor to move past something.
  policyAllowsCursorAdvance: () => policy.allowCursorAdvanceWithoutSourceWrite === true,
}
const r = await closeOpenBatches(getDb(), new NoSourceWriteCommitter(policy.reason), now, {
  allowCursorAdvanceWithoutSourceWrite: policy.allowCursorAdvanceWithoutSourceWrite === true,
  quarantine,
})
console.log(JSON.stringify({ batches: r.batches, closed: r.closed,
  quarantined: r.results.reduce((a, x) => a + (x.quarantined || 0), 0),
  policyApplied: policy.allowCursorAdvanceWithoutSourceWrite === true,
  reasons: Array.from(new Set(r.results.map((x) => x.reason))) }))
