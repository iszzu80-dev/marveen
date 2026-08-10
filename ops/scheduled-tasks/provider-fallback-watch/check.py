#!/usr/bin/env python3
# Provider-dry failover + recovery watcher (card 16a25d46).
#
# WHY THIS EXISTS: on 2026-08-08 the DeepSeek balance hit 402 and every agent
# sitting on it stopped SILENTLY -- no alert, no fallback. Ten agents dead,
# one fix short of a milestone, and it was found only by a human reading a
# tmux pane. The existing capacity-routing floor only covers the OTHER
# direction (Claude quota exhausted -> DeepSeek). This closes the gap.
#
# DESIGN (Istvan, 2026-08-08: "ha valami elfogy mindig legyen fallback de
# alapban mindenki a legoptimalisabbon fusson"):
#   - Automatic BOTH ways. Approval-per-event is not automation: it guarantees
#     the stall lasts until a human notices, which is the bug being fixed.
#   - The RETURN leg matters more than the failover. Failover is loud and
#     urgent; reverting to the cheap model is invisible and easy to forget.
#   - Safety lives in engineering limits, not in asking permission:
#       * only agents that are ACTUALLY stalled are moved (never idle ones,
#         which would just burn Claude quota for nothing),
#       * recovery is proven by a REAL call, not by a balance number -- a
#         freshly topped-up balance can still throw a transient 402 on the
#         first call,
#       * MAX_AUTO_FAILOVER caps blast radius; above it we alert instead,
#       * every switch is logged with reason + timestamp so spend is auditable.
#
# NO LLM. Deterministic, runs from cron. Silent when nothing changed.

import json, os, subprocess, sys, time

HOME = os.path.expanduser('~')
REPO = os.path.join(HOME, 'marveen')
AGENTS_DIR = os.path.join(REPO, 'agents')
STATE_FILE = os.path.join(REPO, 'store/provider-fallback-state.json')
CHAT_ID = '8942301795'
DASH = 'http://localhost:3420'

# --- policy knobs (engineering limits, not per-event approval) -------------
FALLBACK_MODEL = 'claude-sonnet-5'   # where stalled producers go
PRIMARY_MATCH = 'deepseek'           # models considered "primary/cheap"
BALANCE_FLOOR = 1.0                  # USD; below this we do not attempt recovery
EARLY_WARN_AT = 1.5                  # USD; warn before it hits zero
MAX_AUTO_FAILOVER = 6                # above this, alert instead of switching
SAVED_KEY = '_model_before_auto_fallback'
STALL_PAT = 'Insufficient Balance|402 |API Error: 402'


def dash_token():
    try:
        return open(os.path.join(REPO, 'store/.dashboard-token')).read().strip()
    except Exception:
        return ''


def bot_token():
    try:
        for line in open(os.path.join(REPO, '.env')):
            if line.startswith('TELEGRAM_BOT_TOKEN=') or line.startswith('BOT_TOKEN='):
                return line.split('=', 1)[1].strip()
    except Exception:
        pass
    return ''


def load_state():
    try:
        return json.load(open(STATE_FILE))
    except Exception:
        return {}


def save_state(st):
    st['updated'] = int(time.time())
    try:
        json.dump(st, open(STATE_FILE, 'w'), indent=2)
    except Exception:
        pass


def tmux_sessions():
    try:
        out = subprocess.run(['tmux', 'ls'], capture_output=True, text=True, timeout=15).stdout
    except Exception:
        return []
    names = []
    for line in out.splitlines():
        s = line.split(':', 1)[0]
        if s.startswith('agent-'):
            names.append(s[len('agent-'):])
    return names


def pane_has_stall_marker(agent, lines=6):
    """Boolean only -- never surface pane CONTENT (it can hold sensitive text).

    CAUTION (found while testing this watcher before arming it, 2026-08-08):
    a pane grep ALONE is not evidence of a live stall. After the fleet
    recovered, two perfectly healthy agents still had the earlier 402 sitting
    in their scrollback -- arming on that signal alone would have switched
    healthy agents onto the expensive model for nothing. So: look only at the
    LAST few lines (a working agent pushes the old error up and out), and the
    caller MUST corroborate with the provider balance before acting.
    """
    try:
        r = subprocess.run(
            f"tmux capture-pane -t agent-{agent} -p -S -{lines} | grep -qE '{STALL_PAT}'",
            shell=True, timeout=15)
        return r.returncode == 0
    except Exception:
        return False


