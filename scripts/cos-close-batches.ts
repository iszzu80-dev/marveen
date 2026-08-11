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

/** Is the standing review task for this exception already open? Used to keep a
 *  permanent condition from producing one card and one alert per message. */
function reviewTaskExists(acct: string, kind: string): boolean {
  if (kind !== 'SOURCE_COMMIT_SKIPPED') return false
  const row = getDb().prepare(
    `SELECT 1 FROM kanban_cards WHERE id = ? AND status != 'done'`,
  ).get(`scs-${acct}`.slice(0, 36))
  return row !== undefined
}

// A.1 conditions 2 and 3, wired to real surfaces. If either write fails the
// condition is false and the message is NOT quarantined — the batch stays
// blocked, which is the visible failure we want.
const quarantine: QuarantineDeps = {
  // A poison message and a source-commit skip are BOTH "the cursor passed
  // something", and that is where the similarity ends. Poison could not be
  // processed; a skip was processed completely and only failed to be MARKED at
  // the source, because this install's Gmail token has no modify scope. Wording
  // the second one as the first told Istvan on 2026-08-11 that a perfectly
  // handled GLS pickup notice was an "unprocessable message, check it by hand".
  raiseAlert: (acct, mid, reason, kind) => {
    try {
      // A skip is a PERMANENT, policy-approved condition: it will hold for every
      // message until a modify scope exists. Alerting per message would put a
      // critical alert on every mail that arrives — the exact noise that gets a
      // channel muted, and the reason the review task below is deduped too.
      if (kind === 'SOURCE_COMMIT_SKIPPED' && reviewTaskExists(acct, kind)) return true
      const content = kind === 'SOURCE_COMMIT_SKIPPED'
        ? `[FIGYELEM] A forras-jelolés kimaradt: ${acct}/${mid} -- ${reason}. A level FEL LETT DOLGOZVA; ami nem tortent meg, az a COS/Processed cimke felirasa. A pozicio ezert lephet tovabb. Amig nincs modify scope, ez minden levelnel igy lesz -- ezert errol egyszer szolok, nem levelenkent.`
        : `[KRITIKUS] Karantenba kerulo level: ${acct}/${mid} -- ${reason}. A pozicio atlep felette, ezert kezi ellenorzes kell.`
      getDb().prepare(
        `INSERT INTO agent_messages (from_agent, to_agent, content, created_at)
         VALUES ('marveen','marveen',@c,@now)`
      ).run({ c: content, now })
      return true
    } catch { return false }
  },
  createReviewTask: (acct, mid, reason, kind) => {
    try {
      if (kind === 'SOURCE_COMMIT_SKIPPED') {
        // ONE open card per account while the condition holds, not one per
        // message. A stable id makes the second insert collide and no-op, and
        // the A.1 condition is still honestly satisfied: a human review task
        // for this exception exists.
        if (reviewTaskExists(acct, kind)) return true
        getDb().prepare(
          `INSERT INTO kanban_cards (id, title, description, status, priority, created_at, updated_at)
           VALUES (@id, @t, @d, 'planned', 'normal', @now, @now)`
        ).run({
          id: `scs-${acct}`.slice(0, 36),
          t: `COS: a forras-jelolés kimarad (${acct}) -- nincs Gmail modify scope`,
          d: `Ok: ${reason}\n\nEz NEM feldolgozatlan level. A levelek feldolgozasa terminalis es teljes; ami nem tortenik meg, az a COS/Processed cimke felirasa a Gmailben, mert a token csak gmail.send jogot hordoz.\n\nElso erintett uzenet: ${mid}. A tovabbi erintett levelek NEM kapnak kulon kartyat -- a feltetel allando, es a sorok sajat last_error mezoje orzi az okot (email_processing, status=SOURCE_COMMIT_SKIPPED).\n\nA KARTYA AKKOR ZARHATO, ha (a) modify scope-ot kap a token es a GmailLabelCommitter bekotesre kerul, VAGY (b) Istvan kimondja, hogy a forras-jelolesre nincs szukseg. Addig ez egy nyitott, tudott kivetel -- nem incidens.`,
          now,
        })
        return true
      }
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
