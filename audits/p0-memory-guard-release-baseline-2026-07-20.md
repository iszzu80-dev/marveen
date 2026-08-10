# P0 memory-pressure guard — release baseline

**Date:** 2026-07-20, ~06:00 CEST
**Status:** deployed and live
**Phase:** P0 remediation, Phase 2 (merge + release baseline)

This is the reference state. If the guard misbehaves later, compare against this
document first; every value below was verified directly by marveen against a
named commit or a running unit, not taken from an agent's report.

---

## 1. What is deployed

| Item | Value |
|---|---|
| Merge commit on `develop` | `c245073` (`--no-ff`, five P0 commits preserved unsquashed) |
| Hardening branch | `p0-monitor-release-health` |
| Release/dead-guard commit | `c189730` |
| `.gitignore` fix | `ecd22b5` |
| Release-bundle fix | `98222ef` |
| Live release id | `monitor-98222ef28` |
| Live build commit | `98222ef283fc90cb01b52f8cd009e1aa5f54cdf4` |

The CostOps tiebreak fix `aed5307` also sits on `develop` and is unrelated to
the guard; it is noted here only because its content also rides inside
`c189730` (see §6).

## 2. Runtime layout — the point of the whole phase

```
ExecStart=/home/iszzu/.bun/bin/bun run \
  /home/iszzu/marveen/releases/monitor-current/memory-pressure-monitor.js
```

`releases/monitor-current` is an atomic symlink to a versioned, immutable
release directory containing real compiled files:

```
list-agent-rss.sh  memory-pressure-gate.js  memory-pressure-health.js
memory-pressure-monitor.js  memory-pressure-types.js
```

**Verified branch-independent:** no file in the release references
`/home/iszzu/marveen/src`, and every non-builtin import is relative and local
to the release directory (`./memory-pressure-gate.js`,
`./memory-pressure-types.js`). The release is a deep copy, not a view onto the
checkout. This is what makes a branch switch unable to break the running
monitor — the failure that caused the 05:20–05:28 outage.

`releases/` is git-ignored (`.gitignore:14`). That matters as much as the
symlink: untracked-but-not-ignored, the directory would have survived branch
switches and been destroyed by a routine `git clean -fd`, trading a rare
failure for a common one.

## 3. Health / dead-guard detection

`checkMonitorHealth()` in `src/web/memory-pressure-health.ts`. Healthy requires
**all** of:

- state file mtime within 2 cycles (40 s),
- `lastMeasurementStatus === "ok"`,
- last successful measurement within 2 cycles.

Failure modes surfaced explicitly:

- `MONITOR_EXECUTION_FAILED` — timer fires, service crashes,
- `MONITOR_STATE_STALE` — state file too old.

Both are **fail-closed for non-core agents**: even when `state=normal`, a failed
health check blocks non-core starts. The previous code returned `state=normal`
and allowed starts while the monitor was dead — a timer that is active plus a
state file that exists is not health, which is the mistake I made myself when I
first reported this monitor as healthy.

## 4. Verified live state (06:00)

| Field | Value |
|---|---|
| `state` | `normal` |
| `since` | 2026-07-19T23:38:05Z |
| `generation` | 681 |
| `lastMeasurementStatus` | `ok` |
| state file age | 7 s (limit 40 s) |
| `memAvailableGiB` | 6.92 |
| `swapUsedGiB` | 1.67 |
| `psiMemorySome` | 0 |
| `agentProcessTreeRssBytes` | 3.16 GB |
| `measuredAgentCount` | 8 |
| `expectedAgentCount` | 5 |
| `agentRssMeasurementSource` | `list-agent-rss.sh` |
| `agentRssMeasurementStatus` | `ok` |

State file path: `store/runtime/memory-pressure-state.json` — **not**
`store/memory-pressure-state.json`. Noted because I guessed the wrong path twice
while verifying.

## 5. Test baseline

- gate 17/17, state machine 19/19, health regression suite green.
- Structure: 2 `it()` blocks holding 33 assertions — this codebase uses a custom
  `ok()` harness. Do not read "2 tests" as thin coverage.
- **RED proof, run by me, not reported to me:** neutering `checkMonitorHealth()`
  to return healthy unconditionally turns the suite RED; restoring it turns it
  green. The coverage is real.

## 6. Known open items — NOT resolved by this phase

1. **`expectedAgentCount` 5 vs `measuredAgentCount` 8.** Not a monitor defect.
   `expectedAgentCount` is `store/agents-desired.json.length`; three running
   agents are absent from the desired-state file. The telemetry is doing its job
   by surfacing the drift. Someone should reconcile desired vs actual.
2. **`c189730` also contains the CostOps change** (`ledger.ts` +13, test +35),
   swept in from the shared working tree. Content is identical to `aed5307`, so
   the merge is a no-op; left alone deliberately rather than rebasing a branch
   other agents may have touched.
3. **Workspace-provenance trap** (`2f077930`) remains an open P0 item, untouched
   per Istvan's instruction not to start it automatically.

## 7. Rollback

```
scripts/install-monitor.sh --rollback     # symlink swap to previous release
systemctl --user restart marveen-memory-monitor.timer
```

Full teardown, in order:

```
systemctl --user disable --now marveen-memory-monitor.timer
rm ~/.config/systemd/user/marveen-memory-monitor.{service,timer}
systemctl --user daemon-reload
git checkout develop && npm run build
systemctl --user restart marveen-dashboard.service
```

`--list` and `--status` inspect available releases and the current one.
