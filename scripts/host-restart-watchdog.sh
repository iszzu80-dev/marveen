#!/usr/bin/env bash
# host-restart-watchdog.sh  [--dry-run]
#
# Fires once at every user-manager start (oneshot, WantedBy=default.target).
# Under WSL2 the whole utility VM can shut down and re-boot (vmIdleTimeout
# auto-shutdown, Windows sleep/resume, `wsl --shutdown`), which tears down the
# kernel + system/user systemd + tmux + dashboard + channels all at once and is
# NOT an application crash. This watchdog detects that host/VM restart via the
# kernel boot time (/proc/stat btime) and sends ONE Telegram notice that names
# it as a host/WSL-VM restart (with an estimated downtime), so a fleet-wide
# silence is never mistaken for a CostOps/app crash.
#
# App/service crashes do NOT change btime and never trigger this script -- they
# are reported separately by the OnFailure= drop-ins (marveen-notify@.service).
#
# BLIND SPOT it closes (2026-07-09 incident): systemd-logind can drive a full
# `power off now` -> poweroff.target -> re-init on the SAME kernel boot (btime
# UNCHANGED), often with a concurrent OOM kill of app.slice/user.slice. The old
# script treated every btime-unchanged fire as a benign user-manager restart and
# stayed SILENT -- so that outage was invisible. Now the btime-unchanged branch
# also scans the recent journal for a poweroff / OOM signature and alerts on it,
# deduped by the event's own timestamp so genuinely distinct events each notify
# but a repeated fire for the same event does not spam.
#
# Four cases distinguished:
#   1. host / WSL VM reboot          -> btime changed
#   2. plain user-manager restart    -> btime unchanged, no poweroff/OOM in journal (silent)
#   3. systemd poweroff, same boot   -> btime unchanged + poweroff.target in journal
#   4. OOM / slice kill              -> OOM-killer signature in journal (highest severity)
#
# Safe by construction: read-only except for its state files; journal read is
# best-effort (missing/denied journal => no false alert); Telegram send is
# best-effort; the script always exits 0 so the oneshot unit never enters
# `failed` (a failing watchdog would itself look like an incident).
# --dry-run: detect + log what it WOULD send, but send nothing and touch no state.

set -uo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

STATE_DIR="${MARVEEN_STORE:-$HOME/marveen/store}"
STATE_FILE="$STATE_DIR/.last-btime"
EVENT_STATE="$STATE_DIR/.last-poweroff-event"   # epoch of last poweroff/OOM event already alerted
ENV_FILE="${TELEGRAM_ENV:-$HOME/.claude/channels/telegram/.env}"
CHAT_ID="${MARVEEN_ALERT_CHAT_ID:-8942301795}"
# How far back to scan the journal for a poweroff/OOM fingerprint. Overridable
# for testing against an older window (e.g. MARVEEN_WATCHDOG_LOOKBACK="2026-07-09 08:00").
LOOKBACK="${MARVEEN_WATCHDOG_LOOKBACK:-20 min ago}"

log() { echo "[host-restart-watchdog] $*"; }

# Best-effort Telegram send. Never let a send failure fail the unit.
send_tg() {
  local msg="$1"
  if (( DRY_RUN )); then
    log "DRY-RUN: would send Telegram:"; log "$msg"; return 0
  fi
  local token=""
  if [[ -f "$ENV_FILE" ]]; then
    token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n')"
  fi
  if [[ -n "$token" ]]; then
    curl -s --max-time 15 \
      "https://api.telegram.org/bot${token}/sendMessage" \
      --data-urlencode "chat_id=${CHAT_ID}" \
      --data-urlencode "text=${msg}" >/dev/null 2>&1 \
      && log "Telegram sent" || log "Telegram send failed (best-effort)"
  else
    log "no TELEGRAM_BOT_TOKEN in $ENV_FILE; skipping Telegram (event still logged)"
  fi
}

# Scan the recent journal for a systemd-poweroff / OOM-kill fingerprint.
# Sets globals: SIG_OOM (0/1), SIG_POWEROFF (0/1), SIG_EPOCH (newest matching
# event epoch, 0 if none). Degrades to "nothing found" if journalctl is
# unavailable or denied -- never invents an event.
scan_journal_signature() {
  SIG_OOM=0; SIG_POWEROFF=0; SIG_EPOCH=0
  local lines
  # Anchor on the systemd/logind/kernel SOURCE identifier so we only ever match
  # the real events -- never a downstream log line (e.g. the stale-hook recovery
  # script, or this watchdog's own journalctl grep) that merely QUOTES the phrase.
  # short-unix line: "<epoch> <host> <identifier>: <msg>".
  lines="$(journalctl --since "$LOOKBACK" -o short-unix --no-pager 2>/dev/null \
            | grep -iE '(systemd(-logind)?\[[0-9]+\]|kernel): .*(power off now|Reached target poweroff\.target|OOM killer killed)' 2>/dev/null)"
  [[ -z "$lines" ]] && return 0
  echo "$lines" | grep -qiE 'OOM killer killed' && SIG_OOM=1
  echo "$lines" | grep -qiE 'power off now|poweroff.target' && SIG_POWEROFF=1
  local ep ei
  while read -r ep _; do
    ei="${ep%.*}"
    [[ "$ei" =~ ^[0-9]+$ ]] || continue
    (( ei > SIG_EPOCH )) && SIG_EPOCH="$ei"
  done <<< "$lines"
  return 0
}

