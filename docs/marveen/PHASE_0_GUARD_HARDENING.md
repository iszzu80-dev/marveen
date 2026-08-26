# Release-guard hardening — two closures, three refusals, three mutations

```text
Owner's Phase 0 closure decision, 2026-08-26:
  "Két release-guard closure kötelező a cutover előtt:
     1. Feeder guard ne csak tartalmat, hanem release provenance-t is bizonyítson.
     2. A guard maga ne mozgó develop kódból fusson; legyen pinned/immutable
        artifact, amelynek integritását a guardon kívüli egyszerű mechanizmus
        ellenőrzi.
   Ezeket külön, szűk guard-hardening változtatásként implementáld."
Scope: two files changed, one added. No behaviour outside the release gate.
```

---

## 1. Closure A — the feeder check proves provenance, not only content

**Before.** Check 4 hashed the pinned feeder against
`git show <releaseSha>:scripts/email-triage-fetch.py`. The rollback drill
measured what that misses: between `0011de922` and `1adf2a23` the feeder is
**byte-identical**, so a feeder release left behind at the OLD candidate passed
under the NEW one.

Behaviourally harmless — identical bytes run identically — but the guard's green
did not mean what the pin file says it means:

> "*functionally equivalent* is not *the same sha*, and the whole point of
> pinning is that the question has one answer."

**After.** The feeder release carries its own `.release-sha`, exactly as the
cycle release already did, and the guard checks the marker as well as the bytes.
Two independent ways to be wrong, two checks:

```bash
[ -n "$FEEDER_SHA" ] || fail "the pinned feeder release carries no .release-sha; ...
[ "$FEEDER_SHA" = "$RELEASE_SHA" ] || fail "pinned feeder declares release $FEEDER_SHA but the cycle release is $RELEASE_SHA"
```

---

## 2. Closure B — the gate is a pinned artifact, verified from outside itself

**Before.** `scripts/run-pinned-cos-cycle.sh` ran from `$REPO/scripts/`, i.e.
from the live checkout on `develop`. Every consumer it policed was pinned; the
policeman moved whenever develop moved — **including at the merge that precedes
a cutover.**

**After.** Two halves, each verifying the other, both digests in the pin:

| piece | where | verified by |
|---|---|---|
| `releases/guard-<sha>/run-pinned-cos-cycle.sh` | pinned release artifact, `guard-current` symlink | the preflight, against `pin.guardSha256` |
| `scripts/cos-cycle-preflight.sh` | stable path; ~20 lines, hash-and-exec only | the guard's check 5, against `pin.preflightSha256` |

The preflight is the "simple mechanism outside the guard": it hashes the guard
artifact and refuses (exit **91**) or execs it. It contains no policy — anything
that judges a release belongs in the guard, where it is pinned.

**Said plainly rather than dressed up:** nothing can verify itself, so this is a
closed circle, not an infinite chain of trust. Its boundary is write access to
the repository — anyone who can rewrite the pin *and* both scripts is already
past every gate here. What it buys is that a change to **either** half alone
fails loudly.

### 2b. A finding this produced, which was not in the plan

The drill could not build a guard artifact for the current pinned candidate:

```text
fatal: path 'scripts/run-pinned-cos-cycle.sh' does not exist in '0011de922…'
```

**The guard is not in the pinned runtime at all.** It entered the tree in
`fa88bb94`, after `0011de922` was cut. So a gate that rolled back with the
payload would roll back to *no gate*.

The invariant this forced, now explicit in the drill and in `deploy()`:

> **The gate is versioned independently of the payload.** A gate can only
> REFUSE, so carrying the stricter gate across a rollback cannot cause a bad
> release — only block one. The `.release-sha` marker the hardened gate requires
> is *deployment metadata* written for every candidate, including a rollback
> target, so an older payload does not become unrunnable under a newer gate.

That last sentence is the part that would otherwise have bitten during a real
rollback, and it was found by running the drill rather than by reading the code.

---

## 3. The three refusals the owner required

All from one run of `scripts/w14-rollback-drill.ts`, on a **180 MB copy of the
live store**, driving the **real preflight → real guard** chain:

```text
[PASS] 5b. feeder rolled back (identical BYTES, wrong release): guard REFUSES   expect=90 got=90
       "A and B ship a byte-identical feeder, so ONLY the .release-sha marker can tell them apart"
[PASS] 5b-reason. the refusal names the feeder RELEASE, not its bytes          expect=true got=true
[PASS] 5c. correct consumers/pin, MUTATED guard artifact: PREFLIGHT refuses    expect=91 got=91
[PASS] 5d. hardened guard REMOVED: PREFLIGHT refuses                           expect=91 got=91
[PASS] 5e. MUTATED preflight: the guard refuses (the circle closes)            expect=90 got=90
```

The drill asserts on **which** of the two refused (90 = guard, 91 = preflight),
not merely that something said no. "It refused" is a weaker claim than "the
right check refused".

Full run: **15 steps, 0 failed, `ok: true`** — including the unchanged
rollback assertions (store integrity `ok`, 119/71 cases before and after).

---

## 4. The three mutations — each hardening check is load-bearing

The owner's third requirement is that removing or mutating the hardened guard
must make the **drill** fail. Measured, one mutation at a time:

| mutation | drill result |
|---|---|
| feeder `.release-sha` checks removed from the guard | `5b` FAIL (`expect=90 got=0`), `5b-reason` FAIL — the identical-bytes case passes again, exactly as before the hardening |
| preflight cross-check removed from the guard | `5e` FAIL (`expect=90 got=0`) |
| guard-integrity checks removed from the preflight | `5c` FAIL (`expect=91 got=0`), `5d` FAIL (`expect=91 got=127`) |

Every mutation drives `ok: false`. A hardening whose removal leaves the drill
green would be decoration.

---

## 5. One consequence of the fresh-boot lock, found here and fixed

The first migration proof after the bootstrap lock landed left a
`.merge-proof-<ts>.db.bootlock` behind in `store/backups/`: the proof deletes
its temporary store and its `-wal`/`-shm`, and the lock's sidecar was not on
that list. Fixed in `scripts/w14-merge-migration-proof.ts`, and the stray file
removed.

Small, but it is a real side effect of a change made elsewhere, so it is written
down rather than tidied away silently. (Tests are unaffected: they build
temporary stores inside `mkdtemp` directories that are removed wholesale.)

---

## 6. What this change does NOT do

- It does not make the gate stronger against someone with repository write
  access (§2).
- It does not change the cycle, the store, the dashboard, or any product
  behaviour. Two files changed, one added, all inside the release gate.
- It does not retro-fit `.release-sha` into feeder releases that already exist
  on disk. The cutover procedure writes it for whichever candidate it deploys,
  including a rollback target — which is what makes an older payload still
  runnable under the newer gate.
