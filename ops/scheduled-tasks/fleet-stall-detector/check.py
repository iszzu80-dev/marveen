#!/usr/bin/env python3
# Fleet stall detector -- LLM-free, DB-direct (no self-HTTP -> no spawnSync deadlock).
# The momentum engine (maestro-backlog-review heartbeat) dispatches only planned/
# in_progress cards; workable cards mis-parked in `waiting` get ignored, so the
# fleet can sit idle for hours (real 2026-07-09 ~6h overnight stall). This is the
# deterministic backstop: if the board has had ZERO activity for >STALL_MIN and
# there is plausibly-workable work, force-nudge deliverylead to run a FULL sweep
# (audit BOTH planned AND waiting cards). Dedup: one nudge per stall episode.
import sqlite3, os, json, time

DB = os.path.expanduser('~/marveen/store/claudeclaw.db')
STATE = os.path.expanduser('~/marveen/store/fleet-stall-state.json')
STALL_MIN = 90            # no board activity for this many minutes = stalled
NUDGE = 'deliverylead'

def load():
    try: return json.load(open(STATE))
    except Exception: return {}

def save(d):
    try: json.dump(d, open(STATE, 'w'))
    except Exception: pass

import subprocess, re
def _safe(s):
    """Sanitize UNTRUSTED interpolated content (card title, agent name) before
    putting it in a bus/Bot-API message, so this deterministic detector can never
    ECHO tag-like / wrapper-escape / injection text a card title might contain.
    Strips control chars + angle/square/curly brackets + backticks, collapses
    whitespace. 2026-07-18: deliverylead flagged a delivery-garbled message that
    LOOKED like a wrapper-escape; the message itself was clean, but round-3
    interpolates the card title, so hardening that vector defensively."""
    if not isinstance(s, str):
        s = str(s)
    s = re.sub(r'[\x00-\x1f\x7f]', ' ', s)          # control chars -> space
    s = re.sub(r'[<>\[\]{}`]', '', s)               # tag/bracket/backtick chars
    s = re.sub(r'\s+', ' ', s).strip()
    return s

def classify_pane(agent):
    """Deterministic, LLM-free pane classification -> (kind, recovery-suggestion).
    Suggestion only; this detector NEVER executes send-keys/restart itself."""
    try:
        out = subprocess.run(['tmux', 'capture-pane', '-t', 'agent-%s' % agent, '-p'],
                             capture_output=True, text=True, timeout=8).stdout
    except Exception:
        return ('no_pane', 'process/session missing -> suggest: dashboard restart (mode:continue)')
    if not out.strip():
        return ('no_pane', 'process/session missing or empty pane -> suggest: dashboard restart (mode:continue)')
    tail = '\n'.join([l for l in out.splitlines() if l.strip()][-18:])
    low = tail.lower()
    if 'esc to interrupt' in low or '↓' in tail:          # spinner / token flow
        return ('working', 'actively producing (esc-to-interrupt / token flow) -> NOT stuck, leave it')
    if any(s in tail for s in ['1. Yes', 'Would you like to proceed', 'manually approve', 'Ready to code']):
        return ('menu_stuck', "interactive plan/approval menu -> suggest: send-keys the safe option (e.g. '1')")
    if 'oauth/authorize' in low or 'authentication fails' in low or ' 401' in tail:
        return ('auth_wall', 'oauth/401 auth wall -> suggest: re-auth (Istvan) or dashboard restart to reinject key')
    if 'restore the code' in low or 'what should claude do instead' in low:
        return ('rewind_menu', 'rewind/history menu open -> suggest: single Esc to back out (never Enter)')
    if 'insufficient balance' in low or 'rate limit' in low or 'quota' in low or '429' in tail:
        return ('quota', 'quota/rate-limit/balance error -> suggest: check account/model fallback (owner)')
    if 'new task? /clear' in low or ('to save' in low and 'tokens' in low):
        return ('idle_at_context', 'idle-not-consuming at high context -> suggest: send-keys concrete next task, or fresh restart if ctx very high')
    return ('idle_unknown', 'idle with no clear signal -> suggest: capture-pane + manual classify')

