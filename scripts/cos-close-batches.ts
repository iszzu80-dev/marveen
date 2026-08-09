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
const r = await closeOpenBatches(getDb(), new NoSourceWriteCommitter(policy.reason), now, {
  allowCursorAdvanceWithoutSourceWrite: policy.allowCursorAdvanceWithoutSourceWrite === true,
})
console.log(JSON.stringify({ batches: r.batches, closed: r.closed,
  policyApplied: policy.allowCursorAdvanceWithoutSourceWrite === true,
  reasons: Array.from(new Set(r.results.map((x) => x.reason))) }))
