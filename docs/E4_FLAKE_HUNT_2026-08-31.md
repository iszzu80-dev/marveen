# E4 — the unidentified flake, hunted

```text
Written:   2026-08-31
Candidate: f0808f02548980a4d60bf8b954f7cd1175067283 (cos-e1-pipeline-recovery)
Runs:      20 consecutive full-suite runs, 603 files / 8129 tests each
Result:    20/20 clean. Zero failures, zero non-zero exit codes.
Verdict:   NOT IDENTIFIED, and not claimed to be gone. What changed is that the
           next occurrence will be identifiable, which the first one was not.
```

---

## 1. What the open item actually was

Phase 1 final proof, §8: one of seven full-suite runs at the pinned SHA failed,
**and the test could not be named, because the command truncated its own
output**. The instrument was the defect. The six runs after it and both exact-SHA
CI events were green, and the owner ruled it a non-blocker with a standing
reopen condition:

> If the full suite fails again on the same runtime line: do not rerun blindly
> to green; preserve the full output; classify as deterministic defect / flaky
> test / infrastructure issue; and if safety or state integrity is implicated,
> reopen Phase 1 automatically.

The Phase 2 readiness review kept it open as CONDITIONAL, on the grounds that a
flaky test costs a rerun in a phase with no external side effects and costs an
unexplained red on the gate between the engine and the outside world in a phase
that sends mail.

## 2. What was done

Twenty consecutive full-suite runs at the Phase 2 candidate, each one's complete
output written to its own file before anything else looked at it:
`deliverables/e4-suite-output/run-01..20-*.txt`, 7.6 MB preserved.

```text
run 01..20   rc=0   Test Files 603 passed (603)   Tests 8129 passed | 4 skipped
```

Failure markers across all twenty files: zero. Non-zero exit codes: zero.

**Runs 1 to 6 overlapped with other work on the same machine** — the CoS
heartbeat cycle, radar HTTP fetches, an email triage sweep. That is contention,
which makes a timing-sensitive flake *more* likely to show, not less. A clean
result under load is the stronger one, so it is recorded rather than excused.

## 3. What twenty clean runs do and do not establish

Stated as arithmetic, because "the line looks quiet" is not a measurement:

- If the failure rate were still the observed **1 in 7**, the probability of
  twenty consecutive clean runs is **4.6%**. So the data are inconsistent with a
  persistent 1-in-7 flake at roughly the 95% level.
- With zero failures in twenty runs, the 95% one-sided upper bound on the true
  rate is **≈ 14%**. That bound sits almost exactly on 1/7, so this is evidence
  against the original rate and **nothing more**. A rarer flake — one in fifty,
  one in two hundred — is entirely consistent with what was observed here and
  would need hundreds of runs to exclude.

So: **the flake is not identified, and it is not declared gone.** Twenty runs
buy a bound, not an absence. Claiming otherwise would be the same error as the
original report, one confidence level up.

## 4. Why the item can nevertheless close

The reopen condition is now executable, which is the thing that was actually
broken. The first occurrence was unidentifiable because the output did not
survive the run; every run now writes its full output to a file before any
summary is read, and this document names the location. If the suite fails again
on this line, there is no guessing to do: the file is there, the classification
(deterministic defect / flaky test / infrastructure) can be made from it, and
the automatic Phase 1 reopen has something to reopen on.

The entry condition asked for the flake identified **or** enough clean runs at
the candidate to say the line is quiet, **with the full output preserved either
way**. The second branch is met at the strength stated in §3, and the
preservation — the part the first attempt failed at — is met without
qualification.

## 5. Standing recommendation

Keep the twenty-run artefact until Checkpoint E is decided, and re-run the batch
against the final candidate SHA rather than trusting this one: these numbers
belong to `f0808f02`, and a candidate that differs by even one commit is a
different line. Cheap: twenty runs take about twenty-five minutes.
