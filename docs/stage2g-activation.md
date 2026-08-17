# Stage 2G activation runbook

The code is on PR #20. The heartbeat is **not yet emitting** provenance, and this
file says exactly why and what turns it on. It is separated on purpose: flipping
it before the branch lands would sync a release built from `develop`, where the
fields do not exist — a switch that reports success and changes nothing.

## What is already true (on this branch)

- `cos_triage_provenance` records the verdict; the receipt id **is** the verdict's
  fingerprint.
- `requireExactTriageReceipt` re-derives that fingerprint from the verdict being
  applied, so a case can only open on the receipt that decided it.
- The link is durable in three places: `email_processing.triage_receipt_id`,
  `zst_email_processing.triage_receipt_id`, and the `CREATED` event payload.
- `scripts/email-triage-fetch.py` emits `sourceManifestHash` per candidate (a
  canonical hash of exactly the fields the agent sees) and a top-level
  `triagePromptFingerprint` measured from the rule files on disk.
- `goForwardProvenanceStatus(db, cutoff)` returns
  `GO_FORWARD_PROVENANCE_INCOMPLETE` if any receipt decided at or after the
  cutoff lacks actor, model, prompt fingerprint or source manifest hash.

## What activation requires (needs a GO)

1. Land this branch, then `scripts/sync-scheduled-scripts.sh <ref>` so the pinned
   release carries the feeder that emits the fingerprints. **Order matters**: the
   sync copies file content from a git ref, so syncing from `develop` today would
   pin the version without provenance.
2. Add the five fields to the intake POST in
   `~/.claude/scheduled-tasks/personal-gmail-delta/SKILL.md`:

   ```
   "sourceManifestHash":"<candidate.sourceManifestHash — verbatim from the fetch output>",
   "triageActor":"marveen",
   "triageModel":"<the model id actually deciding, e.g. claude-opus-5>",
   "triagePromptFingerprint":"<triagePromptFingerprint from the fetch output>",
   "triageDecidedAt":<unix seconds at the moment of the verdict>
   ```

   Pass the hash and the fingerprint **through unchanged**. Recomputing either in
   the prompt would fingerprint what the agent retyped, not what it read.
3. Record the activation cutoff (unix seconds) wherever the readiness gate is
   evaluated, and from that moment `GO_FORWARD_PROVENANCE_INCOMPLETE` is a
   failure, not a warning.

## What activation explicitly does NOT do

Nothing is back-filled. Receipts decided before the cutoff stay as they are, and
historical cases keep having none. Reconstructing them would fabricate the exact
evidence the 2026-08-17 audit proved never existed — the failure this stage was
created to stop.
