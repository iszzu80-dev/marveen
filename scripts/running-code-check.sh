#!/usr/bin/env bash
# running-code-check.sh -- FUT-E az a kod, amit lemertunk?
#
# MIERT LETEZIK. 2026-08-15 hajnalban egy javitas ket kulon ertelemben volt
# "kesz": commitolva, mergelve, a szvit zold -- es kozben az elo dashboard
# EGESZ ESTE a reggeli kodot futtatta, mert a systemd-szolgaltatas a leforditott
# `dist/`-et inditja, es nem volt sem build, sem restart. A bizonyitek ket
# valodi ugy volt, amit a rendszer ejjel maga hozott letre, es amelyek pontosan
# a javitott hibaval szulettek meg.
#
# A `measured.sh` megmondja, MELYIK FAN mertel. Ez azt mondja meg, hogy amit
# mertel, AZ FUT-E. A ketto egyutt fedi le a ket csendes ervenytelenitot:
# rossz fa, illetve jo fa / regi process.
#
# ── AZ EGYETLEN OSSZEHASONLITAS, es miert ez ────────────────────────────────
#
#   a futo process INDULASI IDEJE   vs   a `dist`-be forditodo forrasok
#                                        legfrissebb modositasi ideje
#
# Ez egyetlen kerdessel mindket bukast lefedi, mert egy process csak olyan
# kodot tartalmazhat, ami az INDULASA ELOTT keszult el:
#   - buildeltel, de nem inditottad ujra  -> a dist ujabb, mint a process
#   - nem is buildeltel                   -> a src ujabb, mint a dist
# Mindketto ugyanabban jelenik meg: van forras, ami frissebb a processnel.
#
# ── AMIT SZANDEKOSAN KIHAGY, es ez a load-bearing dontes ────────────────────
#
# A tsconfig `include`-ja `src/**/*`, tehat a TESZTEK IS `dist`-be fordulnak.
# Ebben a repoban 529 teszt- es 390 futtatott forrasfajl van. Ha a tesztek is
# szamitananak, a riasztas gyakorlatilag MINDEN NAP tuzelne, holott a
# szolgaltatas egyetlen tesztfajlt sem tolt be -- es a `detector-scope.ts` sajat
# fejlece mondja ki, mi tortenik olyankor: "egy kapu, ami zajbol tuzel, az a
# kapu, amit kikapcsolnak". Ezert a halmaz: `src/**/*.ts` MINUSZ a tesztek.
#
# ── HARMADIK KILEPESI KOD, mert a "nem tudom" nem "rendben" ─────────────────
#
#   0  a futo kod naprakesz
#   1  ELAVULT: van forras, ami frissebb a futo processnel
#   2  NEM ALLAPITHATO MEG (nincs systemd, nincs ilyen unit, nem fut)
#
# A 2-es kulon kod, nem 0. Egy ellenorzes, ami vaksagbol zoldet mond, rosszabb
# a hianyanal: pontosan akkor hallgat, amikor a legkevesbe tudod, mi fut.

set -u

UNIT="${1:-marveen-dashboard.service}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

# --- a futo process indulasi ideje -----------------------------------------
# TESZT-BEMENET, HANGOSAN. A teszteknek mindket agat meg kell tudni hajtani
# systemd nelkul is, de egy csendes felulbiralas ugyanaz a hibaosztaly, mint
# egy csendes vaksag -- ezert ha be van allitva, a kimenet KIMONDJA.
injected="${RCC_SERVICE_START_EPOCH:-}"
if [ -n "$injected" ]; then
  echo "  FIGYELEM: a process indulasi ideje INJEKTALVA ($injected) -- ez teszt-uzemmod,"
  echo "            valos meresnek NEM tekintheto"
  start_epoch="$injected"
elif ! command -v systemctl >/dev/null 2>&1; then
  echo "  NEM ALLAPITHATO MEG: nincs systemctl ezen a gepen." >&2
  echo "  Ez nem 'rendben' -- azt jelenti, hogy a muszer nem tud odanezni." >&2
  exit 2
else
  stamp="$(systemctl --user show "$UNIT" -p ActiveEnterTimestamp --value 2>/dev/null)"
  if [ -z "$stamp" ]; then
    echo "  NEM ALLAPITHATO MEG: a(z) '$UNIT' unit nem ismert, vagy nem fut." >&2
    exit 2
  fi
  start_epoch="$(date -d "$stamp" +%s 2>/dev/null)"
  if [ -z "$start_epoch" ]; then
    echo "  NEM ALLAPITHATO MEG: az idobelyeg nem ertelmezheto: '$stamp'" >&2
    exit 2
  fi
fi

# --- a legfrissebb FUTTATOTT forras ----------------------------------------
newest_file=""
newest_epoch=0
while IFS= read -r f; do
  m="$(stat -c %Y "$f" 2>/dev/null || echo 0)"
  if [ "$m" -gt "$newest_epoch" ]; then newest_epoch="$m"; newest_file="$f"; fi
done < <(find "$REPO/src" -name '*.ts' ! -path '*__tests__*' ! -name '*.test.ts')

if [ -z "$newest_file" ]; then
  echo "  NEM ALLAPITHATO MEG: egyetlen futtatott forrasfajlt sem talaltam a src/ alatt." >&2
  exit 2
fi

fmt() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "@$1"; }

echo "── FUT-E, AMIT MERTUNK ──────────────────────────────────────────"
printf '  unit            : %s\n' "$UNIT"
printf '  process indult  : %s (UTC)\n' "$(fmt "$start_epoch")"
printf '  legfrissebb src : %s (UTC)\n' "$(fmt "$newest_epoch")"
printf '  ez a fajl       : %s\n' "${newest_file#"$REPO"/}"

if [ "$newest_epoch" -gt "$start_epoch" ]; then
  echo "  ELAVULT: a forras frissebb, mint a futo process."
  echo "  A meres a repoban ervenyes lehet, de NEM arrol szol, ami fut."
  echo "  Teendo: npm run build && systemctl --user restart $UNIT"
  exit 1
fi

echo "  RENDBEN: a futo process ujabb minden futtatott forrasnal."
exit 0
