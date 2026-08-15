#!/bin/bash
# Unit tests for scripts/running-code-check.sh
#
# A tesztek sorrendje szandekos. A szkript HAROM allapotot kulonboztet meg
# (naprakesz / elavult / nem allapithato meg), es a harmadik a legfontosabb:
# egy ellenorzes, ami vaksagbol zoldet mond, pontosan akkor hallgat, amikor a
# legkevesbe tudod, mi fut. Ezert azt allitjuk elsonek.
#
# Run: bash scripts/__tests__/running-code-check.test.sh

set -u

PASS=0
FAIL=0
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
R="$ROOT/scripts/running-code-check.sh"

ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (vart: $2, kapott: $3)"; fi; }

echo "running-code-check.sh"

# ── 1. A "nem tudom" SAJAT kodot kap, nem 0-t ──────────────────────────────
# Egy nem letezo unitre a valasz nem lehet "rendben". Ez a szkript egyetlen
# olyan tulajdonsaga, aminek az elromlasa CSENDES: a 2 helyett 0 ugyanugy nez
# ki egy CI-logban, mint egy sikeres ellenorzes.
env -u RCC_SERVICE_START_EPOCH bash "$R" "nincs-ilyen-unit-$$.service" >/dev/null 2>&1
check "ismeretlen unit -> 2 (nem allapithato meg), NEM 0" 2 $?

# ── 2. ELAVULT allapot: a forras frissebb, mint a process ──────────────────
# A 2026-08-15-i valodi eset alakja: a process reggel indult, a javitas este
# keszult. Epoch 0-val minden forras frissebb.
RCC_SERVICE_START_EPOCH=0 bash "$R" >/dev/null 2>&1
check "regi process + friss forras -> 1 (ELAVULT)" 1 $?

out=$(RCC_SERVICE_START_EPOCH=0 bash "$R" 2>&1)
case "$out" in *"ELAVULT"*) ok "az elavult allapot NEVEN van nevezve a kimenetben" ;;
                         *) bad "az elavult allapot nem jelenik meg a kimenetben" ;; esac
case "$out" in *"npm run build"*) ok "megmondja a teendot is, nem csak a bajt" ;;
                               *) bad "nem mondja meg, mit kell tenni" ;; esac

# ── 3. NAPRAKESZ allapot ───────────────────────────────────────────────────
# Egy jovobeli indulasi idonel minden forras regebbi. POZITIV KONTROLL a masik
# iranyra: e nelkul egy szkript, ami MINDIG 1-et ad, atmenne a 2. teszten.
RCC_SERVICE_START_EPOCH=4102444800 bash "$R" >/dev/null 2>&1
check "friss process -> 0 (naprakesz)" 0 $?

# ── 4. A teszt-uzemmod HANGOS ──────────────────────────────────────────────
# Az injektalas nelkul a fenti ket teszt nem lenne megirhato systemd nelkul.
# De egy csendes felulbiralas ugyanaz a hibaosztaly, mint egy csendes vaksag:
# valaki beallitja a kornyezetben, es onnantol a szkript egy kitalalt szamot
# hasonlit ossze, miközben valodi meresnek latszik.
out=$(RCC_SERVICE_START_EPOCH=0 bash "$R" 2>&1)
case "$out" in *"INJEKTALVA"*) ok "az injektalt idot KIMONDJA a kimenet" ;;
                            *) bad "az injektalas csendben marad -- kitalalt szam valodi meresnek latszik" ;; esac

# ── 5. A TESZTFAJLOK NEM SZAMITANAK ────────────────────────────────────────
# EZ A LOAD-BEARING DONTES. A tsconfig `include`-ja `src/**/*`, tehat a tesztek
# is `dist`-be fordulnak -- de a szolgaltatas egyetlen tesztfajlt sem tolt be.
# Ha szamitananak, a riasztas majdnem minden nap tuzelne, es egy zajbol tuzelo
# kaput kikapcsolnak. A teszt egy JOVOBELI mtime-u tesztfajlt hoz letre: a
# szkriptnek tovabbra is naprakesznek kell latnia a rendszert.
#
# A DATUM ITT NEM MINDEGY, es az elso valtozatban rossz volt: 2099-es mtime-ot
# adtam egy 2100-as injektalt indulasi ido melle, tehat a proba REGEBBI volt a
# processnel. Az allitas igy TAUTOLOGIA lett -- akkor is zold, ha a tesztfajlok
# szamitanak. A probanak UJABBNAK kell lennie a processnel, kulonben nem a
# kizarast meri, hanem semmit.
probe="$ROOT/src/__tests__/.rcc-probe-$$.test.ts"
printf '// atmeneti proba\n' > "$probe"
touch -d "2101-01-01" "$probe" 2>/dev/null || touch "$probe"
RCC_SERVICE_START_EPOCH=4102444800 bash "$R" >/dev/null 2>&1
rc=$?
rm -f "$probe"
check "egy JOVOBELI mtime-u TESZTfajl nem valtja ki a riasztast" 0 $rc

# ── 6. ... de egy futtatott forras IGEN ────────────────────────────────────
# Az 5. teszt onmagaban egy olyan szkriptet is elfogadna, ami soha semmit nem
# vesz eszre. Ez a parja: ugyanaz a mozdulat egy NEM teszt fajlon riasztast ad.
probe2="$ROOT/src/.rcc-probe-$$.ts"
printf 'export const x = 1\n' > "$probe2"
touch -d "2101-01-01" "$probe2" 2>/dev/null || touch "$probe2"
RCC_SERVICE_START_EPOCH=4102444800 bash "$R" >/dev/null 2>&1
rc=$?
rm -f "$probe2"
check "ugyanaz a mozdulat egy FUTTATOTT forrason -> 1 (riaszt)" 1 $rc

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
