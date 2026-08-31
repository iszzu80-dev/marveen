# E3 — the contradiction population, measured

```text
Written:   2026-08-31
Store:     live, 181 progression-enabled cases
Question:  Phase 2 readiness review §3.1 — "is 84% a real disagreement rate, or
           is the comparison itself mis-specified?"
Answer:    Both, in that order. 15 of the 152 were never disagreements at all
           (fixed). Of the 137 that remain, 106 compare two answers to two
           different questions.
```

---

## 1. What the number counted

`contradictionHealth` and Invariant E's `evidence_non_conflicting` both asked
`conflict_reason IS NOT NULL`. Broken down by `decided_by`:

| decided_by | count | is it a disagreement? |
|---|---|---|
| `POLICY` | 133 | yes — reader and policy reached different decisions |
| `CONFIDENCE` | 4 | yes — `arbitrate` marks it `conflict: true` |
| `INVALID_PACKET` | 15 | **no** — `arbitrate` marks it `conflict: false` |

`arbitrate`'s invalid-packet branch says it in its own comment: *"an unvalidated
packet is not a weaker opinion — it is not evidence"*. It returns
`conflict: false` and fills `conflictReason` with an explanatory note. The
boolean is never persisted; the note is. Every consumer re-derived the answer
from the note.

**Corrected: 137 of 181 = 0.76, not 0.84.** Fixed in
`packetIsContradictory` / `contradictorySql`, one predicate shared by both
consumers, no migration needed (`decided_by` already separates the branches).

The refusal did **not** loosen. `evidence_non_conflicting` split into two checks
and Invariant E fires on either, so an invalid packet still stops a non-read-only
action — under a name that is true.

---

## 2. What the remaining 137 are

Of the 133 `POLICY` conflicts, **106 are one shape**: the reader proposes a halt
and the deterministic policy answers `CONTINUE_AUTONOMOUSLY`.

That asymmetry is not two opinions differing about a case. Read the policy's own
reasons for those 106:

| reader said | policy said, because | n |
|---|---|---|
| ASK_INFORMATION | *Next action can be executed autonomously in shadow mode* | 27 |
| MANUAL_ACTION_REQUIRED | *Verification can proceed autonomously against available evidence* | 10 |
| WAIT_EXTERNAL | *Next action can be executed autonomously in shadow mode* | 9 |
| WAIT_EXTERNAL | *Verification can proceed autonomously against available evidence* | 7 |
| REQUEST_DECISION | *Verification can proceed autonomously against available evidence* | 7 |
| COMPLETE | *DoD not met (DoD is a generic status template, not this case's)* | 7 |
| ASK_INFORMATION | *Verification can proceed autonomously against available evidence* | 6 |
| ASK_INFORMATION | *Information gathering can proceed without external input* | 4 |

The last row is the clearest case. "Information gathering can proceed without
external input" and "we should ask Istvan for information" are not opposites —
**asking is a way of gathering**. Nothing about those two statements is
incompatible, and the pair is recorded as contradictory evidence that then
refuses every external action on the case.

The same holds for the largest group. *"Next action can be executed autonomously
**in shadow mode**"* is a statement about whether the engine can take its next
internal step with nothing reaching outside. *"MANUAL_ACTION_REQUIRED"* is a
statement about what the case needs from a person in the world. Both can be true
at once, and usually are.

**The two sides are answering different questions:**

- the deterministic policy answers *"can the engine take its next step on its
  own?"*
- the reader answers *"what does this case actually need next?"*

`arbitrate` treats any difference between those two answers as a conflict, and
POLICY wins. That rule is correct for a genuine disagreement — and there are
genuine ones in the population, e.g. reader `COMPLETE` against *"DoD not met"*
(a real dispute about whether the case is finished, and one where the policy's
parenthetical admits its own DoD is a generic template).

---

## 3. What this means for Phase 2

The review's entry condition asks for a measured explanation, and *either* a
reduced share *or* a documented reason why the current share is correct.

The measured explanation is above. The share is **not** correct as a measure of
unreliable evidence: fifteen of it was a mis-read field (now fixed), and the
bulk of the rest is a category comparison, not a disagreement. If external
actions were enabled today they would be refused on ~76% of the population — but
mostly for a reason that does not hold.

## 4. The decision this needs, and why it is not mine

Narrowing what counts as a conflict would unblock external action on a large
population. That is a safety-relevant loosening of Invariant E, and it is the
owner's call, not a refactor. Three options, stated plainly:

1. **Compare like with like.** Classify each decision on one axis (*does this
   require a person?*) and call it a conflict only when the two sides disagree
   on THAT. Largest reduction, and the most work; it changes what "contradictory
   evidence" means.
2. **Whitelist the compatible pairs.** e.g. reader `ASK_INFORMATION` against
   policy *"information gathering can proceed"* is not a conflict. Smaller,
   cheaper, and it accumulates exceptions — the shape that rots.
3. **Keep it as is, and say so.** The share stays ~0.76, Checkpoint E proceeds
   knowing external actions are refused on most cases, and the canary is
   deliberately drawn from the clean 27.

Recommendation: **1**, because 2 is a list nobody re-reads and 3 makes the
Phase 2 gate a formality. But 1 changes a safety predicate, so it starts with
Istvan saying which question the engine is supposed to be asking.

Nothing in this document was implemented beyond §1's correction.
