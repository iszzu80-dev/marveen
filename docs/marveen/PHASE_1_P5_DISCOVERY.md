# Phase 1 / P5 — the two questions the audit could not answer

```text
MIP-v1.0 §10.7 and audit §3.6/§3.7. Owner ordering, 2026-08-26:
  "Investigate the reopen-path UNKNOWN after P1, before P2. If any
   declared-and-empty table could be a case/progression state or transition
   writer, bring its writer-discovery forward too. UNKNOWN may stay UNKNOWN
   until there is evidence; do not infer it from absence."
```

---

## 1. §10.7 — does a reopen path exist?

**Verdict: it did NOT.** Three independent instruments, and the third is the one
that settles it.

**Instrument 1 — grep.** `reopen`, case-insensitive, across `src/` and
`scripts/`. Almost every hit is CostOps accounting-period close/reopen, a
different domain entirely. Exactly one COS hit:
`proactive-case-bridge.matchCase`, which can return a
`RECENTLY_COMPLETED_REOPEN` tier inside a 30-day window.

**Instrument 2 — callers.** `matchCase` has **no production caller**. Only two
test files import it. And even when called it returns a tier and a case id: it
transitions nothing, records no reason, and sets no next action. The tier is a
classification, not a mechanism.

**Instrument 3 — the live event log**, which is behavioural rather than textual.
Eighty transitions out of `COMPLETED` exist across both namespaces. Every single
one belongs to:

| when | actor | what it was |
|---|---|---|
| 2026-08-09 19:12 / 19:13 | `marveen` | bulk repair after the mass-closure incident |
| 2026-08-10 03:53 | `marveen` | the second sweep of the same repair |
| 2026-08-24 18:51 | `marveen-baseline-import` | baseline import |

Not one was produced by an engine actor. Not one carries a reopen reason.

**What instrument 3 cannot see**, said plainly because an absence proved with
the wrong instrument is free and worthless: it cannot distinguish "no reopen
path exists" from "one exists and no case ever met its condition". Instrument 2
is what closes that gap — a path with no caller cannot have fired.

### 1.1 Built, because the plan said to build exactly this if it was missing

`src/cos/case-reopen.ts`. What each rule defends against:

* **A reason and a named source are REQUIRED.** The eighty transitions above are
  what a reopen looks like when neither is: a bulk status rewrite,
  indistinguishable in the log from a considered decision.
* **The completion survives.** `completed_at` is cleared on the row — a live
  case has not completed — and the fact is kept where facts belong: the original
  `STATUS_CHANGED` stays in the append-only log, and the `CASE_REOPENED` event
  carries the timestamp it superseded.
* **It reopens to TRIAGE / TRIAGE_REQUIRED**, not to a decision. Contradictory
  evidence means the completion was wrong; it does not mean we know what is
  right.
* **It re-arms the engine, it does not run it.** A reopen that writes its own
  next action is a second decision maker on one fact, which is the disease P1
  spent its whole packet removing.
* **A case completed longer ago than `REOPEN_WINDOW_SEC` is refused** unless
  forced, and the force is recorded on the event. The constant is reused from
  `proactive-case-bridge` rather than invented a second time.

Five refusals, each naming itself, so a caller can tell "you may not reopen a
year-old case" from "that case does not exist".

**Twelve tests, and nine deliberate mutations, all nine red.** Two of them were
worth the exercise: the "engine not re-armed" mutation and the "projection
dropped" mutation both initially survived — the second because the headline test
drove a progression cycle afterwards, and that cycle projects inline. The test
now asserts the board agrees *at the moment of the reopen*.

### 1.2 The honest limit, which is also a test

`transitionCase` has no allowed-transition matrix. Anything holding the case
version can still walk a case out of `COMPLETED` with no reason, no source and
no `CASE_REOPENED` event — which is exactly what the two repair sweeps did. This
packet adds a path that **cannot** do that. It does not close the other one, and
a test asserts precisely that so nobody later mistakes one for the other.

### 1.3 A finding for the owner, not for the engine

**65 active cases carry a `completed_at`** (30 personal, 35 ZST) while holding a
non-terminal status — the residue of those repair sweeps, since `transitionCase`
sets `completed_at` on entering COMPLETED and nothing ever clears it. It changes
no behaviour today (`matchCase`'s reopen tier filters on `status='COMPLETED'`),
and it is left alone deliberately: clearing it would erase evidence of when
those cases were wrongly closed.

---

## 2. §3.6 — do the four declared-and-empty tables have writers?

**All four do, and all four writers are reachable from production.** So: empty
because nothing has happened, not empty because nobody writes.

| table | writer | reached from |
|---|---|---|
| `cos_channel_outbox` | `channel-outbox.enqueueOutbox` | `radar-alert.alertRadarHit` ← `radar-digest.ts`, `tick.ts` |
| `cos_autonomy_global` | `kill-switch`, `autonomy-ladder.pauseAll` | `/api/cos/kill-switch`, `scripts/cos-kill-switch.ts` |
| `cos_kill_switch_events` | `kill-switch.engageKillSwitch` | same two |
| `cos_thread_fetch_failures` | `gmail-thread-read.recordThreadFetchFailure` | `scripts/cos-fetch-threads.ts`, a cycle step that runs every cycle |

**The owner's specific question — is any of them a case/progression state or
transition writer?** No. Three of the four modules never name a case or
progression table at all. The fourth, `gmail-thread-read.ts`, does — and only in
`SELECT ... FROM personal_cases`. It reads; it does not write.

### 2.1 Two of the four deserve a sentence more than "has a writer"

**`cos_thread_fetch_failures`.** The step runs every cycle, and tonight's cycle
reported `candidates: 0`. So the failure branch has not been *reached*, not that
it has been reached and never fired. Empty here means "no thread fetch has been
attempted lately", which is a weaker statement than "no thread fetch has ever
failed", and it is the one the evidence supports.

**`cos_autonomy_global`.** `killSwitchState` reads a missing row as
`engaged: false`. An empty table is therefore indistinguishable from an explicit
un-pause. For a STOP control that is the correct direction — a system
permanently halted because a table is empty would be worse — but it is worth
writing down that this particular emptiness has a *meaning*, unlike the other
three.

---

## 3. What this changes about the plan

Scenario 8 (§10.8, "contradictory evidence → reopen") moves from **UNKNOWN** to
**covered by a red-capable test**, and §3.6 moves from four open questions to
four answered ones.

The remaining half of §10.7 is **not** built and is named rather than implied:
the reopen has an owner-initiated entry point (`POST /api/cos/cases/reopen`),
but nothing automatically NOTICES contradicting evidence arriving on a closed
case. That detector is a separate piece of work and is not claimed here.
