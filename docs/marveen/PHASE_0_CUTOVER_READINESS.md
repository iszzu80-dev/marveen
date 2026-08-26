# Phase 0 — controlled cutover readiness

```text
Phase 0 owner gate, 2026-08-26:
  "Készítsd elő és a dokumentált multi-consumer cutover eljárás szerint hajtsd
   végre CSAK explicit go-live jóváhagyás után."
  "A cutover elfogadása runtime evidence legyen, ne merge-status."

Status: PREPARED. NOT EXECUTED. Nothing in this document has been run against
        the live install; the drill in §6 ran entirely on a copy.
```

---

## 0. What this document is, and the one thing it is not

It is the runnable procedure, its evidence requirements, and its stop
conditions. **It is not permission.** No step below is executed until the owner
says go-live, and the two decisions in §3 are the owner's to make first, because
both concern the guard that decides whether a cutover is legitimate.

---

## 1. What must happen before a candidate can exist

The Phase 0 closure work sits on `feat/w14-fresh-boot-single-writer`, not on
`develop`. It carries:

* the fresh-boot single-writer bootstrap + its proof (`W14_FRESH_BOOT_PROOF.md`)
* the isolated rollback drill + its proof (`W14_ROLLBACK_PROOF.md`)
* the staging parity matrix (`W14_STAGING_PARITY_MATRIX.md`)

**Suite on the branch: 581 files / 7768 tests / 4 skipped, 0 failures.**
Baseline on `develop` for comparison: 580 / 7765, 0 failures. The one added file
is the fresh-boot guard.

> One honest note about that run. An earlier full-suite run on this branch showed
> `memory-performance.test.ts` timing out at 5 s on a case that takes 1075 ms
> alone and calls a live local Ollama. It passed on the re-run and on the
> `develop` baseline, and the changed code cannot reach it (the lock is skipped
> entirely for `:memory:`, which is what that suite uses). Recorded as a
> load-dependent flake against a real local service, **not** claimed as green
> the first time.

Merging this branch is a §1.5 merge-gate act with its own four conditions, and
it is a separate decision from go-live.

---

## 2. The seven artefacts, and what each must prove

The owner's list, with the evidence that discharges each. Nothing here is
satisfied by "it built".

| # | artefact | evidence required |
|---|---|---|
| 1 | **candidate SHA** | one sha, named, existing in `origin`/`fork` history — not "develop's head at the time" |
| 2 | **CI proof on the SAME sha** | `.github/workflows/tests.yml` green for both `push` and `pull_request` **on that exact sha**. The pin file has a `ciEvidence` field for exactly this |
| 3 | **dashboard `dist`** | built FROM that sha, and the previous `dist` kept as `dist.pre-<sha>-<stamp>` |
| 4 | **cos-cycle release archive** | `releases/cos-cycle-<sha>/` from `git archive <sha>`, `.release-sha` written, `store`+`node_modules` symlinked, `cos-cycle-current` moved |
| 5 | **pinned triage feeder** | `releases/scheduled-scripts-<sha>/`, `scheduled-scripts-current` moved |
| 6 | **runtime/store/pin guard** | `run-pinned-cos-cycle.sh --verify-only` → exit 0, **after** 3–5 have all moved |
| 7 | **post-cutover live readback** | §5 — and this is the acceptance, not step 6 |

**The consumers move together or not at all.** The pin file's own correction
note records what happens otherwise: the first cutover deployed `dist` from one
sha, advanced the feeder to another, and left two consumers on two SHAs.
Functionally the diff was test files plus the feeder — and the note's own
verdict is the rule this cutover follows: *"functionally equivalent" is not "the
same sha"*.

---

## 3. Two owner decisions, both about the guard

Found by the rollback drill (`W14_ROLLBACK_PROOF.md` §4). **Deliberately not
fixed by me**: changing the gate while preparing to pass it is the wrong shape
of act, however small the change.

### 3.1 The feeder check proves content, not provenance

Guard check 4 hashes the pinned feeder against
`git show <sha>:scripts/email-triage-fetch.py`. Between `0011de922` and
`1adf2a23` that file is byte-identical, so a feeder left at the OLD candidate
passes under the NEW one. The drill demonstrated it.

*Harmless behaviourally* — identical bytes run identically — but the guard's
green does not mean "all three consumers are on this sha", which is what the pin
exists to assert.

**Option A** (recommended): give each feeder release a `.release-sha` marker and
have check 4 compare it too. Small, contained, and makes the guard's claim match
its description.
**Option B**: leave it, and correct the guard's stated purpose to "content
agreement" so nobody reasons from it to provenance.

### 3.2 The guard that enforces the pin is not itself pinned

`scripts/run-pinned-cos-cycle.sh` runs from `$REPO/scripts/`, i.e. from the live
checkout, which sits on `develop`. Every consumer it polices is pinned; the
policeman moves whenever `develop` moves — including at the merge in §1, before
any cutover.

