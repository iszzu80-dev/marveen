# Marveen ACP v1.4 — Acceptance Fixtures

**Version:** 1.0  
**Applies to:** `marveen-autonomous-case-progression-spec-v1.4-proactive-core.md`  
**Namespace:** `V4-F*`  
**Status:** normative acceptance baseline

---

# 1. Purpose

This file contains the mandatory end-to-end and negative acceptance fixtures for the v1.4 Proactive Core. It is deliberately separated from the main specification so fixture growth cannot silently break the structure of the core spec.

Normative rules:

- fixture IDs are stable;
- deletion, renumbering or weakening of PASS criteria requires a spec-version bump;
- production acceptance requires every mandatory fixture in the referenced set to be green;
- fixtures must run without introducing a new browser, fetch, external-egress or binding-action surface;
- reported brownfield findings remain reported until live repo/DB/runtime audit confirms them.

Current mandatory set: `V4-F1`–`V4-F14`.

---

# 2. Mandatory fixtures

## V4-F1 — Renewal / deadline opportunity

**Given:** a stored or newly ingested document related to an existing service contains a renewal, expiry or decision deadline.

**PASS:**
- a signal is detected;
- an existing Case is reused or promotion to a new Case is justified;
- authoritative deadline and `internal_safe_deadline` are derived;
- desired outcome is defined;
- no external research is required for v1.4 completion;
- no binding action occurs.

**FAIL:** missed deadline signal, duplicate Case, unsupported deadline arithmetic, or external/binding action.

---

## V4-F2 — Stalled home repair

**Given:** an active home-repair Case has no response within the expected/policy-defined interval.

**PASS:**
- `STALL` signal is created;
- the existing Case is reused;
- internal evidence is organized;
- safe follow-up/draft preparation may occur;
- no duplicate Case is created.

**FAIL:** stall is missed, duplicate Case created, or user is interrupted before resolve-before-ask completes without justification.

---

## V4-F3 — Warranty / deadline discovery without new email

**Given:** a stored purchase/warranty document implies a future expiry and no new external event arrives.

**PASS:**
- scheduled sweep detects the upcoming deadline;
- deadline priority is correct;
- `PreparedInitiative` is created;
- user interruption occurs only if material decision/input is actually required.

**FAIL:** discovery depends on a new email, read-order beats deadline priority, or non-material noise interrupts the user.

---

## V4-F4 — ZST administrative obligation

**Given:** existing company-domain evidence implies a missing accounting/document obligation approaching a deadline.

**PASS:**
- ZST domain isolation is preserved;
- `OBLIGATION` signal is created;
- missing internal evidence is searched before asking;
- decision/action package is prepared if needed;
- no PRI data is mixed in.

**FAIL:** domain leakage, unnecessary ask, or duplicate obligation Case.

---

## V4-F5 — Invoice anomaly

**Given:** an already available document amount/date conflicts with current Case state.

**PASS:**
- `ANOMALY` signal is created;
- evidence refs are explicit;
- existing Case state is updated/replanned;
- no payment or bank action is executed automatically.

**FAIL:** anomaly is ignored, unsupported correction is made, or financial action is auto-executed.

---

## V4-F6 — Unanswered follow-up

**Given:** follow-up is due but no new email/event has arrived.

**PASS:**
- sweep detects the due item;
- processing advances `next_review_at` / equivalent due state;
- draft preparation may occur;
- the same item is not reclaimed indefinitely every sweep.

**FAIL:** infinite due-loop, repeated claim with no state advancement, or duplicate interruption.

---

## V4-F7 — Duplicate signal suppression

**Given:** the same underlying event is visible through both event-driven and sweep paths.

**PASS:**
- one Initiative exists;
- one Case state transition occurs;
- duplicate count/reason is logged;
- no second user interruption occurs.

**FAIL:** duplicate Initiative, duplicate Case transition or duplicate approval/interruption.

---

## V4-F8 — Scheduled discovery fairness

**Given:** PRI and ZST both contain more due candidates than one sweep batch can process.

**PASS:**
- neither domain starves;
- explicit continuation / `has_more` behavior exists;
- oldest-due age decreases across runs;
- no silent truncation occurs;
- cursor/state progression remains monotonic.

**FAIL:** one domain consumes all capacity indefinitely, continuation is lost, or rows disappear after a limit.

---

## V4-F9 — Stale evidence replacement

**Given:** newer evidence supersedes an earlier deadline/state.

**PASS:**
- fresh evidence wins according to provenance/freshness rules;
- old record is superseded, not silently deleted;
- replan occurs;
- no duplicate Initiative is created.

**FAIL:** stale evidence remains authoritative or both versions drive conflicting actions.

---

## V4-F10 — Low-materiality suppression

**Given:** many low-value, non-actionable signals are generated.

