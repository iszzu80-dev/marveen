# Claude subscription migration — runtime topology closure

**Date:** 2026-07-20 13:00 CEST
**Mode:** READ-ONLY. Nothing was modified, restarted, activated or committed.
**Author:** marveen

## 0. Verdict up front

**Istvan's code claim is CONFIRMED.** The fleet OAuth token is auto-injected by the
launcher **only when no explicit `claudeConfigDir` resolved**, with the auto-isolated
channel-agent path as the single exception.

**Consequence:** the 20 agents pinned to `/home/iszzu/.claude-personal` **cannot** be
migrated by creating `store/.claude-oauth-token`. For them the file is inert.

Not "probably" — this is a single boolean in one function, quoted verbatim below.

## 1. The decisive source

`src/web/agent-process.ts`, lines 964-995 (live working tree, branch `costops-rebased`):

```ts
let claudeConfigDir = planResolution.configDir        // 964
let oauthTokenEnv = ''                                 // 965

if (!claudeConfigDir && hasFleetOauthToken()) {        // 972  <-- THE GATE
  oauthTokenEnv = `export CLAUDE_CODE_OAUTH_TOKEN="$(cat '${FLEET_OAUTH_TOKEN_PATH}')" && `
}

if (!claudeConfigDir && hasChannel && name !== MAIN_AGENT_ID) {   // 975
  if (hasFleetOauthToken()) {
    const isolated = ensureIsolatedChannelConfigDir(name, agentProvider)
    if (isolated) {
      claudeConfigDir = isolated                       // 982
      oauthTokenEnv = `export CLAUDE_CODE_OAUTH_TOKEN="$(cat '${FLEET_OAUTH_TOKEN_PATH}')" && `  // 986
    }
  }
}

const claudeConfigEnv = claudeConfigDir ? `export CLAUDE_CONFIG_DIR="${claudeConfigDir}" && ` : ''  // 995
```

Read it as a truth table:

| resolved `claudeConfigDir` | has channel | token injected? |
|---|---|---|
| set (explicit field or plan) | any | **NO** |
| unset | no | YES (972) |
| unset | yes, non-main | YES (986), and a config dir is created |

`FLEET_OAUTH_TOKEN_PATH` = `store/.claude-oauth-token` (line 140).

`store/claude-plans.json` **does not exist**, and **no agent has `claudePlan` set**, so
`planResolution.configDir` is today purely the raw per-agent `claudeConfigDir` field.

## 2. Agent inventory (21 agent-config.json files)

| field | value | count |
|---|---|---|
| `claudeConfigDir` | `/home/iszzu/.claude-personal` | **20** |
| `claudeConfigDir` | absent | 1 (`frontendfejleszto2`) |
| `claudePlan` | absent | 21 |
| `authMode` | `shared` | 21 |
| `model` | `deepseek-v4-pro` | 21 |

`frontendfejleszto2` is the **only** agent that today satisfies `!claudeConfigDir`.
That is exactly why the 12:26 live canary received the token — and why it also
received **no** `CLAUDE_CONFIG_DIR` export (line 995), so it fell back to the process
default `~/.claude`, a root that carries a freemail `.credentials.json`. The canary
therefore ran with **two credentials in scope at once**. Which one authenticated the
request is not decidable from that run; my earlier claim that the config-dir
credentials won was an inference, not a proof, and Istvan's isolated identity canary
(login method Claude Max, org and email `istvan.szabo@zstradio.com`) is the stronger
evidence about what the candidate token *is*.

## 3. Credential stores on disk

| config root | root is symlink | `.credentials.json` | account |
|---|---|---|---|
| `~/.claude` | real dir | REAL (sha12 `6b8191347 2b0`) | iszzu@freemail.hu |
| `~/.claude-personal` | real dir | REAL (sha12 `d10b55aab0d5`) | iszzu@freemail.hu |
| `~/.marveen-worker/.claude-config` | real dir | **SYMLINK → `~/.claude-personal/.credentials.json`** | iszzu@freemail.hu |
| `~/.marveen-worker-fast/.claude-config` | real dir | REAL (sha12 `359e2d3e7143`) | iszzu@freemail.hu |

