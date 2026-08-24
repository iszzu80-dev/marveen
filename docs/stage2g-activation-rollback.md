# Stage 2G — activation rollback / fail-closed plan

Written during the 2026-08-18 activation preflight. Nothing here has been executed.

## The ordering constraint that creates the risk

Activation has three producer-side halves and one consumer-side switch:

1. the branch lands (candidate code),
2. the pinned release is synced (the feeder starts EMITTING the provenance fields),
3. the heartbeat SKILL.md is patched (the model starts PASSING them to intake),
4. the go-forward cutoff is chosen (the consumer starts REQUIRING them).

Steps 2 and 3 must land together. With 2 alone the fields exist and nobody sends
them; with 3 alone the SKILL asks for fields the feeder does not produce. Step 4
must come strictly after both, or there is a window where the cutoff is live and
the producer is still the old one — every case opened in that window reports
`GO_FORWARD_PROVENANCE_INCOMPLETE` and the incompleteness is ours, not the data's.

## If the first live receipt is incomplete

`requireExactTriageReceipt` already fails closed: intake refuses to create the
case when the receipt does not match the verdict exactly. So the first symptom is
a REFUSED case, not a silent bad one. That is the designed behaviour and it needs
no rollback — it needs a look at which field is missing.

Stopping new email-derived case creation, fail-closed, without touching data:

- **Preferred:** disable the `personal-gmail-delta` schedule. No feeder run, no
  intake POST, no case. Reading stops; nothing is corrupted; the mailbox is
  simply unwatched, and THAT must be announced, because an unwatched mailbox that
  nobody is told about is the failure mode this system already lived through on
  2026-08-18.
- **Narrower:** revert the heartbeat SKILL.md patch only. The feeder still emits,
  the model stops passing, and receipts go back to UNDECLARED. Acceptable ONLY if
  the cutoff has not been set yet.

## Reverting the producer without destroying history

- The pinned release is restored by syncing the PREVIOUS release ref. The release
  directory is a copy; restoring it changes what runs next, not what already ran.
- The heartbeat SKILL.md is restored from its git history / the recorded hash in
  `preflight-2026-08-18/freeze-v2.json`
  (`triageRules_heartbeatSkill = 847976d3…`). A restored SKILL changes the
  prompt fingerprint of FUTURE receipts, which is correct: they were produced
  under different rules and must say so.

## What rollback may never include

**No receipt is ever deleted or overwritten.** Not by a rollback, not by a repair,
not to make a status green.

A receipt is the record of a judgement that actually happened. Deleting one does
not undo the case it opened; it removes the only evidence of why the case exists,
and it does so precisely when something has gone wrong and the evidence matters
most. `recordTriageReceipt` is append-only and idempotent by design: the same
verdict re-recorded returns the same receipt, and a changed verdict appends a new
one. Rollback keeps that property.

### The cutoff is immutable, and the earlier rule here was backwards

This section previously said a cutoff "moves forward, and the reason is
recorded", treating a BACKWARD move as the dangerous one. That was inverted, and
the inversion was mechanical, not stylistic.

`goForwardProvenanceStatus(cutoff)` examines receipts with `decided_at >=
cutoff`. Raising the cutoff SHRINKS the examined set. So an incomplete receipt
decided at t=150 under a cutoff of 100 vanishes the moment the cutoff moves to
200: the gate reports PASS, nothing was fixed, and the old text called that the
safe direction. Lowering the cutoff only ever ADMITS more evidence, so it is the
harmless one.

**After activation the cutoff is IMMUTABLE.** Not forward, not backward, not
"with the reason recorded". `evaluateProvenanceEpoch` takes no cutoff argument
at all: the only way to ask "are we ready?" is to ask it at the value fixed when
the epoch was opened, so there is nothing to tune until the answer turns green.

If the provenance regime genuinely has to change, that is a NEW EPOCH:

- a new `epochId` and its own cutoff, which must be strictly AFTER the previous
  one (a lower cutoff would re-judge receipts an earlier epoch already sealed);
- the previous epoch is sealed first, and a sealed verdict is permanent.
  `sealProvenanceEpoch` refuses to re-seal, including refusing to upgrade a
  failure into a pass;
- a sealed FAILURE keeps `activationProvenanceReadiness` at `PRIOR_EPOCH_FAILED`
  no matter how clean the new epoch is. A new epoch is a fresh start for future
  receipts, never a retroactive pardon for past ones;