# Current kernel boot epoch (changes only on a real (re)boot of the VM/host).
btime="$(awk '/^btime/{print $2}' /proc/stat 2>/dev/null)"
if [[ -z "${btime:-}" ]]; then
  log "no btime in /proc/stat; nothing to do"
  exit 0
fi

mkdir -p "$STATE_DIR" 2>/dev/null || true
prev=""
[[ -f "$STATE_FILE" ]] && prev="$(tr -dc '0-9' <"$STATE_FILE" 2>/dev/null)"

# Persist the current btime for the next run no matter what happens below
# (except in --dry-run, which must be side-effect free).
(( DRY_RUN )) || echo "$btime" >"$STATE_FILE" 2>/dev/null || true

# Always look for a poweroff/OOM fingerprint; both branches below use it.
scan_journal_signature
sig_local="ismeretlen idő"
(( SIG_EPOCH > 0 )) && sig_local="$(date -d "@$SIG_EPOCH" '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null || echo "@$SIG_EPOCH")"

if [[ -z "$prev" ]]; then
  log "baseline initialised (btime=$btime); no alert on first run"
  # Seed the event-dedupe baseline too so a pre-existing old event never
  # alerts on the very first run after install.
  (( DRY_RUN )) || { (( SIG_EPOCH > 0 )) && echo "$SIG_EPOCH" >"$EVENT_STATE" 2>/dev/null || true; }
  exit 0
fi

if [[ "$prev" == "$btime" ]]; then
  # btime UNCHANGED: normally a benign user-manager restart -- BUT it can also be
  # a same-boot systemd poweroff and/or an OOM kill. Alert only on a NEW event.
  if (( SIG_OOM || SIG_POWEROFF )); then
    prev_ev=""
    [[ -f "$EVENT_STATE" ]] && prev_ev="$(tr -dc '0-9' <"$EVENT_STATE" 2>/dev/null)"
    if (( SIG_EPOCH > 0 )) && [[ "${prev_ev:-0}" != "$SIG_EPOCH" ]] && (( SIG_EPOCH > ${prev_ev:-0} )); then
      if (( SIG_OOM )); then
        cause="OOM / slice-kill (memória-nyomás) -- a kernel OOM killer processeket ölt (app/user.slice)"
      else
        cause="systemd poweroff UGYANAZON a kernel-booton (WSL/host-vezérelt teardown, NEM app-crash)"
      fi
      msg="Marveen flotta-leállás: ${cause}.
Esemény ideje: ${sig_local}
A kernel NEM bootolt újra (btime változatlan) -- ezt a régi btime-figyelő elnézte volna.
A user-manager + dashboard + channels már újraindult. Ha OOM: memória-nyomás áll fenn, nézd a párhuzamos agent-számot."
      log "btime unchanged but poweroff/OOM signature detected (epoch=$SIG_EPOCH, oom=$SIG_OOM, poweroff=$SIG_POWEROFF); alerting"
      send_tg "$msg"
      (( DRY_RUN )) || echo "$SIG_EPOCH" >"$EVENT_STATE" 2>/dev/null || true
    else
      log "btime unchanged; poweroff/OOM signature already alerted (event epoch=$SIG_EPOCH, prev=$prev_ev); no re-alert"
    fi
  else
    log "btime unchanged ($btime), no poweroff/OOM in journal -- benign user-manager restart; no alert"
  fi
  exit 0
fi

# --- host/VM restart detected (btime changed) ---
boot_local="$(date -d "@$btime" '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null || echo "@$btime")"

# Estimate downtime: newest store/*.log mtime that predates this boot ~= last
# fleet activity before the VM went down. gap = boot_time - that mtime.
last_alive=0
if compgen -G "$STATE_DIR/*.log" >/dev/null 2>&1; then
  for f in "$STATE_DIR"/*.log; do
    m="$(stat -c '%Y' "$f" 2>/dev/null || echo 0)"
    if (( m < btime && m > last_alive )); then last_alive="$m"; fi
  done
fi
gap_txt="ismeretlen"
if (( last_alive > 0 )); then
  gap_min=$(( (btime - last_alive) / 60 ))
  last_txt="$(date -d "@$last_alive" '+%H:%M:%S' 2>/dev/null || echo '?')"
  gap_txt="~${gap_min} perc (utolsó aktivitás ${last_txt} előtt)"
fi

oom_note=""
(( SIG_OOM )) && oom_note="
FIGYELEM: OOM-kill jel is látszott a leállás körül (${sig_local}) -- memória-nyomás."

msg="Marveen host / WSL VM restarted.
Új boot: ${boot_local}
Becsült kiesés: ${gap_txt}
(Ez host/VM szintű restart, NEM app-crash. A dashboard/channels app-crash külön OnFailure-értesítést küld.)${oom_note}"

log "host restart detected: prev btime=$prev new=$btime (oom=$SIG_OOM); sending Telegram"
send_tg "$msg"
# Record the event so the same OOM isn't re-alerted by a later same-boot fire.
(( DRY_RUN )) || { (( SIG_EPOCH > 0 )) && echo "$SIG_EPOCH" >"$EVENT_STATE" 2>/dev/null || true; }

exit 0