Four roots, **three independent credential stores**. `marveen-worker` follows
`.claude-personal` automatically because the *file* is symlinked (the root is not).
This is the precise mechanism behind the "three logins, not four" advice given
2026-07-20 morning — the advice holds; the stated reason (symlinked root) was wrong.

## 4. Runtime surface matrix

Live values read from `/proc/<pid>/environ` at 12:56 CEST. `store/.claude-oauth-token`
did **not** exist at measurement time (removed during the canary rollback), and `.env`
contains **no** `CLAUDE_CODE_OAUTH_TOKEN` and **no** `ANTHROPIC_*` key — only
`MAIN_AGENT_ID`.

| # | surface | launcher | effective CLAUDE_CONFIG_DIR | creds in that root | account | fleet token auto-injected? | reads `store/.claude-oauth-token`? | reads `.env`? |
|---|---|---|---|---|---|---|---|---|
| 1 | main Marveen session | `scripts/channels.sh` → tmux `agent-marveen` | `~/.claude-personal` | yes | freemail | via channels.sh, **yes** | **YES** (channels.sh:39-42) | yes (:33) |
| 2 | channels service / Telegram | `scripts/channels.sh` | `~/.claude-personal` | yes | freemail | **yes** | **YES** | yes |
| 3 | dashboard-launched normal agents | `src/web/agent-process.ts` | per-agent field | — | — | **only if field unset** | only then | no |
| 4 | agents WITH explicit `claudeConfigDir` (20) | same | `~/.claude-personal` | yes | freemail | **NO** | **NO** | no |
| 5 | agents with `claudePlan` | same | n/a | — | — | NO (plan sets configDir) | NO | no |
| 6 | auto-isolated channel agents | same, path 975-986 | auto-provisioned isolated dir | no creds by design | token-only | **YES** (986) | YES | no |
| 7 | normal worker | `bash -lc` + `CLAUDE_CONFIG_DIR=~/.marveen-worker/.claude-config` | that dir (pid 732 verified) | yes (symlink→personal) | freemail | **NO** | NO | no |
| 8 | fast worker | same shape, own dir | `~/.marveen-worker-fast/.claude-config` (pid 767 verified) | yes, own file | freemail | **NO** | NO | no |
| 9 | DeepSeek-routed agents (21) | agent-process.ts:823 | per-agent field | yes | n/a for auth | irrelevant while on DeepSeek | no | no |
| 10 | agents later restored to Claude | same | per-agent field | yes | freemail | **NO** while field set | NO | no |

DeepSeek routing (line 823) exports `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`
and `ANTHROPIC_MODEL`. Verified live: the running deepseek agents carry that base URL;
the four Claude surfaces (1,2,7,8) carry none of the three `ANTHROPIC_*` vars.

**Provider actually used, per surface:**
- Claude model + surfaces 1,2: `.credentials.json` in `~/.claude-personal`, unless a fleet token is present, in which case both are in scope.
- Claude model + surfaces 4,7,8,10: `.credentials.json` in the pinned root. Full stop — no token is exported.
- Claude model + surface 6: token only (isolated dir deliberately carries no credentials).
- DeepSeek model, any surface: `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`; Claude credentials unused.

**Change without restart:** none. Every value above is captured into the process
environment at launch. **Change after restart:** only surfaces 1, 2, 3-when-unset and 6.

## 5. Migration matrix

| surface | current provider | current root | current account | token auto-injects | required action | restart | rollback | risk |
|---|---|---|---|---|---|---|---|---|
| main session | Claude opus | `.claude-personal` | freemail | yes | token file **or** `/login` in that root | yes | delete token / re-login | med — carries Telegram |
| channels | Claude opus | `.claude-personal` | freemail | yes | same as main | yes | same | **high — this is the Telegram channel; if it comes up logged-out, Istvan loses contact** |
| 20 pinned agents | DeepSeek | `.claude-personal` | freemail | **no** | `/login` in `.claude-personal`, **or** clear the field, **or** introduce a plan | yes | restore field / re-login | low — all on DeepSeek today |
| frontendfejleszto2 | DeepSeek | default `~/.claude` | freemail | **yes** | token file alone suffices *if* the root has no competing creds | yes | delete token | low |
| normal worker | Claude opus | `.marveen-worker/.claude-config` | freemail | no | follows `.claude-personal` via symlinked creds | yes | n/a | low |
| fast worker | Claude opus | `.marveen-worker-fast/.claude-config` | freemail | no | own `/login` | yes | re-login | low |

