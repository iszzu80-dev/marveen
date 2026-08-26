# Phase 0 release incident — the merge stopped the live CoS cycle

```text
Recorded on the owner's instruction, 2026-08-26.
Severity: one missed scheduled cycle (~4 minutes). No data loss, no wrong action.
Classification: NOT a new Phase 0 blocker — but the post-cutover proof must show
                the guard can no longer move on an ordinary develop merge.
```

---

## 1. What happened

| time (CEST) | event |
|---|---|
| 15:47 | `feat/w14-fresh-boot-single-writer` merged into `develop` (`36f830ef`) |
| 15:47 | the live scheduled cycle's guard began refusing: `REFUSED — the pinned feeder release carries no .release-sha` |
| ~15:51 | refusal noticed while verifying the merge |
| 15:51 | live feeder's provenance **verified**, marker written, guard green |
| 15:52 | full pinned cycle run end to end, `problems: []` |

One scheduled run was missed. Nothing was executed wrongly; the guard failed
**closed**, which is what it is for.

---

## 2. Root cause

**A moving, develop-based guard was changed before the guard was pinned.**

The release gate is meant to be a pinned artefact. Until the cutover it is not:
`scripts/run-pinned-cos-cycle.sh` runs from `$REPO/scripts/`, i.e. from the live
checkout on `develop`. The merge that *introduced* the hardening therefore also
*deployed* it — instantly, to production, with no cutover.

The hardened check requires every feeder release to declare its provenance
(`.release-sha`). The feeder release that had been running since 2026-08-24
carried no such marker, because the marker did not exist when it was built. So
the new gate correctly refused a release the old gate had accepted.

**This is the exact hazard the hardening exists to remove, and it bit one round
before the fix could take effect.** It was documented as finding 3.2 the day
before it happened, which is the only reason it was recognised in minutes rather
than found by a silent gap in the case board.

---

## 3. Recovery — verified, not assumed

The tempting fix was to write the marker and move on. Instead the provenance was
**established first**:

```bash
git show 0011de922:scripts/email-triage-fetch.py | sha256sum
  → 15d6c05f7856451cf43217a384f5e671ec032210560fe3fbb3c6843ba8a3af26
sha256sum releases/scheduled-scripts-current/email-triage-fetch.py
  → 15d6c05f7856451cf43217a384f5e671ec032210560fe3fbb3c6843ba8a3af26
```

The live feeder *is* byte-for-byte the one from `0011de922`. Only then was the
marker written. What went into that file is a measurement, not a claim — which
matters, because a marker asserting the wrong release would have converted a
loud outage into a quiet lie about what is running.

Post-recovery, the guard reports:

```json
{"pinnedCycle":"OK","releaseSha":"0011de922…","feederRelease":"0011de922",
 "preflightCheck":"SKIPPED_PIN_DECLARES_NO_PREFLIGHT","storeInode":"36036"}
```

---

## 4. A second defect the incident exposed

While confirming the recovery, the hardened guard turned out to **silently skip**
the preflight cross-check on a pin written before the hardening (no
`preflightSha256`). The tolerance is correct — the live cycle must survive the
merge — but a check that is absent looked exactly like one that passed.

That is this codebase's signature defect, and producing a fresh instance of it
*inside the fix for it* would have been the worst available outcome. The guard
now states which happened, every run:

```text
preflightCheck: verified | SKIPPED_PIN_DECLARES_NO_PREFLIGHT
```

Fixed in `3d0cbcd1`, which is why the release candidate moved from the merge
commit.

---

## 5. Preventive control, and how it must be PROVEN

The control is the guard hardening itself: from the cutover onward the gate is an
immutable pinned artefact (`releases/guard-current/`), verified by a preflight
against `pin.guardSha256`, and the preflight is verified by the guard against
`pin.preflightSha256`.

**A control nobody has driven is a belief.** The post-cutover proof must
therefore show, on the live install:

1. `preflightCheck: verified` in the guard's OK line — i.e. the pin now declares
   a preflight and the check actually ran (today it truthfully says SKIPPED);
2. `releases/guard-current` resolves to a `guard-<sha>` directory whose content
   hashes to the pin's `guardSha256`;
3. **an ordinary develop merge does not change what the gate runs** — the
   discriminating check, since that is precisely what failed here. Concretely:
   after the cutover, a change to `scripts/run-pinned-cos-cycle.sh` on `develop`
   must leave the live gate's behaviour untouched, because the live gate is read
   from the pinned artefact and not from the checkout.

Point 3 is the one that would go unnoticed if the acceptance only checked that
the gate is green. Green was never the problem; **moving** was.

---

## 6. What this incident is not

It is not a data incident: no case was written, no message sent, no store
mutated. It is not a false green either — the gate refused loudly and named its
reason, which is why the recovery took minutes.

It is a **release-process** incident, of the class this whole Phase 0 closure
exists to end: the thing that judges a release was itself unversioned.