def cfg_path(agent):
    return os.path.join(AGENTS_DIR, agent, 'agent-config.json')


def read_cfg(agent):
    try:
        return json.load(open(cfg_path(agent)))
    except Exception:
        return None


def write_cfg(agent, d):
    json.dump(d, open(cfg_path(agent), 'w'), indent=2, ensure_ascii=False)


def restart(agent, tok):
    subprocess.run(['curl', '-s', '-X', 'POST', f'{DASH}/api/agents/{agent}/restart',
                    '-H', 'Content-Type: application/json',
                    '-H', f'Authorization: Bearer {tok}',
                    '-d', '{"mode":"continue"}'],
                   capture_output=True, timeout=60)


def provider_balance():
    """Latest DeepSeek balance snapshot, or None if unknown (fail-safe: unknown
    means we do NOT claim recovery)."""
    q = ("SELECT balance FROM provider_balance_snapshots WHERE lower(provider) "
         "LIKE '%deepseek%' ORDER BY captured_at DESC LIMIT 1")
    code = (
        "const D=require('%s/node_modules/better-sqlite3');"
        "const db=new D('%s/store/claudeclaw.db',{readonly:true});"
        "const r=db.prepare(\"%s\").get();"
        "console.log(r?r.balance:'')" % (REPO, REPO, q)
    )
    try:
        out = subprocess.run(['node', '-e', code], capture_output=True, text=True,
                             timeout=30, cwd=REPO).stdout.strip()
        return float(out) if out else None
    except Exception:
        return None


def daily_log(tok, text):
    subprocess.run(['curl', '-s', '-X', 'POST', f'{DASH}/api/daily-log',
                    '-H', 'Content-Type: application/json',
                    '-H', f'Authorization: Bearer {tok}',
                    '-d', json.dumps({'agent_id': 'marveen', 'content': text})],
                   capture_output=True, timeout=30)


def telegram(text):
    bt = bot_token()
    if not bt:
        return
    subprocess.run(['curl', '-s', '-X', 'POST',
                    f'https://api.telegram.org/bot{bt}/sendMessage',
                    '-H', 'Content-Type: application/json',
                    '-d', json.dumps({'chat_id': CHAT_ID, 'text': text})],
                   capture_output=True, timeout=30)


