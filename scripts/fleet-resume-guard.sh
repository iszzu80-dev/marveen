#!/usr/bin/env bash
# fleet-resume-guard.sh  [--dry-run]
#
# Fleet self-heal (2026-07-06, Istvan-approved optimization #1).
# LOCAL-ONLY, UNTRACKED helper (added to .git/info/exclude) -- does NOT modify
# any tracked/upstream file, so the official marveen `git pull` stays clean.
# Same shell/tmux/curl/python idiom as dispatch-guard.sh, NO LLM call.
#
# Problem it fixes: after a host/tmux restart the agents respawn (via
# --continue) but sit IDLE at an empty prompt -- their in-flight work never
# resumes until someone hand-nudges each one (observed 2026-07-06: all 20 idle
# after a restart). There is no watchdog daemon; dispatch-guard is per-dispatch.
#
# What it does, per fleet agent, every run (cron every few minutes):
#   1. tmux session up?  (else skip -- creation is a different concern)
#   2. IDLE-at-rest?  pane shows the "bypass permissions" ready footer but NOT
#      "esc to interrupt" (which is only present while a turn is processing).
#   3. Has REAL pending work?  an assigned kanban card in_progress.
#      (NOT planned -- planned is deliberately-filed future backlog, not
#      interrupted work; nudging it with "resume it now" is a lie and was the
#      whole source of the 2026-07-11 noise incident: two `planned` cards kept
#      re-triggering identical nudges for hours because this used to treat
#      in_progress and planned as equivalent. `waiting` was never included.)
#   4. Not already acknowledged-and-capped?  per-CARD nudge count in the state
#      file (not per-agent) -- after MAX_NUDGES_PER_CARD nudges with no status
#      change on that specific card, stop nudging it silently. A status change
#      (card moves, or its updated_at advances) resets the counter, since that
#      means something actually happened.
#   5. Not nudged too recently?  (rate-limit, default 15 min, unchanged.)
#   If all -> send ONE resume nudge via /api/messages (a curl, not an LLM call).
#
# Conservative by design: never nudges a busy agent, never nudges an idle agent
# with no open card, never re-nudges within the rate-limit window, never nudges
# past the per-card cap. Safe no-op if the fleet is healthy.
#
# Exit 0 always (it is a best-effort maintenance sweep).

set -uo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORE_DIR="$SCRIPT_DIR/../store"
TOKEN_FILE="$STORE_DIR/.dashboard-token"
DASH_URL="http://localhost:3420"
STATE_FILE="$STORE_DIR/fleet-resume-state.json"
RATE_LIMIT_SEC=900          # do not re-nudge the same agent within 15 min
MAX_NUDGES_PER_CARD=2       # after this many fruitless nudges on one card with
                            # no status/updated_at change, stop nudging about it
                            # silently -- ringing the same bell forever past the
                            # point the assignee has clearly already seen and
                            # parked it is noise, not a safety net.
SKIP_AGENTS="marveen"       # never nudge the main orchestrator itself

[ -f "$TOKEN_FILE" ] || { echo "no dashboard token"; exit 0; }
TOKEN=$(cat "$TOKEN_FILE")

