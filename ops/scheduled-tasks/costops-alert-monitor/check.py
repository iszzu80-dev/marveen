#!/usr/bin/env python3
# CostOps proactive alert pusher -- LLM-free. Reads the dashboard's already-computed
# cost warnings + limit gauges + usage snapshots, and pushes a Telegram message to
# Istvan ONLY when a NEW item crosses an actionable threshold (dedup by state file).
# Silent otherwise. The point: Istvan should NOT have to watch the dashboard.
#
# Robustness: the CostOps /warnings + /limits endpoints recompute over a 50MB+ ledger
# and can take 8-35s. Timeouts are generous. If a source fails to fetch, its prior
# alert keys are CARRIED FORWARD (not dropped) so dedup does not flap / re-alert on
# transient slowness, and a real warning is never silently missed by a stale clear.
import json, os, subprocess, sys, time
from datetime import datetime, timezone

# --- Detach guard ---------------------------------------------------------
# The schedule-runner invokes command-tasks with spawnSync, which BLOCKS the
# dashboard's Node event loop until the child exits. This script calls the
# dashboard's OWN HTTP API (localhost:3420) -- which can NOT be served while the
# event loop is blocked -> deadlock -> every scheduled run timed out/failed
# (fails=15 while manual runs succeeded). Fix: on the first entry, re-exec
# ourselves as a DETACHED background process and return 0 immediately. That
# unblocks the event loop so the detached worker's HTTP calls get served.
if os.environ.get('COSTOPS_WORKER') != '1':
    try:
        subprocess.Popen(['python3', os.path.abspath(__file__)],
                         env=dict(os.environ, COSTOPS_WORKER='1'),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    except Exception:
        pass
    sys.exit(0)
# --------------------------------------------------------------------------

HOME = os.path.expanduser('~')
DASH = 'http://localhost:3420'
TOKEN_FILE = os.path.join(HOME, 'marveen/store/.dashboard-token')
ENV_FILE = os.path.join(HOME, '.claude/channels/telegram/.env')
STATE_FILE = os.path.join(HOME, 'marveen/store/costops-alert-state.json')
CHAT_ID = '8942301795'
STALE_SEC = int(3.5 * 24 * 3600)   # half a week without a fresh Claude usage snapshot

def dash_token():
    try: return open(TOKEN_FILE).read().strip()
    except Exception: return None

def bot_token():
    try:
        for line in open(ENV_FILE):
            if line.startswith('TELEGRAM_BOT_TOKEN=') or line.startswith('BOT_TOKEN='):
                return line.split('=', 1)[1].strip().strip('"').strip("'")
    except Exception: pass
    return None

def api(path, tok, timeout=45):
    """Returns (ok, data). ok=False means the fetch failed -> carry forward prior keys."""
    try:
        out = subprocess.run(['curl', '-s', '--max-time', str(timeout), '-H', f'Authorization: Bearer {tok}', f'{DASH}{path}'],
                             capture_output=True, text=True, timeout=timeout + 5).stdout
        return True, json.loads(out)
    except Exception:
        return False, None

def load_state():
    try: return set(json.load(open(STATE_FILE)).get('alerted', []))
    except Exception: return set()

def save_state(keys):
    try: json.dump({'alerted': sorted(keys), 'updated': int(time.time())}, open(STATE_FILE, 'w'))
    except Exception: pass

tok = dash_token()
if not tok:
    sys.exit(0)

first_run = not os.path.exists(STATE_FILE)
prev = load_state()

alerts = []            # (key, text) -- alertable conditions found this run
covered_prefixes = []  # prefixes whose source fetched OK (fresh keys authoritative)

def carry(prefix):
    """A source failed to fetch: keep its prior keys so dedup does not flap."""
    return set(k for k in prev if k.startswith(prefix))

now_keys = set()

# 1. Limit gauges >= 80%
ok, lim = api('/api/costs/limits', tok)
if ok and isinstance(lim, dict):
    covered_prefixes.append('limit:')
    for l in (lim.get('limits') or []):
        pct = l.get('usage_pct')
        if isinstance(pct, (int, float)) and pct >= 0.80:
            name = l.get('name') or f"{l.get('provider','?')} {l.get('limit_type','')}".strip()
            key = f"limit:{l.get('provider','')}:{l.get('limit_type','')}"
            reset = l.get('reset_date') or l.get('reset_label') or ''
            alerts.append((key, f"⚠️ {name}: {round(pct*100)}% felhasznalva{(' (reset '+str(reset)+')') if reset else ''}"))
else:
    now_keys |= carry('limit:')

# 2. Warnings with high/critical severity  (slow endpoint: ~30s)
ok, w = api('/api/costs/warnings', tok, timeout=50)
if ok:
    covered_prefixes.append('warn:')
    for x in (w.get('warnings') if isinstance(w, dict) else w) or []:
        sev = str(x.get('severity', '')).lower()
        if sev in ('high', 'critical'):
            key = f"warn:{x.get('code','')}:{x.get('provider','')}"
            alerts.append((key, f"⚠️ {x.get('provider','')}: {x.get('message','')}"))
else:
    now_keys |= carry('warn:')

# 3. Budget forecast breach (from summary)
ok, s = api('/api/costs/summary', tok)
if ok and isinstance(s, dict):
    covered_prefixes.append('budget:')
    b = s.get('budget') or {}
    if b and str(b.get('status', '')).lower() in ('hard', 'critical', 'over'):
        key = f"budget:{s.get('month','')}"
        fp = b.get('operational_forecast_pct') or b.get('forecast_pct')
        alerts.append((key, f"⚠️ Budget: az elorejelzes a budzse {round((fp or 0)*100)}%-at eri el ho vegere"))
else:
    now_keys |= carry('budget:')

# 4. Stale Claude usage snapshot -- weekly-% has NO public API, it is a manual
#    screenshot entry. Instead of faking a gauge, nudge Istvan when the number goes
#    stale so he only pastes a screenshot when the system actually asks.
ok, sub = api('/api/costs/subscriptions', tok)
if ok:
    covered_prefixes.append('stale:')
    for sc in (sub.get('subscriptions') if isinstance(sub, dict) else sub) or []:
        if sc.get('provider') != 'anthropic':
            continue
        us = sc.get('usage_snapshot') or {}
        as_of = us.get('as_of')
        if not as_of:
            continue
        try:
            dt = datetime.fromisoformat(str(as_of))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            age = time.time() - dt.timestamp()
        except Exception:
            continue
        if age >= STALE_SEC:
            days = round(age / 86400, 1)
            key = f"stale:{sc.get('id','')}"
            alerts.append((key, f"\U0001f504 {sc.get('name','Claude')} heti-% adat {days} napja nem frissult -- kuldj egy screenshotot a Claude usage-rol, hogy a gauge pontos maradjon (nincs ra API, kezi input)"))
else:
    now_keys |= carry('stale:')

# Current alertable keys from sources that fetched OK (authoritative for their prefix)
now_keys |= set(k for k, _ in alerts)

# First run: seed silently, do not dump pre-existing conditions.
new = [] if first_run else [(k, t) for (k, t) in alerts if k not in prev]

save_state(now_keys)

if not new:
    sys.exit(0)   # silent -- nothing new crossed a threshold

bt = bot_token()
if not bt or not CHAT_ID:
    print('[costops-alert] new alerts but no bot token / chat-id', file=sys.stderr)
    sys.exit(0)

lines = ["\U0001f4b0 CostOps figyelmeztetes:"] + [t for _, t in new]
lines.append("\n(A dashboard proaktivan jelez -- ha ez csend, minden rendben. Reszletek: localhost:3420 Costs.)")
text = "\n".join(lines)
try:
    subprocess.run(['curl', '-s', '-X', 'POST', f'https://api.telegram.org/bot{bt}/sendMessage',
                    '-H', 'Content-Type: application/json',
                    '-d', json.dumps({'chat_id': CHAT_ID, 'text': text})],
                   timeout=15, capture_output=True)
except Exception: pass
sys.exit(0)
