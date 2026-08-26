# Rollback proof — the CODE layer, drilled in isolation

```text
Phase 0 owner gate, 2026-08-26: "production-equivalent isolated rollback drill
ugyanazzal a release artifact/pin/store/consumer alignmenttel."
Drill:  scripts/w14-rollback-drill.ts
Run:    2026-08-26, from 0011de922 -> 1adf2a23 -> back to 0011de922
Result: ok:true, 11 steps, 0 failed — and two findings the drill was not
        looking for (§4). Those are the reason it was worth running.
```

---

## 1. What was unproven, and why it stayed that way

W14 shipped the runbook with three layers. DATA (restore) and BEHAVIOUR
(canary) were exercised by automated drills. CODE said:

> previous `dist` snapshot or `git reset --hard` + rebuild + restart —
> **practice (existing `dist.pre-*` snapshots) — not exercised in this packet**

The reason was not laziness: exercising it live meant restarting the owner's
dashboard at 02:00, and **a drill that causes the outage it prevents is not a
drill.** The gate's answer was to demand an isolated drill instead, with a live
quiet-window drill only if isolation cannot prove it honestly.

---

## 2. What makes the drill production-equivalent

Not a simulation of the topology — the topology, built the way production builds
it:

| element | in production | in the drill |
|---|---|---|
| repo | `~/marveen` | a `git clone --local --shared --no-checkout` of it, so `git show <sha>:path` resolves identically |
| release | `releases/cos-cycle-<sha>/` from `git archive <sha>` | same, same command |
| consumers | cycle release, pinned feeder, `*-current` symlinks | same three, moved together |
| pin | `releases/dashboard-runtime-pin.json` | same file, same field |
| store | `store/claudeclaw.db`, symlinked into the release | **a real 180 MB copy of the live store** (119 personal + 70 ZST cases), symlinked into the release the same way |
| **guard** | `scripts/run-pinned-cos-cycle.sh` | **the same script**, run with `MARVEEN_REPO_ROOT` at the mirror |

The last row is the one that matters. The drill does not reimplement the four
checks; a reimplementation would drill the drill. It runs the real guard and
reads its exit code.

**Safety first, and asserted rather than assumed.** Step 1 compares the mirror
store's inode with the live one and aborts if they match. A drill that could
write to production is worse than no drill.

```text
[PASS] 1. mirror store is isolated from the live store   live=36036 mirror=919782
```

---

## 3. The drill

```text
[PASS] 1. mirror store is isolated from the live store    different-inode
[PASS] 2. store baseline readable                         ok  personal=119 zst=70
[PASS] 3. candidate A deployed, guard accepts             exit 0
[PASS] 4. rolled forward to B, guard accepts              exit 0
[PASS] 5a. pin rolled back, consumers not: guard REFUSES  exit 90, reason names the sha mismatch
[PASS] 5b. feeder rolled back, cycle not                  see §4.1
[PASS] 6. full rollback to A, guard accepts               exit 0
[PASS] 7a. running release content == A                   sha256 027640ce…
[PASS] 7b. ...and is NOT B                                differs
[PASS] 8a. store integrity after rollback                 ok
[PASS] 8b. case counts unchanged by the code rollback     119/70 -> 119/70
ok: true
```

Step **5a** is the half of the drill that earns it. A rollback that moves the
pin and forgets a consumer is not hypothetical — **the first real cutover made
exactly that mistake**, and the pin file carries its own correction note about
it. The drill shows the guard catches it rather than assuming so.

Step **7** proves the code moved by CONTENT, not by label: the deployed
`cos-cycle.ts` hashes to A's version and not to B's. A `.release-sha` marker
saying "A" would prove nothing about what is in the directory.

Step **8** proves a code rollback leaves the data alone — the same 119/70 case
counts, `integrity_check` still `ok`, on a store that is a real copy rather than
a fixture.

### 3b. The drill can fail

Neutering the guard's first check (`RELEASE_SHA = RUNTIME_SHA`) and re-running:

```text
[FAIL] 5a. pin rolled back, consumers not: guard REFUSES   expect=90 got=0
ok: false
```

So the green run above is green because the guard works, not because the drill
is lenient.

---

## 4. Two findings the drill was not looking for

### 4.1 The guard's feeder check proves CONTENT, not PROVENANCE

Check 4 compares the pinned feeder's sha256 against
`git show <releaseSha>:scripts/email-triage-fetch.py`. Between `0011de922` and
`1adf2a23` that file is **byte-identical**, so a feeder release left behind at
the OLD candidate satisfies the check under the NEW one:

```text
[PASS] 5b. feeder rolled back, cycle not: guard REFUSES
       expect=0 got=0
       "A and B ship an IDENTICAL feeder, so no hash check can tell them apart"
```

The drill records this as a PASS because exit 0 is the *correct* behaviour for a
content check — and that is exactly the point. The pin file's stated philosophy
is stronger than what this check enforces:

> "Functionally the diff was test-file + feeder only, but *functionally
> equivalent* is not *the same sha*, and the whole point of pinning is that the
> question has one answer."

Check 4 currently answers the weaker question. **Behaviourally this is harmless**
— identical bytes run identically — but "the three consumers are on the same
sha" is not what it verifies, and the difference matters the moment somebody
reasons from the guard's green to a claim about provenance.

Proposed fix (NOT applied here — see §5): give each feeder release a
`.release-sha` marker, as the cycle release already has, and have check 4
compare that as well as the content.

### 4.2 The guard that enforces the pin is not itself pinned

`scripts/run-pinned-cos-cycle.sh` is executed from `$REPO/scripts/`, i.e. from
the live checkout, which sits on `develop`. Every consumer it polices is pinned
to an exact sha; **the policeman moves whenever `develop` moves.** A merge to
`develop` changes the guard without any cutover, and the guard would still
report OK on the old pinned candidate.

Nothing has gone wrong because of this and it is not a hole in the pin: the
guard can only ever *refuse*, so a changed guard cannot smuggle in a wrong
runtime. But a reader who believes "everything in this chain is pinned" believes
something that is not true, and the fix (pin the guard alongside the cycle
release, or hash it in the readiness check) is cheap.

---

## 5. What is deliberately not changed here

Both findings in §4 are about **the guard that decides whether a cutover is
legitimate.** Changing it quietly, inside the preparation for that same cutover,
is the wrong shape of act regardless of how small the change is. They are
written up as owner decisions in `PHASE_0_CUTOVER_READINESS.md` rather than
applied.

---

## 6. What is still not proven, honestly

`systemctl --user restart marveen-dashboard.service` is not exercised by this
drill, and cannot be without restarting the live service. What the drill proves
is everything up to it: the artifacts, the pin, the consumer alignment, the
guard's accept and refuse, and that the data survives.

The restart itself is the least novel step in the chain — the install performs
it routinely — and the runbook already records its two measured consequences
(the owner's browser session is logged out; `/api/costs/*` can hang ~12 s while
SQLite checkpoints the WAL). **It also carries the one instruction that must not
be forgotten: never boot-smoke-test `dist/index.js` on the live port — it takes
the port and pidfile from the running service and kills it.**

If the owner wants that step covered too, it is a quiet-window rehearsal of a
single command, and it should be announced rather than folded into a cutover.
