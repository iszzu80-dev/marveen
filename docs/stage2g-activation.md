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
   "triageModel":"<the CANONICAL model id, resolved from raw argv -- see below>",
   "triagePromptFingerprint":"<triagePromptFingerprint from the fetch output>",
   "triageDecidedAt":<unix seconds at the moment of the verdict>
   ```

   Pass the hash and the fingerprint **through unchanged**. Recomputing either in
   the prompt would fingerprint what the agent retyped, not what it read.
3. Open a provenance epoch (`openProvenanceEpoch`, `src/cos/provenance-epoch.ts`)
   with the activation cutoff in unix seconds. From that moment
   `GO_FORWARD_PROVENANCE_INCOMPLETE` is a failure, not a warning, and **the
   cutoff is immutable** -- see the rollback plan for why moving it forward, not
   backward, is the direction that hides failures.

## Where `triageModel` comes from

It is resolved, never typed. `resolveRuntimeModelIdentity`
(`src/cos/model-identity.ts`) walks the process ancestry from the running agent,
stops at the NEAREST `claude` process, and reads `--model` out of
`/proc/<pid>/cmdline`: raw, NUL-separated argv, not a `ps` rendering and not
anything the terminal drew.

Four rules, none of them cosmetic:

- **No cleaning.** A value that is not already canonical FAILS. A resolver that
  strips a character it did not expect reports a model no process was launched
  with, and the receipt then attests to something that did not happen.
- **Control and ANSI bytes are rejected outright** as
  `MODEL_IDENTITY_CONTROL_CHARACTERS`, never stripped.
- **Only the nearest claude is authoritative.** A non-claude ancestor whose
  command line merely contains `--model` is never consulted at all, and if the
  nearest claude carries no `--model`, the answer is `MODEL_IDENTITY_UNRESOLVED`
  rather than a value borrowed from an outer session.
- **Unprovable is a state, not a default.** `MODEL_IDENTITY_UNRESOLVED` is what
  gets recorded when nothing can be proven, and `goForwardProvenanceStatus`
  treats it as an incomplete receipt.

### The `[1m]` suffix: decomposed, not discarded (Istvan, 2026-08-24, decision C)

The first cut of this resolver rejected `claude-opus-5[1m]` outright, on the
premise that the brackets were ANSI decoration from a terminal rendering. Running
the resolver against the live process disproved that premise:
`/proc/18442/cmdline` carries `claude-opus-5[1m]` as a literal 17-byte argv
element with zero control bytes. It is not decoration, it is the identity of the
build that is running, and `[1m]` is what selects the 1M-context variant.

Rejecting it would therefore have made provenance permanently unprovable on this
fleet. Changing the launcher to pass `claude-opus-5` would have been worse: it
would change which build runs, to buy a prettier receipt.

So the value is DECOMPOSED and both halves are validated:

| field | value | meaning |
|---|---|---|
| `modelId` | `claude-opus-5[1m]` | what the receipt records: the identity as launched |
| `model` | `claude-opus-5` | canonical base id, for grouping across variants |
| `modelVariant` | `1m` | the declared variant token |

`MODEL_VARIANT_RE` admits exactly one bracketed lowercase alphanumeric token as a
SUFFIX. `claude-opus-5[1M]`, `claude-opus-5[]`, `claude-opus-5[1m]x` and
`claude[1m]-opus-5` all fail, and an ANSI escape still fails on the control-byte
check before the grammar is even consulted.

What keeps this a parse and not a sanitize is that `modelId` **is** the raw
string, by construction. `model` and `modelVariant` are derived views for
grouping and reporting; the recorded value is never rebuilt from them, so no
parsing slip can hand back a different identity than the one that was read.

`CANONICAL_MODEL_ID_RE` still governs the base id alone, and is deliberately
narrower than `MODEL_ID_RE` in `src/model-id.ts`. That one is a shell-injection
allowlist for a value heading to a command line. This one answers a different
question: may we attest to this identity? The two must not be merged -- one
protects a sink, the other protects a claim.

## Gmail scopes actually granted (2026-08-18 least-privilege audit)

Recorded here because an earlier note in this area claimed the ZST token carried
only `gmail.send`. It does not.

- **Personal**: reviewed, least-privilege, accepted.
- **ZST**: `gmail.modify` is granted with **no caller in the codebase**. Not an
  activation blocker precisely because nothing invokes it, but an unused write
  scope is a standing capability nobody is watching. Tracked as a P1 hardening
  item to be removed before the 7-day unattended stability window.

## What activation explicitly does NOT do

Nothing is back-filled. Receipts decided before the cutoff stay as they are, and
historical cases keep having none. Reconstructing them would fabricate the exact
evidence the 2026-08-17 audit proved never existed — the failure this stage was
created to stop.