- the seal records the WORST observation of the epoch, not the latest. Deleting
  the offending receipt therefore does not buy a PASS, which matters precisely
  because the rule directly above says no receipt is ever deleted.

Implementation: `src/cos/provenance-epoch.ts`. Regressions:
`src/__tests__/cos-activation-blockers.test.ts`, including the required case
(cutoff=100, incomplete receipt at 150, moving to 200 hides nothing, the failed
epoch stays failed).

## Ordered activation sequence (Istvan, 2026-08-23)

The pre-cutoff probe and the post-cutoff proof are two DIFFERENT heartbeats. One
run cannot serve as both, because a receipt decided before the cutoff is by
definition outside what the gate examines.

1. **Re-verify the freeze.** Candidate SHA and every frozen hash still match; a
   change is `ACTIVATION_CANDIDATE_CHANGED` and stops here.
2. **Ship the activation bundle as ONE declared step**: pinned release sync plus
   heartbeat SKILL.md patch. Split, either half is broken (fields nobody sends,
   or a SKILL asking for fields nobody produces). The manifest names everything
   the bundle carries, including changes that are not provenance (see below).
3. **One real pre-cutoff probe.** Let a heartbeat run and read the receipt it
   produced. Complete means: actor, canonical model, prompt fingerprint and
   source manifest hash all present, and the exact `receiptId` appears both in
   the processing ledger and in the `CREATED` event payload.
4. **Only if that receipt is complete**, open the epoch: `openProvenanceEpoch`
   with a cutoff AFTER the probe receipt. From this moment the cutoff is
   immutable.
5. **A SECOND real heartbeat**, whose receipt is `decidedAt >= cutoff`. This is
   the evidence the gate actually examines.
6. **Prove it**: complete receipt; exact `receiptId` in ledger AND `CREATED`
   event; `activationProvenanceReadiness` = `PASS`.

`STAGE_2G_ACTIVATION = PASS` only after step 6. Between 2 and 4 the system is
already better than before (receipts are written) and no consumer requires them
yet. That is the safe window, and it is where a problem should be found.

### If there is no second actionable email

Do NOT manufacture a production case to feed the gate. A case invented to make a
status green is a false record in the very store whose honesty this stage exists
to establish.

The state is `ACTIVE_AWAITING_POST_CUTOFF_EVIDENCE`, and it is a first-class
outcome, not a warning: `evaluateProvenanceEpoch` returns it whenever the epoch
has examined zero post-cutoff receipts, `sealProvenanceEpoch` refuses to seal it
(`PROVENANCE_EPOCH_NO_EVIDENCE`), and readiness reports it instead of `PASS`. An
activated epoch that has judged nothing has proven nothing.

## What the activation bundle declares

The manifest must name every behavioural change the bundle carries, not only the
provenance ones. As of this candidate:

    BUNDLED_CHANGE = normative self/test traffic exclusion

The same pinned release sync that starts emitting provenance also changes which
mail counts as noise: self-product and test traffic are now excluded at the
normative layer (commit a5f29705). The prompt/rule fingerprint covers it, which
is what makes it detectable, but a fingerprint that changes for an undeclared
reason is a mystery, not evidence. **This is not a provenance-only release, and
the manifest must not call it one.**

## Hardening items carried alongside activation (not blockers)

Neither of these blocks Stage 2G activation. Both block the 7-day unattended
stability window, and they are written here so that window cannot start while
they are open.

- **P1 -- ZST Gmail `gmail.modify` is granted with no caller.** Least privilege
  audit (2026-08-18) found the scope open on the ZST credential. Nothing invokes
  it, which is why it is not an activation blocker, but an unused write scope is
  a standing capability nobody is watching. Remove it before the stability
  window. The stale comment claiming that token carries only `gmail.send` is
  wrong and is corrected in `docs/stage2g-activation.md`: documentation that
  understates a live capability is worse than no documentation, because it
  retires the question.
- **P1 -- Personal OAuth consent screen is in Testing.** A Testing-mode refresh
  token has a bounded lifetime. The stability window may not start until it is
  PROVEN that the credential cannot expire mid-window from the token lifecycle.
  A window that dies silently on day 4 and is discovered on day 7 measures
  nothing.