**One credential store is load-bearing for two surfaces at once:** `.claude-personal`
backs the main session, the channels/Telegram service, the normal worker (by symlink)
and all 20 pinned agents. A single bad login there takes out the owner's contact path
and the whole fleet's Claude fallback simultaneously.

## 6. Two upstream-compatible target architectures

### A) Central fleet token, account routing decoupled from agent config dirs

Remove `claudeConfigDir` from agent configs; let the launcher's `!claudeConfigDir`
branch inject one central token for everyone.

- **Refreshability:** best. One file, `auth.sh` already syncs it (`scripts/auth.sh:61-64`).
- **Credential refresh race:** none. A setup-token is long-lived (~1y) and static; no
  rotating `.credentials.json` to race.
- **Plugin/session isolation:** *lost* for the 20 agents unless the isolated-channel
  path is widened — they would all share `~/.claude`, which is the exact plugin-slot
  collision the isolation code was written to prevent (`maybeAlertSharedConfigCollision`).
- **Main/worker support:** main and channels already read the token file. Workers do
  **not** — they hardcode a config dir in their launch string, so they need separate work.
- **Mixed routing:** unaffected; DeepSeek agents ignore Claude auth entirely.
- **Rollback:** delete one file. Cheapest rollback of the two.
- **Local change needed:** strip 20 config fields; teach the worker launchers to read the token.
- **Upstream:** none required.

### B) Named Claude plan / separate account config root

Populate `store/claude-plans.json`, set `claudePlan` per agent, point the plan at a
config root logged into the new account.

- **Refreshability:** worse. A `/login` per plan root, and Claude Code rotates
  `.credentials.json` under you.
- **Refresh race:** real. Several processes reading one rotating credentials file is
  the failure mode `~/.claude-personal` already has today with 20+ consumers.
- **Isolation:** best. Per-plan roots keep plugin slots and sessions apart.
- **Main/worker:** main is explicitly **not** covered — `agent-process.ts:951-952`
  says so in a comment ("this covers regular agents only; the main agent still
  launches via channels.sh, separate gated follow-up"). Workers not covered either.
- **Mixed routing:** fine.
- **Rollback:** clear `claudePlan`; more moving parts than deleting a file.
- **Local change needed:** create the plans registry, set 20 fields, provision roots.
- **Upstream:** none strictly; the main-agent gap is a local follow-up.

## 7. Recommendation

**A, narrowed** — central fleet token, but do **not** strip all 20 config fields at once.

Rationale: B's advantage is isolation, which today only matters for agents that own a
channel. Exactly one agent owns a channel (main), and main is the one surface B does not
cover. So B pays its cost where it gives no benefit.

The unresolved question A must answer first is **precedence**: when both
`CLAUDE_CODE_OAUTH_TOKEN` and a root `.credentials.json` are in scope, which wins?
The 12:26 canary had both and did not settle it. Until that is answered, no plan is safe,
because a "successful" migration could silently keep billing the old account.

### Canary-first order

1. **Settle precedence.** One agent, an isolated config root with **no** `.credentials.json`,
   token only. If it runs and reports a *different* quota than freemail's, the mechanism
   is proven. This is the corrected version of the 12:26 test.
2. **Then** the same on a root that *does* carry freemail creds. Same token. Compare.
   This is the actual precedence experiment and the only thing that makes step 3 safe.
3. `frontendfejleszto2` persistently — the only agent already on the `!claudeConfigDir` path.
4. Two or three pinned agents: clear the field, restart, verify account.
5. The remaining pinned agents in batches.
6. **Workers last, main and channels absolutely last.** Channels is the owner's contact
   path; if it boots logged-out the failure is invisible from inside the system.

Rollback at every step: restore the field, or delete `store/.claude-oauth-token`.

## 8. What this document does NOT establish

- Which credential wins when both are present. **Open.** Steps 1-2 above exist to close it.
- Whether the new subscription has usable weekly headroom. The 91% figure observed at
  12:26 is, per Istvan, the freemail quota, and I cannot currently attribute it.
- Anything about surfaces while they are on DeepSeek — Claude auth is simply unused there.

No file, service, config, branch or process was modified in producing this document.
