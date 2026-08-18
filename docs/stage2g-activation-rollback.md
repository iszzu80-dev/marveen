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

The same applies to the cutoff: a cutoff that is moved BACKWARD to hide incomplete
post-cutoff receipts is a deletion by another name. If the cutoff has to move, it
moves forward, and the reason is recorded.

## Ordered, reversible activation sequence

1. verify the candidate SHA and the frozen hashes still match;
2. sync the pinned release AND apply the heartbeat patch — one step;
3. let one real heartbeat cycle run; read the receipt it produced;
4. only if that receipt is complete (actor, model, prompt fingerprint, source
   manifest hash all present, receipt id identical in ledger and CREATED event),
   set the cutoff to a timestamp AFTER that receipt;
5. `goForwardProvenanceStatus(cutoff)` is then the standing check.

Between 2 and 4 the system is already better than before (receipts are being
written) and no consumer requires them yet. That is the safe window, and it is
where a problem should be found.