# Cards that count as REAL, resumable, in-flight work: in_progress only.
# `planned` is deliberately-filed future backlog (not interrupted work -- see
# header), `waiting` is externally blocked -- neither belongs in a "resume it
# now" nudge. One API call, parsed in python -> per-agent list of
# {id, updated_at} for their in_progress cards.
CARDS_JSON=$(curl -s -m 15 -H "Authorization: Bearer $TOKEN" "$DASH_URL/api/kanban" 2>/dev/null | python3 -c "
import json,sys
try: cards=json.load(sys.stdin)
except Exception: sys.exit(0)
if isinstance(cards,dict): cards=cards.get('cards',cards.get('data',[]))
by_agent={}
for c in cards:
    if c.get('status') == 'in_progress':
        a=(c.get('assignee') or '').strip()
        if not a: continue
        by_agent.setdefault(a, []).append({'id': c.get('id'), 'updated_at': c.get('updated_at')})
print(json.dumps(by_agent))
" 2>/dev/null)
[ -z "$CARDS_JSON" ] && CARDS_JSON='{}'

NUDGE="Fleet-resume-guard: your tmux session is up but was sitting idle while you still have an assigned kanban card in_progress. Resume it now -- check your active card and continue the task end-to-end. If the card is actually done, flip its status; if blocked, comment what blocks it. Do not sit idle on assigned work."

now=$(date +%s)
nudged=0; checked=0

for sess in $(tmux ls 2>/dev/null | sed -n 's/^\(agent-[A-Za-z0-9_-]*\):.*/\1/p'); do
    agent="${sess#agent-}"
    case " $SKIP_AGENTS " in *" $agent "*) continue;; esac
    checked=$((checked+1))

    pane=$(tmux capture-pane -t "$sess" -p 2>/dev/null | tail -25)
    # busy? -> skip (esc to interrupt only shows during an active turn)
    echo "$pane" | grep -qE 'esc to interrupt' && continue
    # ready/idle footer present? (robust readiness signal, per dispatch-guard)
    echo "$pane" | grep -qE 'bypass permissions' || continue

    # Does this agent have at least one in_progress card that is neither
    # rate-limited nor capped-out? A card's updated_at moving (status change,
    # comment, anything) resets its CAP (a genuinely new stall gets fresh
    # attempts) -- but the RATE_LIMIT_SEC floor since the last actual nudge
    # ALWAYS applies regardless of updated_at, full stop. Earlier version bypassed
    # the floor entirely on any change, so an assignee's own comment (which
    # moves updated_at) could trigger a near-immediate re-nudge ~90s later
    # instead of resetting the count and still waiting out the window --
    # exactly backwards, since a fresh comment is a sign of active engagement,
    # not neglect (deliverylead repro on b90eb930, 2026-07-11).
    eligible=$(CARDS_JSON="$CARDS_JSON" python3 -c "
import json,os
cards = json.loads(os.environ['CARDS_JSON']).get('$agent', [])
if not cards:
    print('no-work'); raise SystemExit
try: state = json.load(open('$STATE_FILE'))
except Exception: state = {}
agent_state = state.get('$agent', {})
if not isinstance(agent_state, dict): agent_state = {}  # migrate legacy flat-timestamp entries
now = $now
for c in cards:
    cid, upd = c.get('id'), c.get('updated_at')
    rec = agent_state.get(cid)
    changed = not isinstance(rec, dict) or rec.get('updated_at') != upd
    effective_count = 0 if changed else rec.get('count', 0)
    if effective_count >= $MAX_NUDGES_PER_CARD:
        continue
    last = 0 if (not isinstance(rec, dict)) else rec.get('last', 0)
    if now - last < $RATE_LIMIT_SEC:
        continue
    print('eligible'); raise SystemExit
print('capped-or-limited')
" 2>/dev/null)

    [ "$eligible" = "no-work" ] && continue
    [ "$eligible" = "eligible" ] || continue

    if [ "$DRY_RUN" = "1" ]; then
        echo "WOULD-NUDGE: $agent (idle + eligible in_progress card)"
        continue
    fi

    curl -s -X POST "$DASH_URL/api/messages" -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" --data @- >/dev/null <<JSONEOF
{"from":"marveen","to":"$agent","content":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$NUDGE")}
JSONEOF
    # record nudge: bump count (or reset to 1 on updated_at change) per card,
    # so a card that's already been nudged MAX_NUDGES_PER_CARD times with no
    # change goes quiet instead of ringing forever.
    CARDS_JSON="$CARDS_JSON" python3 -c "
import json,os
p='$STATE_FILE'
try: s=json.load(open(p))
except Exception: s={}
agent_state = s.get('$agent', {})
if not isinstance(agent_state, dict): agent_state = {}  # migrate legacy flat-timestamp entries
now = $now
for c in json.loads(os.environ['CARDS_JSON']).get('$agent', []):
    cid, upd = c.get('id'), c.get('updated_at')
    rec = agent_state.get(cid)
    if not isinstance(rec, dict) or rec.get('updated_at') != upd:
        agent_state[cid] = {'count': 1, 'last': now, 'updated_at': upd}
    elif rec.get('count', 0) < $MAX_NUDGES_PER_CARD and now - rec.get('last', 0) >= $RATE_LIMIT_SEC:
        rec['count'] = rec.get('count', 0) + 1
        rec['last'] = now
s['$agent'] = agent_state
json.dump(s,open(p,'w'),indent=2)
"
    echo "NUDGED: $agent (idle with eligible in_progress card)"
    nudged=$((nudged+1))
done

echo "fleet-resume-guard: checked=$checked nudged=$nudged$([ "$DRY_RUN" = 1 ] && echo ' (dry-run)')"
exit 0
