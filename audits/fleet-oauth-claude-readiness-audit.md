# Fleet OAuth / Claude sub-agent readiness audit

Status: READ-ONLY AUDIT (2026-07-02). Nothing changed: no login, no restart, no model switch, no
config edit, no source touched. No secret values were read or printed -- only non-secret OAuth
metadata (subscriptionType, scopes, expiry) and SHA-256 prefixes were inspected.

**Headline: technically we ARE ready for a single-role Sonnet pilot -- via the Pro account, without
a new login, and without touching Max. The one real constraint is shared Pro-account quota.**

---

## 1. Is there a fleet-level OAuth token?

`store/.claude-oauth-token`: **ABSENT.** But this matters less than it first appears -- it is only
required for *per-agent isolated* config dirs. The sub-agents do not use isolated dirs; they share
one config dir that already carries a Claude login (see #2). So the missing fleet token does NOT
block a Sonnet pilot.

## 2. Is there an isolated Claude config path for sub-agents? / what login exists?

Sub-agents do NOT get isolated dirs (that path is gated on the absent fleet token). Instead **all 18
sub-agents share `claudeConfigDir=/home/iszzu/.claude-deepseek`**, and that dir contains a valid
Claude OAuth login:

- `/home/iszzu/.claude-deepseek/.credentials.json` -> `claudeAiOauth`, **subscriptionType: "pro"**,
  scopes include `user:inference` + `user:sessions:claude_code`, access token refreshing (refresh
  token present, expiresAt ~7h out at audit time -> live, auto-refreshing).
- This is a **DIFFERENT account** from the main agent: `~/.claude-personal` is **subscriptionType:
  "max"** (rateLimitTier default_claude_max_5x). The two access tokens differ (SHA-256 prefixes
  b4598c41 vs 60e29c41). So the sub-agent config carries a **separate Claude Pro subscription**, not
  the Max account.

Implication: a sub-agent switched to a Claude model authenticates via the **Pro** account, not Max.

## 3. Which agents currently run in shared auth mode?

**All 18** sub-agents: `authMode=shared`, `claudeConfigDir=/home/iszzu/.claude-deepseek`. For their
current DeepSeek models the spawn path injects `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`
(DeepSeek key), which overrides the config dir's OAuth -- so the Pro login is currently dormant for
them. The main agent (marveen-channels) runs separately on `~/.claude-personal` (Max/OAuth).

## 4. What happens if architect / jogasz / sentinel move to Claude Sonnet?

Per the spawn logic (`agent-process.ts`): model `sonnet` -> `isClaude=true`, so the DeepSeek env is
NOT injected. With `authMode=shared` and no per-agent API key, the session authenticates using its
config dir's login = **the .claude-deepseek Pro OAuth**. Result:

- They run Sonnet on the **Pro** account. **No Max consumption. No new login needed.**
- **jogasz (Aegis):** BEST candidate -- legal drafting benefits from Sonnet quality AND it is a
  data-governance improvement: legal docs contain company/personal data that (per the
  data-sensitivity rule) should not go to DeepSeek/Chinese-hosted inference anyway. Moving jogasz to
  Sonnet fixes a latent data-routing concern, not just cost.
- **architect (Atlas):** good for the hardest specs; moderate volume.
- **sentinel:** low value -- it is a monitoring role; Sonnet quality buys little there. Not a good
  first pick.
- **Shared-quota caveat:** all three would draw on the SAME single Pro plan concurrently. Moving
  several at once risks Pro rate-limit throttling. Move ONE at a time and watch.

## 5. Do we need a separate Claude Pro account / config?

**No new account needed** -- a separate Pro subscription is already wired into `.claude-deepseek`.
What we do NOT have is per-agent isolation (each Claude sub-agent would share the one Pro login +
config dir). For a small pilot (1-2 roles) that is fine. For many concurrent Claude sub-agents,
you'd eventually want either (a) more Pro seats, or (b) per-agent isolated dirs + the fleet OAuth
token -- but that is a scale concern, not a pilot blocker.

## 6. How to avoid Max / Opus being consumed automatically

- The Pro login (.claude-deepseek) is a DIFFERENT account from Max (.claude-personal). A sub-agent on
  Sonnet uses Pro, so it structurally CANNOT touch Max quota. This is the key safety property.
- Keep the main agent's Opus/Max usage as-is (interactive only). Do NOT point any sub-agent's
  `claudeConfigDir` at `~/.claude-personal` (that WOULD spend Max). The pilot must keep sub-agents on
  `.claude-deepseek`.
- Do NOT enable the auto model-fallback runner (stays OFF) -- otherwise a limit event could auto-move
  something onto an unintended account.
- No sub-agent should ever be set to an Opus model automatically.

## 7. Minimum precondition for the pilot

1. **Confirm the Pro account is intended for sub-agent runtime** (identity/plan verified here:
   subscriptionType=pro, live token). Istvan confirms this Pro sub is the one to spend on sub-agents.
2. Pick ONE role (recommend jogasz).
3. Snapshot its current `agent-config.json` (model=deepseek-v4-pro) for rollback.
4. That's it -- no login, no token provisioning, no new account required for a single-role pilot.

## 8. Rollback plan

- Revert the one role's model: `PUT /api/agents/<role> {"model":"deepseek-v4-pro"}` +
  `/api/agents/<role>/restart`. Single-field revert.
- The config dir does not change (stays `.claude-deepseek`), so nothing else moves.
- If the Pro account throttles or misbehaves: revert immediately (above); the role is back on DeepSeek
  in one respawn. No account/login teardown involved.
- Keep a copy of the pre-change `agents/<role>/agent-config.json`.

## 9. Suggested first pilot role (we ARE technically ready)

**jogasz (Aegis) -> Claude Sonnet.** Reasons: (a) legal drafting quality genuinely benefits from
Sonnet; (b) data-governance win -- legal/company data stops flowing to DeepSeek; (c) moderate,
bursty volume (not a firehose) so it won't hammer the shared Pro quota; (d) single-field, instantly
reversible. Watch Pro quota for 24h; if clean, consider architect next.

## 10. If we were NOT ready -- next setup step (for reference / future scale)

We ARE ready for a single-role pilot, so this is only for the SCALE case (many concurrent Claude
sub-agents):
1. `claude setup-token` under the Pro (or a dedicated) account -> store to `store/.claude-oauth-token`
   (0600). This enables per-agent isolated config dirs so multiple Claude sub-agents don't share one
   session/login.
2. Then each channel-having sub-agent auto-provisions an isolated dir on next spawn.
3. Consider additional Pro seats if concurrent Claude sub-agent count grows.

---

## Bottom line

Ready for a **one-role Sonnet pilot now** (recommend jogasz), on the existing **Pro** account, with
**zero Max/Opus exposure**, fully reversible in one respawn. The only precondition is your
confirmation that the .claude-deepseek Pro subscription is the account we want sub-agents to spend.
Nothing was changed to produce this audit.