This is not a hole in the pin (the guard can only ever *refuse*), but "the whole
chain is pinned" is currently false.

**Option A** (recommended): record the guard's sha256 in the pin file and have
the readiness check compare it, so a changed guard is visible.
**Option B**: pin the guard alongside the cycle release and invoke it from
there.
**Option C**: accept and document.

---

## 4. The procedure

Executed only on explicit go-live. `<SHA>` is the candidate from §2.1.

```bash
cd ~/marveen
# 0. refuse to start on a dirty or unexpected tree
git status --porcelain | head          # must be empty of src/ changes
git rev-parse HEAD                     # must equal <SHA>

# 1. keep the old runtime before anything replaces it
cp -r dist "dist.pre-$(git rev-parse --short=9 HEAD)-$(date +%Y%m%dT%H%M%S)"

# 2. build the dashboard runtime FROM the candidate
npm run build

# 3. cycle release
git archive <SHA> scripts src package.json tsconfig.json | \
  (mkdir -p releases/cos-cycle-<short> && tar -x -C releases/cos-cycle-<short>)
printf '%s\n' <SHA> > releases/cos-cycle-<short>/.release-sha
ln -s ~/marveen/store        releases/cos-cycle-<short>/store
ln -s ~/marveen/node_modules releases/cos-cycle-<short>/node_modules
ln -s ~/marveen/.env         releases/cos-cycle-<short>/.env

# 4. feeder release
git archive <SHA> scripts/email-triage-fetch.py | \
  (mkdir -p releases/scheduled-scripts-<short> && tar -x -C releases/scheduled-scripts-<short>)
cp releases/scheduled-scripts-<short>/scripts/email-triage-fetch.py \
   releases/scheduled-scripts-<short>/

# 5. move the pointers TOGETHER, then the pin
ln -sfn releases/cos-cycle-<short>          releases/cos-cycle-current
ln -sfn scheduled-scripts-<short>           releases/scheduled-scripts-current
$EDITOR releases/dashboard-runtime-pin.json   # activationCandidateSha, deployedAt,
                                              # previousRuntime, ciEvidence

# 6. the guard, BEFORE the restart
bash scripts/run-pinned-cos-cycle.sh --verify-only   # must exit 0

# 7. restart
systemctl --user restart marveen-dashboard.service
until curl -s -o /dev/null -w '%{http_code}' localhost:3420/api/kanban | grep -qE '200|401'; do sleep 1; done
```

**Never** boot-smoke-test `dist/index.js` on the live port to "check the build
first": it takes the port and the pidfile from the running service and kills it
(~15 s outage, measured 2026-08-08).

Expect, and do not mistake for failure: the restart **logs the owner's browser
session out** (send the re-auth link afterwards), and `/api/costs/*` can hang
~12 s while SQLite checkpoints the WAL.

---

## 5. Acceptance — runtime evidence, not merge status

The cutover is accepted only when every line below is true **on the live store**.

### 5.1 The tables that prove W10–W14 are actually running

The same read-only query that produced the NO-GO verdict. Today all four are
absent.

```sql
SELECT name FROM sqlite_master WHERE type='table'
  AND name IN ('cos_disclosure_records','cos_recovery_queue',
               'migration_ledger','store_schema');
-- expect: 4 rows
```

### 5.2 The consumer check — the detector this codebase actually needs

```sql
SELECT count(*) FROM cos_feature_runs;   -- must gain rows within ONE cycle
```

`cos_feature_runs` held **zero rows for months** while `recordFeatureRun`
existed, was exported, and had tests. Existence of the table proves the
migration; **rows** prove the writer. Three separate W10–W14 findings had this
exact shape — correct code with no consumer — so this is the check that would
have caught all three.

### 5.3 Staging-parity mitigations (from `W14_STAGING_PARITY_MATRIX.md` §2)

```bash
# auth path — must discriminate in BOTH directions
curl -s -o /dev/null -w '%{http_code}\n' localhost:3420/api/kanban                      # 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(cat store/.dashboard-token)" \
     localhost:3420/api/kanban                                                          # 200
# observability
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
     localhost:3420/api/cos/monitoring | head -c 400   # staleRuns + unverifiedCompletions present
```

```sql
-- policy engine: prove the caller exists, by its output
SELECT count(*) FROM cos_disclosure_records;   -- must move off 0 as decisions occur
```

### 5.4 The first scheduled cycle after the cutover

`problems: []` **from the pinned cycle**, with the guard's four checks OK. A
`problems: []` from an unpinned cycle is a different statement — that is why the
wrapper exists.

### 5.5 Stop condition

If §5.1 or §5.2 fails, **roll back rather than investigate forward**. The
procedure is drilled (`W14_ROLLBACK_PROOF.md`) and its data safety is measured:
a code rollback left 119/70 cases and `integrity_check: ok` untouched.