def escalate_istvan(text):
    """Round-3 escalation to Istvan via Bot API (session-independent, like context-watchdog)."""
    env = os.path.expanduser('~/.claude/channels/telegram/.env')
    try:
        bt = None
        for line in open(env):
            if line.startswith('BOT_TOKEN'):
                bt = line.split('=', 1)[1].strip().strip('"').strip("'"); break
        if not bt:
            return
        import urllib.request
        data = json.dumps({'chat_id': '8942301795', 'text': text}).encode()
        req = urllib.request.Request('https://api.telegram.org/bot%s/sendMessage' % bt,
                                     data=data, headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(req, timeout=8).read()
    except Exception:
        pass

db = sqlite3.connect(DB)
now = int(time.time())

def _i(x):
    """Coerce a possibly-text/None sqlite timestamp to int (0 on failure). Some rows
    have text created_at, and SQLite MAX() ranks text above integers -> without this
    a stray text timestamp becomes the 'max' and crashes arithmetic."""
    try: return int(x)
    except (TypeError, ValueError): return 0

# Last board activity = most recent of: any active card updated, any comment.
# Only consider integer timestamps (guard against the stray text rows).
last_card = _i(db.execute("SELECT MAX(CASE WHEN typeof(updated_at)='integer' THEN updated_at END) FROM kanban_cards WHERE archived_at IS NULL").fetchone()[0])
last_comment = _i(db.execute("SELECT MAX(CASE WHEN typeof(created_at)='integer' THEN created_at END) FROM kanban_comments").fetchone()[0])
last_activity = max(last_card, last_comment)
idle_min = (now - last_activity) / 60.0

# Plausibly-workable work exists? = an open card assigned to a real work-agent
# that is NOT an Istvan-decision card (those are legitimately blocked on Istvan).
workable = db.execute(
    "SELECT COUNT(*) FROM kanban_cards WHERE archived_at IS NULL "
    "AND status IN ('planned','in_progress','waiting') "
    "AND assignee IS NOT NULL AND assignee NOT IN ('istvan','') "
    "AND title NOT LIKE 'ISTVAN-DONTES%'"
).fetchone()[0]

st = load()

# --- Per-agent session-stuck candidates (marveen send-keys territory) -----------
# The board-wide detector below only fires when the WHOLE board is quiet for
# STALL_MIN. It misses the common real case: some agents work (board shows
# activity, idle_min stays low) while a SPECIFIC agent is frozen on an interactive
# prompt (plan-approval menu), idle-not-consuming at high context, or holding on a
# reply that never woke its session. deliverylead cannot recover those -- a bus
# nudge does NOT wake a stuck session; only `tmux send-keys` does, and that is
# marveen's job (deliverylead is send-keys governance-gated). So flag CANDIDATES
# to marveen, who does the pane capture + classify + send-keys. False positive
# cost = one pane capture (a heads-down long turn looks similar from the DB alone).
# Caused 2026-07-17: Pixel frozen 7h on a plan-approval menu, buildfejleszto 3.4h
# holding for a reply, Vecta idle-not-picking-up -- none caught by the board detector.
# Multi-signal: a candidate needs BOTH a stale in_progress card (>AGENT_STALL_MIN,
# no update) AND no bus output in that window (two soft signals) -- then the pane
# classifier adds a strong signal (menu/auth/no-pane/idle) or clears a false
# positive (working = producing). This realizes the DOCUMENTED but previously
# UNIMPLEMENTED `kanban_stuck_nudge` ladder (autonomy-config category read by no
# runtime): round1 = self-nudge the agent, round2 = escalate to deliverylead,
# round3 = escalate to Istvan with a concrete recovery suggestion. NO auto-restart/
# send-keys/redispatch (owner directive 2026-07-17: suggestion only). Idempotent:
# per-agent round + last_ts + card-timestamp; a card that advances RESETS the ladder.
AGENT_STALL_MIN = 45
MIN_GAP_MIN = 15          # min minutes between ladder steps (idempotency/cooldown)

def stuck_level():
    """Read kanban_stuck_nudge autonomy level EACH run (owner-controlled via dashboard).
    1=report-only (no nudge), 2=recovery-suggestion to marveen (approval-gated),
    3=full auto ladder (agent->deliverylead->owner). Default 2 (safe) if unreadable."""
    try:
        cfg = json.load(open(os.path.expanduser('~/marveen/store/autonomy-config.json')))
        for cat in cfg.get('categories', []):
            if cat.get('key') == 'kanban_stuck_nudge':
                return int(cat.get('level', 2))
    except Exception:
        pass
    return 2

LEVEL = stuck_level()

def suppressed_agents():
    """Agents known to be capacity-blocked / intentionally-paused (e.g. a DeepSeek
    402 balance outage escalated at the incident level). The ladder must NOT keep
    escalating these as if task-stuck -- they are owner-blocked, not stalled.
    File: store/liveness-suppress.json = {"agents": [...], "reason": "..."}."""
    try:
        s = json.load(open(os.path.expanduser('~/marveen/store/liveness-suppress.json')))
        return set(s.get('agents', []))
    except Exception:
        return set()

SUPPRESS = suppressed_agents()
ladder = st.get('agent_ladder', {})
new_ladder = {}
for cid, ag, cupd, title in db.execute(
        "SELECT id, assignee, updated_at, title FROM kanban_cards "
        "WHERE archived_at IS NULL AND status='in_progress' "
        "AND assignee IS NOT NULL AND assignee NOT IN ('istvan','') "
        "AND title NOT LIKE 'ISTVAN-DONTES%' "
        # EPIC containers are structurally always stale: progress happens on the CHILD
        # cards, never on the parent, so an epic looks frozen while its owner is busy.
        # Nudging on one is pure busywork -- on 2026-07-18 deliverylead had to explain
        # "not idle, nothing new to report" six times in one evening for three epics
        # (MK/DORA/Zsibongo), which is exactly the manufactured-update pressure this
        # detector should avoid creating. Same exclusion the kanban-audit task already
        # applies. Child freshness is the real signal.
        "AND id NOT IN (SELECT parent_id FROM kanban_cards WHERE parent_id IS NOT NULL) "
        "AND title NOT LIKE '%(epic)%' AND title NOT LIKE 'EPIC:%'").fetchall():
    if ag in SUPPRESS:
        continue                                   # capacity-blocked/paused at incident level -> not task-stuck
    cupd = _i(cupd)
    if cupd == 0 or (now - cupd) / 60.0 < AGENT_STALL_MIN:
        continue                                   # card moved recently -> producing
    lastout = _i(db.execute("SELECT MAX(CASE WHEN typeof(created_at)='integer' THEN created_at END) "
                            "FROM agent_messages WHERE from_agent=?", (ag,)).fetchone()[0])
    if (now - lastout) / 60.0 < AGENT_STALL_MIN:
        continue                                   # agent posted recently -> active
    prev = ladder.get(ag)
    if prev and cupd > prev.get('cupd', 0):
        continue                                   # card advanced since last step -> RECOVERED, drop (resets)
    if prev and (now - prev.get('last_ts', 0)) / 60.0 < MIN_GAP_MIN:
        new_ladder[ag] = prev                      # too soon -> hold current round
        continue
    kind, suggestion = classify_pane(ag)
    if kind == 'working':                          # false-positive guard: actually producing
        continue
    rnd = (prev.get('round', 0) if prev else 0) + 1
    if LEVEL <= 1:
        # level 1 = report-only: record in ladder state, emit NO nudge/escalation.
        pass
    elif LEVEL == 2:
        # level 2 = recovery suggestion to marveen, approval-gated. No auto agent/
        # deliverylead/owner action -- marveen decides. Cooldown via MIN_GAP above.
        db.execute("INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at) VALUES (?,?,?,?,?)",
                   ('fleet-stall-detector', 'marveen',
                    "STUCK CANDIDATE (autonomy level 2, approval-gated -- no auto action taken): %s idle on "
                    "in_progress card %s for %dm, no bus output. Pane: %s -- %s. Approve a nudge / act if real."
                    % (ag, cid[:8], int((now - cupd) / 60), kind, suggestion),
                    'pending', now)); db.commit()
    else:                                          # level 3 = full auto ladder
        if rnd == 1:
            db.execute("INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at) VALUES (?,?,?,?,?)",
                       ('fleet-stall-detector', ag,
                        "STUCK-LADDER round 1 (auto self-nudge): your in_progress card %s has not moved in >%dm "
                        "and you have no bus output in that window. Resume it end-to-end now; if it is actually "
                        "done, flip its status; if blocked, comment exactly what blocks it. Do not sit idle." % (cid[:8], AGENT_STALL_MIN),
                        'pending', now)); db.commit()
        elif rnd == 2:
            # Round-2 normally escalates to deliverylead (it supervises stalled agents).
            # BUT if the STALLED agent IS deliverylead itself, it cannot self-supervise --
            # escalate to marveen (the level above the coordinator) instead of sending
            # deliverylead a self-referential "intervene on yourself" message.
            # (2026-07-18: deliverylead flagged this misdirection on its own card d83c2bc6.)
            if ag == 'deliverylead':
                r2_to = 'marveen'
                r2_msg = ("STUCK-LADDER round 2 (auto): the COORDINATOR (deliverylead) is itself stalled on card %s "
                          "after a round-1 self-nudge -- it cannot self-supervise, so this escalates to YOU. "
                          "Pane classification: %s -- %s. Check deliverylead (capture-pane / verify the card is not "
                          "just blocked-on-owner) and send-keys if genuinely stuck." % (cid[:8], kind, suggestion))
            else:
                r2_to = 'deliverylead'
                r2_msg = ("STUCK-LADDER round 2 (auto): %s still stalled on card %s after a round-1 self-nudge. "
                          "Intervene (you own dispatch). Pane classification: %s -- %s. If this needs send-keys, "
                          "route it to marveen (you are gated)." % (_safe(ag), cid[:8], kind, suggestion))
            db.execute("INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at) VALUES (?,?,?,?,?)",
                       ('fleet-stall-detector', r2_to, r2_msg, 'pending', now)); db.commit()
        else:                                      # round 3+ : escalate to owner with a concrete suggestion
            escalate_istvan("STUCK AGENT (2 rounds failed): %s, card %s (%s), idle %dm. Auto self-nudge + "
                            "deliverylead escalation did not resume it. Pane: %s. Recovery suggestion: %s. "
                            "(No auto-restart/send-keys done -- awaiting manual action.)"
                            % (_safe(ag), cid[:8], _safe(title)[:40], int((now - cupd) / 60), kind, suggestion))
    new_ladder[ag] = {'round': rnd, 'last_ts': now, 'cupd': cupd, 'card': cid[:8], 'level': LEVEL}
st['agent_ladder'] = new_ladder
st.pop('agent_flags', None)                        # migrate off the old single-shot flag map
save(st)

# --- Board-wide stall (existing deterministic backstop) --------------------------
stalled = idle_min >= STALL_MIN and workable > 0

if not stalled:
    # Board is moving (or genuinely all-blocked): clear any prior nudge marker
    # (but preserve agent_flags written above).
    if st.get('nudged'):
        st.pop('nudged', None); st.pop('activity_at', None); st.pop('nudged_at', None)
        save(st)
    raise SystemExit(0)

# Stalled. Dedup: only nudge once per episode -- until activity recovers past the
# timestamp we saw when we last nudged.
if st.get('nudged') and st.get('activity_at') == last_activity:
    raise SystemExit(0)   # already nudged for this exact stall, stay silent

msg = (f"FLEET STALL ({int(idle_min)}m no board activity, {workable} non-blocked cards open). "
       "Run a FULL backlog sweep NOW: audit BOTH planned AND waiting cards. Any `waiting` card "
       "that is actually workable (assignee is a build/work agent, no unmet dependency, not an "
       "ISTVAN-DONTES gate) -> move to in_progress and dispatch the owner with a concrete task. "
       "The momentum engine only auto-dispatches planned/in_progress, so waiting-but-workable "
       "cards are the blind spot that caused this stall. Do not let build agents idle. "
       "Reply to marveen only if you find genuinely nothing dispatchable (all blocked).")

db.execute(
    "INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at) VALUES (?,?,?,?,?)",
    ('fleet-stall-detector', NUDGE, msg, 'pending', now))
db.commit()
st.update({'nudged': True, 'activity_at': last_activity, 'nudged_at': now})
save(st)
