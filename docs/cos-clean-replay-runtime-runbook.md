# Clean Replay & Reconciliation — runtime runbook

**Status:** operational procedure for PR #20; no automatic production repair.

This runbook executes the three runtime artifacts in a controlled order on the Marveen host (or against a filesystem snapshot). It deliberately separates source export, production read snapshot and shadow replay.

## Preconditions

1. PR #20 code is checked out on a non-production-working-copy or approved runtime release branch.
2. GitHub CI (kernel + typecheck + Vitest) has actually executed and is green. A GitHub billing/spending-limit failure does **not** satisfy this condition.
3. `mcp-servers/google-private-mcp.py` and `mcp-servers/google-zst-mcp.py` exist and both expose:
   - `gmail_search`;
   - a read-only **full-thread** Gmail read tool.

   **The connector contract is a precondition, and it is NOT in this PR.** The
   `mcp-servers/` directory is deliberately untracked (owner-scoped), so the diff
   that satisfies the two requirements below cannot appear in PR #20 and must be
   verified on the host before a run. Both are load-bearing for a corpus that can
   be audited, and both were added on 2026-08-17:

   - **`attachments`** per message: the declared `filename`, `mimeType`,
     `sizeBytes`, plus `sha256` when the tool is called with `attachment_sha256`.
     A reader that omits this field aborts the export — a manifest that was never
     asked for looks exactly like a mail with no attachments.
   - **`bodyEvidence`** per message: `textPartsUnreadable` and `textless`. Without
     it an empty body cannot be told apart from a body we failed to read, and the
     exporter refuses the corpus rather than guess. Hashing and text extraction
     both stay inside the already granted `gmail.readonly` scope; no consent and
     no new capability were added.
4. A filesystem snapshot/copy of the live Marveen SQLite is preferred. If the live file is used, the exporter still opens it `readonly` and asserts `PRAGMA query_only=ON`.
5. Output directory is local, encrypted/restricted as appropriate, and never committed to git.

## 1. Export immutable Personal + ZST source corpus

60-day anchor used for the 2026-08-16 baseline:

```bash
umask 077
python3 scripts/cos-replay-export-gmail.py \
  --start 2026-06-17 \
  --end 2026-08-17 \
  --out /secure/cos-replay/source-2026-08-16.json
```

The exporter:

- searches both `private` and `zst` connectors;
- searches Inbox and Sent;
- uses daily windows to avoid hidden pagination;
- refuses a day that hits `max_results`;
- expands each touched thread through a full-thread read tool;
- writes the corpus mode `0600`;
- performs no Gmail mutation.

The replay CLI separately validates export evidence and refuses a corpus if either account lacks proven full-thread read semantics.

## 2. Export production state read-only

Prefer a copied/snapshotted DB path:

```bash
npx tsx scripts/cos-replay-export-production-snapshot.ts \
  --db /secure/snapshots/marveen-2026-08-16.sqlite \
  --production-out /secure/cos-replay/production-cases.json \
  --zst-out /secure/cos-replay/zst-legacy.json
```

The exporter opens SQLite `readonly`, requires `fileMustExist`, sets and verifies `query_only=ON`, and contains no schema init/migration/write path.

## 3. Run shadow replay + reconciliation

```bash
npx tsx scripts/cos-clean-replay.ts \
  --source /secure/cos-replay/source-2026-08-16.json \
  --shadow /secure/cos-replay/shadow-2026-08-16.sqlite \
  --production-snapshot /secure/cos-replay/production-cases.json \
  --zst-legacy-snapshot /secure/cos-replay/zst-legacy.json \
  --report /secure/cos-replay/report-2026-08-16.json
```

Expected safety fields in the report:

```json
{
  "shadowOnly": true,
  "productionWrites": false,
  "externalWrites": false,
  "autoApplyAllowed": false
}
```

Exit code `2` means replay/reconciliation is not release-ready (for example P0/P1 findings). It is not a reason to auto-repair anything.

## 4. Review gate

Before any correction/canary:

- replay outcome = `PASS`;
- no source-completeness `UNKNOWN`;
- no unclassified finding;
- all P0/P1 findings explicitly resolved or dispositioned;
- production-authoritative human/receipt state preserved;
- Hertz/Sixt semantic deadline class correctly represented;
- Personal/ZST namespace mismatches reviewed, not auto-crossed.

## 5. ZST legacy rollout

The report contains migration candidates and batches:

`DRY_RUN → CANARY_2 → CANARY_5 → CANARY_10 → REMAINDER`

This version intentionally has **no automatic mutation command**. A future repair executor must consume an explicitly approved manifest, append a migration audit event, preserve case history/version semantics, and run acceptance+reconcile after every batch before the next batch is allowed.

No batch may:

- send email;
- transfer/pay money;
- sign or commit to a contract;
- auto-close a case from backfilled/migrated state.

## 6. Stability window

Only after the final migration/reconciliation gate is green may the 7-day unattended stability window begin. Any P1 silent failure resets the window. Eligibility never auto-promotes a progression mode; promotion remains an explicit owner/admin decision.
