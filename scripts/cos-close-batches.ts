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
import { closeOpenBatches, openBatchIds, NoSourceWriteCommitter, GmailLabelCommitter } from '../src/cos/source-commit.js'
import { probeSourceWriteCapability } from '../src/cos/source-commit-capability.js'
import { GmailLabelApi } from '../src/cos/adapters/gmail-label-api.js'
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

/** The stable kanban id for this exception. ONE card per account for the
 *  standing source-write skip, ONE card per message for a quarantine. */
function cardIdFor(kind: string, acct: string, mid: string): string {
  return (kind === 'SOURCE_COMMIT_SKIPPED' ? `scs-${acct}` : `qtn-${mid}`).slice(0, 36)
}

/** Is a review task for this exception already on the board (and not done)?
 *
 *  This used to answer `false` for anything that was not SOURCE_COMMIT_SKIPPED,
 *  which made the quarantine kind self-poisoning: quarantinePoison created the
 *  `qtn-<mid>` card, a later condition failed, and on the next sweep the plain
 *  INSERT hit the PK conflict, the catch returned false, and A.1's condition 3
 *  read "review task NOT created" — permanently. The message could never be
 *  quarantined again and the batch stayed pinned while a fresh duplicate
 *  CRITICAL alert row was inserted on every pass. An existing OPEN card is the
 *  condition being satisfied, not a failure. */
function reviewTaskExists(acct: string, kind: string, mid = ''): boolean {
  const row = getDb().prepare(
    `SELECT 1 FROM kanban_cards WHERE id = ? AND status != 'done'`,
  ).get(cardIdFor(kind, acct, mid))
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
      //
      // The QUARANTINE kind is deduped on the same rule: while its card is open
      // the owner has already been told about that message, and a sweep that
      // runs every wake must not add a CRITICAL row per pass to say it again.
      if (reviewTaskExists(acct, kind, mid)) return true
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
      // An OPEN card for this exception IS the condition — for both kinds. See
      // reviewTaskExists for the failure this replaces.
      if (reviewTaskExists(acct, kind, mid)) return true
      if (kind === 'SOURCE_COMMIT_SKIPPED') {
        // ONE open card per account while the condition holds, not one per
        // message. A stable id makes the second insert collide and no-op, and
        // the A.1 condition is still honestly satisfied: a human review task
        // for this exception exists.
        getDb().prepare(
          `INSERT OR IGNORE INTO kanban_cards (id, title, description, status, priority, created_at, updated_at)
           VALUES (@id, @t, @d, 'planned', 'normal', @now, @now)`
        ).run({
          id: cardIdFor(kind, acct, mid),
          t: `COS: a forras-jelolés kimarad (${acct}) -- nincs Gmail modify scope`,
          d: `Ok: ${reason}\n\nEz NEM feldolgozatlan level. A levelek feldolgozasa terminalis es teljes; ami nem tortenik meg, az a COS/Processed cimke felirasa a Gmailben, mert a token csak gmail.send jogot hordoz.\n\nElso erintett uzenet: ${mid}. A tovabbi erintett levelek NEM kapnak kulon kartyat -- a feltetel allando, es a sorok sajat last_error mezoje orzi az okot (email_processing, status=SOURCE_COMMIT_SKIPPED).\n\nA KARTYA AKKOR ZARHATO, ha (a) modify scope-ot kap a token es a GmailLabelCommitter bekotesre kerul, VAGY (b) Istvan kimondja, hogy a forras-jelolesre nincs szukseg. Addig ez egy nyitott, tudott kivetel -- nem incidens.`,
          now,
        })
        return true
      }
      // INSERT OR IGNORE: a card that already exists (including one the owner
      // has already CLOSED for this very message) means the review task the
      // condition asks for exists. A PK conflict here used to surface as
      // "condition not met", which pinned the batch for good.
      getDb().prepare(
        `INSERT OR IGNORE INTO kanban_cards (id, title, description, status, priority, created_at, updated_at)
         VALUES (@id, @t, @d, 'planned', 'high', @now, @now)`
      ).run({
        id: cardIdFor(kind, acct, mid),
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
// WHICH COMMITTER. Istvan granted gmail.modify on 2026-08-11, so the real one
// can finally be used -- GmailLabelCommitter has been written and unused since
// F-8 precisely because wiring it without the scope produces a committer that
// fails every call.
//
// The choice is made from the CREDS FILE's presence, not from a flag someone has
// to remember to flip, and it falls back to the honest no-write committer when
// the file is absent. If the scope is later revoked, the label call fails, the
// committer reports FAILED, and the batch stays open -- visibly, which is the
// behaviour F-8 wanted all along.
const credsPath = 'store/.google-private-creds.json'

// WHICH COMMITTER -- decided by MEASURING the granted scope, not by the creds
// file existing (incident 2026-08-31, see source-commit-capability.ts). The file
// was present the whole time the scope was gone, so the writer was chosen, every
// call 403'd, and the jam looked like an ordinary open batch for two weeks.
const capability = await probeSourceWriteCapability(credsPath)
console.log('SourceWriteCapability:', JSON.stringify({ verdict: capability.verdict, reason: capability.reason }))

if (capability.verdict === 'UNKNOWN') {
  // Close nothing. We do not know whether the mark is possible, and an unknown
  // must not be spent as a "cannot": the skip is what lets the cursor pass, and
  // a cursor moved on a guess cannot be un-moved.
  console.log(JSON.stringify({
    batches: openBatchIds(getDb()).length, closed: 0, quarantined: 0,
    policyApplied: policy.allowCursorAdvanceWithoutSourceWrite === true,
    failed: true,
    reasons: [`a forras-jelolesi kepesseg NEM MERHETO, ezert egyetlen koteget sem zarok: ${capability.reason}`],
  }))
  process.exit(0)
}

const committer = capability.verdict === 'CAPABLE'
  ? new GmailLabelCommitter(new GmailLabelApi({ credsPath }).apply)
  // The MEASURED reason, not the sentence someone typed into the policy file in
  // August. The policy grants the permission; it does not get to describe the
  // world.
  : new NoSourceWriteCommitter(capability.reason)
console.log('SourceCommitter:', JSON.stringify({ id: committer.id }))
const r = await closeOpenBatches(getDb(), committer, now, {
  allowCursorAdvanceWithoutSourceWrite: policy.allowCursorAdvanceWithoutSourceWrite === true,
  quarantine,
})
console.log(JSON.stringify({ batches: r.batches, closed: r.closed,
  quarantined: r.results.reduce((a, x) => a + (x.quarantined || 0), 0),
  policyApplied: policy.allowCursorAdvanceWithoutSourceWrite === true,
  reasons: Array.from(new Set(r.results.map((x) => x.reason))) }))
