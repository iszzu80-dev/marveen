# Fork & Upstream Policy (Marveen)

Status: active policy, authored 2026-07-15 after the v1.22.0 baselining episode.

## Why this exists

`~/marveen` is a working fork of the official upstream **Szotasz/marveen** (cutover 2026-06-30).
In July 2026 the fork drifted **39 commits** behind upstream and a full merge of `v1.22.0`
conflicted in **28 files**, because local features (chiefly CostOps + dashboard) had edited
upstream-owned files. Re-baselining a badly-diverged fork is slow, risky, and token-expensive.

This policy keeps the fork **continuously updatable** so that never happens again.

## Core principle

A merge conflict happens **only when both sides edit the same lines of the same file.**
Everything below follows from that one fact:

- Local code that lives in **new files** upstream never touches = **zero conflicts, forever, no rebasing.**
- Edits to **upstream-owned files** are the entire conflict surface. Minimize and isolate them.

## 1. Classify every change

| Type | What it is | Where it goes |
| --- | --- | --- |
| **Upstream-bound** | Generic fixes/features useful to everyone (fleet/infra fixes, bug fixes, general capability) | A small, focused **PR to upstream** `Szotasz/marveen` develop. Once merged, it returns to us on the next pull with **zero conflict** and shrinks our local delta. |
| **Local-private** | Istvan-specific product code upstream would not accept (e.g. CostOps) | Stays in the fork, **structured so it never needs rebasing** (section 2). |

Default bias: if a change is even plausibly generic, upstream it. The smaller the local delta, the cheaper every future sync.

## 2. How local-private code stays separate WITHOUT perpetual rebasing

This is the answer to "if we decide not to upstream something, how does it stay separate so we don't always have to rebase it?"

1. **Put it in new files / dedicated modules.** `src/costops/*`, `web/costops/*`, dedicated route files, dedicated migrations. Upstream never owns these paths, so merges never conflict on them.
2. **Where you must hook into upstream code, use the thinnest possible seam.**
   - One `import` + one `register()`/`mount()` call at a documented extension point.
   - Prefer a plugin/registry/hook mechanism over inline edits.
   - **Mark every unavoidable upstream-file edit** with a greppable comment:
     `// LOCAL-FORK: <feature> mount (re-apply on rebase)`.
3. **Keep the seam list SHORT and stable** (target: < 5 files, a few lines each). That thin list is the *only* thing you ever re-resolve on a pull, and it is trivial.
4. Optional: keep local-private work on a long-lived branch that **only adds files** on top of upstream; forward-integrating upstream is then conflict-free except for the marked seams.

## 3. Sync cadence (the real fix)

- **Pull upstream weekly, or on every upstream release.** Small, frequent merges = tiny conflicts.
- Never let the fork drift dozens of commits. Infrequent syncing is what turns a 10-minute pull into a multi-file baselining job.
- Owner: `marveen` (with `devops`) runs the weekly upstream sync.

## 4. Order of operations ("upstream-first or update-first?")

Git forces **update-first** for a diverged branch: you cannot push/PR local commits without first
integrating current upstream (no non-fast-forward push; a PR must rebase onto current upstream).
Conflict resolution happens **once**, at merge time, and the merged+pushed branch **is** the upstreaming.

Canonical flow, every time:

```
fetch upstream -> merge into an ISOLATED worktree -> resolve (thin seams only, if section 2 is followed)
              -> full test suite green -> land -> push (= upstream for upstream-bound commits)
```

## 5. Safe-execution checklist (every sync / merge / cherry-pick)

1. Do it in an **isolated git worktree**, never the live checkout.
2. **Full test suite green** + boot the dashboard on a scratch port + smoke test.
3. Land via fast-forward / controlled merge; keep the prior commit as **instant rollback**.
4. Rebuild `dist`; restart the dashboard **only with an announcement**, and batch fixes.

## 6. CostOps-specific debt (the current 28-file source)

CostOps currently **edits** upstream-owned files (`web/app.js`, dashboard server) which is why the
merge conflicts in 28 files. The "one big CostOps PR" work must **refactor CostOps into dedicated
modules with a thin mount seam** (section 2) so future upstream pulls stop conflicting on it.
Prep already staged: `upstream/costops-pr1`, `upstream/costops-pr2` branches/worktrees.

## 7. The v1.22.0 remediation plan (in flight)

1. **Cherry-pick (done 2026-07-15):** the small, self-contained upstream fixes that apply cleanly today
   (self-pace-gate long-commit + backtick false-deny fixes, reauth quiet-hours). Cron-TZ pin deferred
   because it depends on other upstream scheduler commits we do not yet have.
2. **Full merge (planned, tested):** converge on `v1.22.0` in an isolated worktree, resolving the 28-file
   conflict once.
3. **Fleet fixes -> small upstream PRs:** message-router hardening, inter-agent `origin_note`, kanban
   label-alias, message `delivered_at` backfill, agent-cap default. These are generic and belong upstream.
4. **CostOps -> one big PR** after the section-6 refactor, so it lands as isolated modules, not upstream-file edits.