def main():
    tok = dash_token()
    if not tok:
        return
    st = load_state()
    now = time.strftime('%H:%M')
    agents = tmux_sessions()

    on_primary, on_fallback = [], []
    for a in agents:
        c = read_cfg(a)
        if not c:
            continue
        if c.get(SAVED_KEY):
            on_fallback.append(a)
        elif PRIMARY_MATCH in str(c.get('model', '')).lower():
            on_primary.append(a)

    # ---------- 1. FAILOVER: primary-model agents that are actually stalled --
    # TWO independent signals must agree before we spend money:
    #   (a) the agent's recent pane shows the provider error, AND
    #   (b) the provider really is dry (balance below floor, or unknown).
    # Either alone produces false positives: a stale 402 lingers in the
    # scrollback of a recovered agent (observed), and a low balance alone does
    # not mean any agent has actually stopped.
    bal_now = provider_balance()
    provider_looks_dry = (bal_now is None) or (bal_now < BALANCE_FLOOR)
    stalled = [a for a in on_primary if pane_has_stall_marker(a)] if provider_looks_dry else []
    if stalled:
        if len(stalled) > MAX_AUTO_FAILOVER:
            key = 'blast:' + ','.join(sorted(stalled))
            if st.get('last_blast') != key:
                telegram(f"Provider-kieses: {len(stalled)} agens allt meg egyszerre "
                         f"(402). Ez tobb mint az automatikus hatar ({MAX_AUTO_FAILOVER}), "
                         f"ezert NEM valtottam at magamtol. Dontsd el: feltoltes vagy "
                         f"kezi atvaltas. Erintett: {', '.join(sorted(stalled))}")
                st['last_blast'] = key
                save_state(st)
            return
        switched = []
        for a in stalled:
            c = read_cfg(a)
            if not c:
                continue
            c[SAVED_KEY] = c.get('model')
            c['model'] = FALLBACK_MODEL
            write_cfg(a, c)
            restart(a, tok)
            switched.append(a)
        if switched:
            st['failed_over_at'] = int(time.time())
            st.pop('canary', None)
            save_state(st)
            daily_log(tok, f"## {now} -- provider-fallback: FAILOVER "
                           f"{len(switched)} agent -> {FALLBACK_MODEL} "
                           f"(402 detected): {', '.join(switched)}")
            telegram(f"Provider-kieses miatt atvaltottam {len(switched)} agenst "
                     f"a fallback modellre, hogy ne alljon meg a munka: "
                     f"{', '.join(switched)}. Amint az elsodleges ujra el, "
                     f"magatol visszateszem oket az olcsora.")
        return

    # ---------- 2. RECOVERY (staged, proven by a real call) ------------------
    if on_fallback:
        bal = provider_balance()
        if bal is None or bal < BALANCE_FLOOR:
            return  # unknown or still dry -> do not claim recovery

        canary = st.get('canary')
        if canary and canary in on_fallback:
            return  # canary still marked as fallback: config not applied, wait

        if canary and canary not in on_fallback:
            # Canary was reverted in a PREVIOUS run and has since had a real
            # call cycle without stalling -> that is the proof. Revert the rest.
            if pane_has_stall_marker(canary):
                c = read_cfg(canary)   # transient 402 after top-up: push it back
                if c and not c.get(SAVED_KEY):
                    c[SAVED_KEY] = c.get('model')
                    c['model'] = FALLBACK_MODEL
                    write_cfg(canary, c)
                    restart(canary, tok)
                st.pop('canary', None)
                save_state(st)
                return
            reverted = []
            for a in on_fallback:
                c = read_cfg(a)
                if not c or not c.get(SAVED_KEY):
                    continue
                c['model'] = c.pop(SAVED_KEY)
                write_cfg(a, c)
                restart(a, tok)
                reverted.append(a)
            st.pop('canary', None)
            st.pop('failed_over_at', None)
            save_state(st)
            if reverted:
                daily_log(tok, f"## {now} -- provider-fallback: RECOVERY "
                               f"{len(reverted)} agent -> primary (balance {bal} USD, "
                               f"canary {canary} proven by a real call): "
                               f"{', '.join(reverted)}")
                telegram(f"Az elsodleges szolgaltato ujra el (egyenleg {bal} USD), "
                         f"ezert visszatettem {len(reverted)} agenst az olcso "
                         f"modellre. Elotte egy agenssel probaltam ki, hogy ne "
                         f"egy atmeneti hiba miatt valtsak vissza mindenkit.")
            return

        # No canary yet -> revert exactly ONE and let the next run judge it.
        pick = sorted(on_fallback)[0]
        c = read_cfg(pick)
        if c and c.get(SAVED_KEY):
            c['model'] = c.pop(SAVED_KEY)
            write_cfg(pick, c)
            restart(pick, tok)
            st['canary'] = pick
            save_state(st)
            daily_log(tok, f"## {now} -- provider-fallback: canary {pick} -> primary "
                           f"(balance {bal} USD); rest wait for its real-call proof")
        return

    # ---------- 3. EARLY WARNING before it hits zero -------------------------
    bal = provider_balance()
    if bal is not None and bal < EARLY_WARN_AT:
        key = f'warn:{int(bal * 10)}'
        if st.get('last_warn') != key:
            telegram(f"Figyelmeztetes: a DeepSeek egyenleg {bal} USD-re csokkent. "
                     f"Ha nullara fut, a fejleszto-agensek megallnak. Most meg "
                     f"nem alltak meg -- ez elore szolas, nem hibajelzes.")
            st['last_warn'] = key
            save_state(st)
    elif bal is not None and bal >= EARLY_WARN_AT and st.get('last_warn'):
        st.pop('last_warn', None)   # re-arm once it recovers
        save_state(st)


if __name__ == '__main__':
    main()