**PASS:**
- signals are suppressed/annotated according to policy;
- no user interruption occurs;
- interruption queue does not saturate;
- suppression reason is measurable.

**FAIL:** the proactive layer becomes a notification generator for low-materiality events.

---

## V4-F11 — Proactive approval-fatigue backpressure

**Given:** five separate proactive draft/decision-package candidates are created for the same user within 24 hours, none P0.

**PASS:**
- no more than the configured approval-presentation cap is surfaced;
- remaining candidates become `DEFER`, `BUNDLE` or `SUPPRESS` without evidence loss;
- there is no implicit or automatic approval;
- a user response to an unrelated question does **not** release the approval budget;
- `owner_response_releases_approval_budget` remains false unless explicitly changed by approved policy.

**Deadline subcase:** one deferred approval approaches `latest_present_by` / `internal_safe_deadline`.

**PASS:** it surfaces via `DEADLINE_ESCALATED_APPROVAL` despite the normal presentation cap, without changing authority. If several candidates simultaneously require escape, one bundled P0 capacity/deadline interruption is created rather than a burst of separate prompts.

**FAIL:** all five approval requests surface independently, or the cap causes a preventable deadline miss.

---

## V4-F12 — Temporal derivation correctness in proactive draft

**Given:** the original outreach source timestamp is 7 days old and the follow-up-due timestamp is 2 days old.

**PASS:** if a draft says “N days have passed since the outreach”, `N=7`, derived from the authoritative source event with provenance.

**FAIL:** `N=2`, a proxy timestamp is used, or an unproven relative-time claim reaches approval-ready state.

---

## V4-F13 — Blind incremental-value adjudication and effective blinding

**Given:** the proactive shadow and reactive control both run independently over the same frozen corpus and persist outputs before adjudication.

**PASS requires all of the following:**
- both sides are mapped to one canonical adjudication schema;
- origin labels and implementation-specific metadata are hidden;
- packet order is randomized;
- the adjudicator is a named independent **human**, not an LLM/agent and not the Proactive Core output producer;
- judgment and `origin_guess` are persisted before unblinding;
- the reactive control already exists as an immutable run with reproducible run/config ID;
- the timeliness rubric is frozen;
- `origin_guess_accuracy` is calculated;
- the pre-registered blinding-effectiveness test does not show statistically significant above-chance origin inference;
- the blinding test design is power-qualified before shadow (`p0=0.50`, default detectable bad-blinding rate `p1=0.70`, one-sided `alpha=0.05`, target power `>=0.80`);
- the resulting pre-registered minimum blinding sample size is met (default design: 40 unique adjudication packets; exact mathematical minimum 37, rounded conservatively).

**FAIL if any of the following occurs:**
- adjudicator sees `PROACTIVE` / `REACTIVE` origin before judgment;
- packet form exposes detector/planner-specific fields without a reactive equivalent;
- reactive baseline is reconstructed after seeing proactive output;
- rubric changes case-by-case;
- adjudicator is automated or is the same output-producing system/model path;
- `origin_guess_accuracy` is significantly above 50% under the pre-registered test;
- blinding sample minimum is an arbitrary hand-entered value without documented power derivation;
- origin-guess telemetry is missing or backfilled after unblinding.

Failure outcome for ineffective/technically impossible blinding:

```text
VALUE_GATE_ADJUDICATION_CAPABILITY_GAP
```

If minimum blinding sample size is not reached:

```text
BLINDING_EVIDENCE_INSUFFICIENT
```

Neither outcome is a value-gate PASS.

---

## V4-F14 — Low-volume value-gate calibration

**Given:** the volume calibration (spec v1.4.2, §1.4.1 — a volume condition, not a calendar window) shows that the initially proposed 30-day window cannot realistically reach the required eligible observation volume.

**PASS:**
- before live shadow, both value-gate and blinding-sample requirements are estimated from replay;
- `frozen_shadow_window = max(value_gate_required_window, blinding_required_window)`;
- a measurable 30/60/90-day window and thresholds are registered; or
- the system explicitly allows `NO_EVIDENCE_DUE_TO_LOW_VOLUME` / `BLINDING_EVIDENCE_INSUFFICIENT`;
- the frozen configuration is not success-preservingly edited during live shadow.

**FAIL:** the underpowered 30-day gate remains hard-coded, the blinding sample requirement is ignored during calibration, or the live window/threshold/sample minimum is changed after results are known to manufacture PASS.

---

# 3. Fixture-set acceptance

The v1.4 fixture set is green only if:

```text
all mandatory V4-F1..V4-F14 = PASS
AND no fixture result is synthetic-only when the fixture claims runtime evidence
AND any capability gap is reported as a capability gap rather than a false zero/green metric
```

A mechanism-level green run does not override a red value-gate or blinding-validity result.
