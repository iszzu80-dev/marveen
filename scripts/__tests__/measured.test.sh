#!/bin/bash
# Unit tests for scripts/measured.sh -- a burkoloert, ami minden meres melle
# odairja, HOL futott.
#
# A tesztek sorrendje szandekos: az ELSO ketto a szkript egyetlen load-bearing
# tulajdonsagat allitja (a burkolt parancs kilepesi kodja valtozatlanul jut
# tovabb), mert ha az elromlik, a szkript pontosan azt a hibat gyartja ujra,
# ami ellen keszult.
#
# Run: bash scripts/__tests__/measured.test.sh

set -u

PASS=0
FAIL=0
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
M="$ROOT/scripts/measured.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (vart: $2, kapott: $3)"; fi; }

echo "measured.sh"

# ── 1. A kilepesi kod valtozatlanul jut tovabb ─────────────────────────────
# EZ A LENYEG. A 2026-08-14-i elso hiba az volt, hogy egy cso miatt a `tail`
# kodjat olvastuk a `node`-e helyett; egy burkolo, ami ugyanezt teszi, nem
# javitas, hanem a hiba intezmenyesitese.
bash "$M" true >/dev/null 2>&1
check "sikeres parancs -> 0" 0 $?

bash "$M" sh -c 'exit 7' >/dev/null 2>&1
check "bukott parancs -> a SAJAT kodja (7), nem 0 es nem 1" 7 $?

bash "$M" sh -c 'exit 2' >/dev/null 2>&1
check "a 2-es kod sem olvad ossze az 1-essel" 2 $?

# ── 2. A csovezes nem nyeli el a kodot ─────────────────────────────────────
# A hivo oldalan is konnyu elrontani, ezert kimondjuk: a szkript kimenete
# csovezheto UGY, hogy a kodja tovabbra is a burkolt parancse -- ha a hivo
# pipefail-t hasznal.
( set -o pipefail; bash "$M" sh -c 'exit 5' 2>/dev/null | tail -1 >/dev/null )
check "pipefail alatt csovezve is a burkolt parancs kodja jon" 5 $?

# ── 3. A bizonyitvany tenyleg ott van a kimenetben ─────────────────────────
out=$(bash "$M" true 2>&1)
case "$out" in *"konyvtar"*) ok "a kimenet megnevezi a munkakonyvtarat" ;;
                          *) bad "a kimenetbol hianyzik a munkakonyvtar" ;; esac
case "$out" in *"$ROOT"*)    ok "a kimenetben a VALODI ut szerepel" ;;
                          *) bad "a kimenetben nem a valodi ut szerepel" ;; esac
case "$out" in *"kilepesi kod: 0"*) ok "a kimenet kiirja a kilepesi kodot" ;;
                          *) bad "a kimenetbol hianyzik a kilepesi kod" ;; esac

# ── 4. Git-fan a HELY, git-fan kivul a HIANY neveződik meg ─────────────────
out=$(cd "$ROOT" && bash "$M" true 2>&1)
case "$out" in *"ag="*) ok "git-faban megnevezi az agat" ;;
                     *) bad "git-faban nem irja ki az agat" ;; esac

# A 3-as szamu hiba alakja: rossz konyvtarbol futtatva a szkript ezt KIMONDJA,
# nem pedig ures mezoket ir. Egy ures bizonyitvany rosszabb a hianyanal.
out=$(cd "$TMP" && bash "$M" true 2>&1)
case "$out" in *"NEM GIT-FA"*) ok "git-fan kivul HANGOSAN mondja, hogy nem git-fa" ;;
                            *) bad "git-fan kivul nem jelzi a hianyt" ;; esac

# ── 5. Ures hivas: nem csendes no-op ───────────────────────────────────────
# Egy burkolo, ami parancs nelkul 0-val ter vissza, "lefutott es rendben"-nek
# olvasodik egy szkriptben, ahol a parancs veletlenul ures valtozo lett.
bash "$M" >/dev/null 2>&1
check "parancs nelkul 2-vel all meg, nem 0-val" 2 $?

# ── 6. A fa valtozasa a meres ALATT lathatova valik ────────────────────────
# Ez a masodik csendes ervenytelenito, amibe 2026-08-14-en beleszaladtunk: egy
# vitest-futas alatt cserelt fajl eredmenye nem bizonyitek.
probe="$ROOT/.measured-probe-$$"
out=$(cd "$ROOT" && bash "$M" sh -c "touch '$probe'" 2>&1)
rm -f "$probe"
case "$out" in *"a fa VALTOZOTT a meres alatt"*) ok "jelzi, ha a fa valtozott futas kozben" ;;
                                              *) bad "nem jelezte a fa valtozasat" ;; esac

# ── 7. A meres megnevezi, KI merte ─────────────────────────────────────────
# Ketten merunk ket kulon fabam ugyanazon a repon. Nem eleg, hogy legyen egy
# "merte:" sor -- annak a VALODI felhasznalot kell tartalmaznia, kulonben egy
# uresen maradt mezo pontosan ugy nez ki, mint egy kitoltott.
out=$(cd "$ROOT" && bash "$M" true 2>&1)
me="$(id -un 2>/dev/null || echo '?')"
case "$out" in *"merte"*) ok "a kimenet megnevezi, ki merte" ;;
                       *) bad "a kimenetbol hianyzik a mero azonositoja" ;; esac
# POZITIV KONTROLL a mezore magara: a VALODI felhasznalonev alljon ott. E nelkul
# egy `merte : @` sor is atmenne a fenti ellenorzesen.
case "$out" in *"merte     : $me@"*) ok "a mezoben a valodi felhasznalonev all" ;;
                                  *) bad "a 'merte' mezo nem a valodi felhasznalot tartalmazza" ;; esac

# ── 8. A szkript KOZVETLENUL futtathato ────────────────────────────────────
# Minden fenti teszt `bash "$M"`-mel hiv, ami akkor is mukodik, ha a futtatasi
# bit lehullott -- vagyis a szvit szerkezetileg vak volt pontosan arra a hibara,
# amit 2026-08-15-en el is kovettem: egy mutacios kor `mv /tmp`-bol
# visszamasolta a fajlt 644-gyel, es a commit ezt vitte tovabb. A dokumentalt
# hasznalat (`scripts/measured.sh npx vitest run`) onnantol `Permission denied`.
# Ezert ez az EGY teszt nem `bash`-sel indit, hanem ugy, ahogy a README mondja.
"$M" true >/dev/null 2>&1
check "kozvetlenul futtatva is lefut (a futtatasi bit megvan)" 0 $?

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
