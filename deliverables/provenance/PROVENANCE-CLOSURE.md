# Runtime build provenance — closure

**Candidate: `afaf354a95e472b6d6b62804b98caaff97129875`**, tag
`checkpoint-e/candidate-afaf354a9`.

## The defect, in one sentence

`cos-pinned-cutover.sh` built the runtime with `npm run build` **inside the
shared checkout**, which sits on develop — so a clean cutover of `a8c22955`
produced a `dist` built from develop while the pin declared `a8c22955`, and
nothing could see it, because `run-pinned-cos-cycle.sh` sets `RUNTIME_SHA` by
reading `activationCandidateSha` **out of the pin file** and compares it to the
release's `.release-sha`. Both sides descend from the same declaration.

> **THE PIN DECLARES, THE ARTIFACT PROVES.**

## The owner's nine requirements

| # | requirement | how |
|---|---|---|
| 1 | build source is the immutable artifact | `build-release-dist.ts` compiles only inside `releases/cos-cycle-<short>/`, extracted by `git archive`. The shared checkout is never a build source. |
| 2 | durable build provenance | `.build-provenance.json` written **into the dist** by the build: `sourceSha`, `releaseId`, `sourceTreeHash`, `distHash`, file count, timestamp, builder. Before compiling, the builder measures the release dir's source against a fresh `git archive <sha>`. After compiling it verifies its own output. |
| 3 | cutover installs only a proven artifact | fails closed at four points: no build tooling in the candidate; build/self-verify failure; the built dist does not prove the sha; the **installed copy** does not prove it. |
| 4 | readback measures the deployed artifact | `verify-runtime-provenance.ts` recomputes the dist digest from the deployed files and cross-checks the manifest against git. `--expect-from-pin` takes only the *expectation* from the pin. |
| 5 | the pin is a declaration | it is never evidence; every verdict above is computed from files. |
| 6 | rollback from preserved artifacts | `cos-rollback-runtime.ts` installs preserved bytes and **never rebuilds**. Pre-provenance artifacts need `--accept-unproven-legacy "<reason>"`, and the reason is stamped into the pin. |
| 7 | negative controls | ten, all red — see below. |
| 8 | positive control | build → deploy → measure → match, in tests and on a real artifact. |
| 9 | local first, one CI | all of the above ran locally; one exact-SHA CI on the final sha. |

## The manifest does not certify itself

The first cut of the tests had the owner's fourth control (*"manifest/source SHA
manipulált"*) **passing**, recorded as a documented limit: a rewritten `sourceSha`
leaves every hash consistent, because the dist digest was computed over bytes
that did not change.

That was not good enough, and it is closed. `verifySourceShaAgainstGit`
recomputes `sourceTreeHash` from `git archive <sourceSha>`; a manifest that claims
commit A while carrying B's source digest fails with `MANIFEST_FORGED`. Verified
on a real artifact: hash check passes, cross-check refuses, overall verdict false.

## Two defects found by running the refusals against real infrastructure

1. **The cutover called the shared checkout's build script.** The same mistake one
   level up — a build script that moves with develop cannot vouch for a pinned
   artifact, and on a checkout predating this work it does not exist at all. The
   cutover now runs the artifact's own `scripts/`, extracted by the same
   `git archive` as its `src/`, exactly as the guard is already pinned.

2. **A refused cutover left the pointers already moved.** They swapped at step 4
   and the build was step 5, so a refusal aimed `cos-cycle-current` at a candidate
   the pin does not name — the guard's check 1 then fails and the CoS cycle stops.
   **That is the 2026-08-26 incident shape, reached by the script written to avoid
   it.** Found by running the new refusal against `a8c229552`, which ships no build
   tooling. Fail closed now means *nothing changed*: every step that can refuse
   runs while the pointers still aim at the outgoing release. Re-verified — the
   refusal prints no "pointers moved", the links are unchanged, the gate stays green.

## Controls