---

## 6. What has already been proven, and on what

| claim | proven on | where |
|---|---|---|
| the migration does not lose data | a **copy of the live store**, 189 MB, 119 cases | `w14-merge-migration-proof.ts` |
| all three consumers move together, and the guard refuses when they do not | a **copy of the live store**, 180 MB, real guard | `W14_ROLLBACK_PROOF.md` §3 |
| a code rollback leaves the data alone | same copy: 119/70 before and after, integrity ok | `W14_ROLLBACK_PROOF.md` §3 step 8 |
| a concurrent first boot cannot corrupt a fresh store | 4–6 real processes, ledger with zero overlapping intervals | `W14_FRESH_BOOT_PROOF.md` |

**Not proven, and not claimable from any of the above:** that
`systemctl --user restart` brings the dashboard back. That is the one step no
isolated drill can cover, it is the step the install performs routinely, and its
two known consequences are recorded in §4.

---

## 7. Post-cutover reconciliation — and a correction to the count

> Owner: *"A két 2026-08-10-i APPLIED_UNVERIFIED sort a cutover után
> VERIFY/READBACK úton reconciliáld. Semmilyen körülmények között ne legyen
> blind resend."*

**There are three, not two.** Measured read-only on the live store on
2026-08-26:

| ledger | ledger_id | recipient | applied_at (CEST) |
|---|---|---|---|
| `outbound_ledger` | `ob-mv-PRI-CLAIM-2026-001-EMAIL_SEND-1` | reklamacio@modivo.hu | 2026-08-10 00:32:52 |
| `outbound_ledger` | `ob-mv-case-private-19fe78e382f4c02c-EMAIL_SEND-1` | zoltan@drvamosi.hu | 2026-08-10 08:11:40 |
| `zst_outbound_ledger` | `ob-mv-zst-moved-19fe78e382f4c02c-EMAIL_SEND-1` | zoltan@drvamosi.hu | 2026-08-10 05:04:57 |

The third is in the **ZST** namespace, which is why the earlier report said two.
The §8.6 metric itself is correct — `unverifiedCompletions` reads both ledgers —
so this was an error in my report, not in the code.

### 7.1 The readback evidence already exists

All three rows carry an `external_ref`, and all three resolve to real sent
messages (read-only Gmail probe, 2026-08-26):

| ledger_id | external_ref | resolves to |
|---|---|---|
| `…PRI-CLAIM…` | `19fe8a852cb958f0` | private → reklamacio@modivo.hu, 2026-08-09 15:32:53 −0700 |
| `…case-private…` | `19fea4c5d685c674` | private → zoltan@drvamosi.hu, 2026-08-10 02:11:40 −0400 |
| `…zst-moved…` | `19fe9a16d13cf48a` | **ZST** → zoltan@drvamosi.hu, 2026-08-09 22:04:58 −0500 |

Cross-account probes return nothing, which is the connector boundary behaving
correctly.

**So all three sends provably happened.** These rows are unverified, not
unsent — the distinction the ledger was built to preserve.

### 7.2 The two messages to the same lawyer are NOT a duplicate

Two rows, same recipient, same subject, three hours apart, different sender
identities. That reads as a double-send until the bodies are compared:

> *"Elnézést kérek, az előző válaszomat véletlenul a céges címemről küldtem. A
> továbbiakban erről a címről írok."*

The second message is a **deliberate correction** of the first, sent from the
private address on purpose. Two intended messages, not one sent twice.

This is written down because a plausible reading of the metadata alone —
"duplicate send during the personal→ZST migration" — would have been wrong, and
would have been reported as an incident.

### 7.3 The reconciliation, and why it cannot resend

Run `verifyAction(db, adapter, <ledgerId>, now)` per row, with the live
`GmailApiTransport` — the ZST row against the **ZST** connector, the two
personal rows against the private one.

`verifyAction` **sends nothing**: it calls `adapter.readback` and writes a
status. `executeAction` is the only path that can send, and it is not used here.
That is a property of the code, not a promise about how I will run it.

The adapter's F-12 fallback is what makes these rows resolvable: the
`X-Marveen-Idempotency-Key` search reports `available:false` (no marker was
embedded on the live path), and it then asks the provider about the recorded
`external_ref` via `getById` — which §7.1 has already shown succeeds for all
three. Expected result: `found:true` → **VERIFIED**, with `verified_at` set.

**One caution that must not be skipped.** If the readback ran and reported
*not found*, `verifyAction` would move a 16-day-old row to `RECOVERY_REQUIRED`,
because the grace window has long passed. That is correct behaviour and must not
be worked around by editing the row. Given §7.1, it should not happen — but the
run must be done one row at a time, with the outcome read back, rather than in a
loop that assumes the happy path.

**Never a resend.** Beyond the code path: a resend would have delivered a second
complaint to Modivo and a third copy of an already-corrected letter to the
lawyer.
