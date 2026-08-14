#!/usr/bin/env bash
# measured.sh -- futtat egy parancsot, es a KIMENETE MELLE odairja, HOL futott.
#
# MIERT LETEZIK. 2026-08-14-en harom szam volt hamis egy nap alatt, es EGYIK SEM
# a kodrol szolt:
#
#   1. `node ... | tail -3` -- a jelentett `exit=0` a `tail` kilepesi kodja volt,
#      nem a `node`-e. A ket szvit-guard valojaban 1-gyel lepett ki.
#   2. `pyflakes "$probe" | grep -q "undefined name"` -- `pipefail` alatt a
#      pipeline a pyflakes 1-es kodjat orokli, tehat a pozitiv kontroll pont
#      akkor mondott "halott muszert", amikor a proba MUKODOTT.
#   3. `npx vitest run` a rossz konyvtarbol -- 13 628 teszt egy 7 059-es
#      repoban, mert a futas mind a harom repot begyujtotte. A 117 "bukas"
#      idegen tesztekbol jott.
#
# A harom kozos nevezoje nem a hanyagsag, hanem az, hogy A KIMENET NEM
# HORDOZTA A SAJAT KORULMENYEIT. Egy "523 passed" onmagaban nem allitas: az
# allitas az, hogy MELYIK fan, MELYIK agon, MILYEN allapotban.
#
# Ezert ez a burkolo. Nem ellenoriz semmit, es szandekosan nem: nem az a dolga,
# hogy megmondja, jo-e az eredmeny, hanem hogy az eredmeny mellett ott legyen a
# helye. Egy kapu, ami itelkezik, vitatkozni valo; egy bizonyitvany, ami
# rogzit, nem.
#
# HASZNALAT
#   scripts/measured.sh npx vitest run
#   scripts/measured.sh -- npm test          # `--` ha a parancs sajat flagekkel indul
#
# KILEPESI KOD: a burkolt parancs SAJAT kodja, valtozatlanul. Ez a szkript
# egyetlen load-bearing tulajdonsaga -- ha valaha elnyelne vagy atirna, pontosan
# az 1-es szamu hibat gyartana ujra, csak eggyel feljebb.

set -u

if [ "${1:-}" = "--" ]; then shift; fi
if [ "$#" -eq 0 ]; then
  echo "measured.sh: nincs mit futtatni. Hasznalat: scripts/measured.sh <parancs> [argumentumok]" >&2
  exit 2
fi

# --- POZITIV KONTROLL a muszerre magara -------------------------------------
# Ha a helyet nem tudjuk megallapitani, az NEM "ismeretlen hely" egy amugy
# ervenyes meres mellett -- az azt jelenti, hogy a bizonyitvany ures lenne, es
# egy ures bizonyitvany rosszabb a hianyanal, mert ugy nez ki, mintha lenne.
cwd="$(pwd -P)" || { echo "measured.sh: a munkakonyvtar nem allapithato meg" >&2; exit 2; }

# KI merte. Ketten dolgozunk ugyanazon a repon, KET KULON FABAN, es a ket
# checkout utja hasonlit. Egy beillesztett "528 passed" onmagaban nem mondja
# meg, melyikunk fajan szuletett -- 2026-08-15-en ez ket alkalommal is szamitott
# egy nap alatt. A konvencio ("irjuk oda kezzel") ugyanaz a hibaosztaly, mint
# amit ez a szkript megszuntet: olyasmi, amire EMLEKEZNI kell. Ezert a muszer
# irja, nem a jelentes iroja.
who="$( { id -un; } 2>/dev/null || echo '?' )@$( { hostname; } 2>/dev/null || echo '?' )"

if git rev-parse --git-dir >/dev/null 2>&1; then
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  head_sha="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
  # `git status --porcelain` ures kimenete = tiszta fa. A sorok szama az, ami
  # egy meres ervenyesseget eldontheti: egy piszkos fan mert zold nem a
  # commitolt kodrol szol.
  dirty="$(git status --porcelain 2>/dev/null | grep -c . || true)"
  repo_state="ag=$branch  HEAD=$head_sha  piszkos_fajl=$dirty"
else
  # Ez legitim (nem minden meres git-fan tortenik), de KI KELL MONDANI.
  # A 3-as szamu hiba pont igy nezett ki: a futas utani `git status` "not a git
  # repository"-t adott, es az volt az egyetlen jel, hogy rossz helyen alltunk.
  branch=""; head_sha=""; dirty=""
  repo_state="NEM GIT-FA -- ha ezt nem vartad, valoszinuleg rossz konyvtarbol futtatsz"
fi

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

printf '%s\n' "── MERES ────────────────────────────────────────────────────────"
printf '  parancs   : %s\n' "$*"
printf '  konyvtar  : %s\n' "$cwd"
printf '  merte     : %s\n' "$who"
printf '  %s\n' "$repo_state"
printf '  indult    : %s (UTC)\n' "$started"
printf '%s\n' "─────────────────────────────────────────────────────────────────"

# Nincs cso, nincs `set -e`, nincs `$?` felulirasa kozben: a parancs kozvetlenul
# fut, es a kodjat AZONNAL elkapjuk. Minden mas sorrend az 1-es hibat kockaztatja.
"$@"
status=$?

finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -n "$branch" ]; then
  dirty_after="$(git status --porcelain 2>/dev/null | grep -c . || true)"
  after_note="piszkos_fajl_utana=$dirty_after"
  # A meres KOZBEN valtozott fa a masik csendes ervenytelenito: egy vitest-futas
  # alatt cserelt fajl eredmenye nem bizonyitek. Ha a ket szam elter, a meres
  # NEM ervenytelen automatikusan -- de a kimenetbol latszania kell.
  if [ "$dirty_after" != "$dirty" ]; then
    after_note="$after_note  FIGYELEM: a fa VALTOZOTT a meres alatt ($dirty -> $dirty_after)"
  fi
else
  after_note=""
fi

printf '%s\n' "─────────────────────────────────────────────────────────────────"
printf '  befejezodott: %s (UTC)\n' "$finished"
printf '  kilepesi kod: %s\n' "$status"
[ -n "$after_note" ] && printf '  %s\n' "$after_note"
printf '%s\n' "── MERES VEGE ───────────────────────────────────────────────────"

exit "$status"