**Unit (18 tests, `release-provenance.test.ts`)** — positive: build → deploy →
measure → match, and the manifest does not hash itself. Negative: pin A + dist B;
a develop build passing as the candidate; missing provenance; a forged manifest
(caught by the git cross-check); an honest manifest passing the same check; a
commit git has never heard of; dist modified / added to / removed from after the
build; a rollback artifact that is the wrong sha; an unreadable manifest; a future
schema. Plus: the source digest is a property of the tree, not the walk — same
files in a different directory hash the same, a one-byte change and a **move** both
change it.

**Mutation (6, all red)** — dist hash not recomputed (3 red); missing manifest
treated as fine (1); expected-sha comparison dropped (3); git cross-check accepts
a mismatch (1); unresolvable commit treated as OK (1); tree hash ignores the path (1).

**Live, on real artifacts built from git** — positive: source verified against git
`afaf354a9`, 1075 files, self-verified, `ok=True` with both checks. Negative:
`SOURCE_MISMATCH` on the wrong expectation; `TAMPERED` on one edited built file;
`MANIFEST_FORGED` on a forged manifest whose hash check passes; `BUILD REFUSED` on
an edited release dir, before anything is compiled; `CUTOVER REFUSED` on a
candidate with no build tooling, leaving the pointers untouched.

## Measured on the runtime that is live right now

```
{"dist":"/home/iszzu/marveen/dist","ok":false,
 "hashCheck":{"failure":"MISSING","detail":"no .build-provenance.json ..."}}
```

Correct, and honest: `a8c22955`'s dist was installed **by hand** earlier tonight,
so it carries no manifest. It gains one at this candidate's own cutover — which is
the positive control on production.

---

# The positive control on production (2026-08-31 22:37)

**Deployed: `afaf354a95e472b6d6b62804b98caaff97129875`.** Exact-SHA CI run
`33435475567` **success** (release-gate green, kernel-contract ENFORCED).
Previous pin `a8c229552`.

The cutover ran the new path end to end and the deployed artifact proves itself:

```
pin DECLARES: afaf354a95e472b6d6b62804b98caaff97129875
hashCheck      ok   artifact proves afaf354a9... (1075 files, dist f0ff8359f099ac43)
gitCrossCheck  ok   sourceSha afaf354a9 confirmed against git
measured       sourceSha  afaf354a95e472b6d6b62804b98caaff97129875
               distHash   f0ff8359f099ac43a41049ca9622771b92e207c3b4d8d46011f02f852f20781f
               files      1075
               releaseId  cos-cycle-afaf354a9
```

**This is the first time a deployed runtime has said which commit it came from.**
Both sides of the comparison are now independent: the pin supplies the
expectation, the files supply the evidence.

Live after the restart: gate OK with `releaseSha == runtimeSha == afaf354a9`,
pinned cycle `problems: []` with every step SUCCESS, 0 open batches, 0
`LOCAL_APPLIED`, connectors all OK. CRITICAL: only `output_floor_breached`
(shadow mode, expected). WARNING includes `checkpoint_not_a_position`, which is
the check added in the previous candidate, correctly reporting the
pre-2026-08-13 triage stamp.

## The rollback is REFUSED right now, and that is the correct answer

```
rollback target a8c229552
  preserved artifacts found: 4
  unproven: releases/cos-cycle-a8c229552/dist        MISSING
  unproven: dist.pre-a8c229552-20260831T223635       MISSING
  unproven: dist.pre-a8c229552-20260831T221555       MISSING
  unproven: dist.pre-a8c229552-20260831T221434       MISSING
ROLLBACK REFUSED: no artifact PROVES a8c229552.
```

**There is currently no provably-rollback-able target.** Every preserved artifact
predates build provenance, so none carries a manifest. This is stated plainly
rather than smoothed over: the guarantee is new, and it cannot apply retroactively
to bytes that were built before it existed.

The escape works and was exercised in dry run — `--accept-unproven-legacy` with a
written reason selects `releases/cos-cycle-a8c229552/dist`, which is the genuine
a8c229552 build, and stamps the reason into the pin. So the rollback path is
usable tonight; it is simply honest about what it can and cannot prove.

**The first PROVEN rollback target will be `afaf354a9` itself**, the moment a
later candidate replaces it.
