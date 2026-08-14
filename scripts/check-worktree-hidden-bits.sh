#!/usr/bin/env bash
# A gep-lokalis elrejto mechanizmusok leltara -- az a vakfolt, amibol 2026-08-14-en
# negy hiba jott.
#
# MIERT NEM CI-BEN FUT EZ. Az elso terv egy GitHub Actions lepes volt. Megmerve:
# egy friss klonban mind az 1701 fajl `H` (normal), mert a skip-worktree es az
# assume-unchanged INDEX-FLAGEK -- a .git/index-ben ulnek, nem a commitokban, es
# soha nem utaznak a repoval. Egy CI-ellenorzes tehat konstrukcio szerint zold
# lenne: egy or, ami nem lathatja azt, amit oriz. Ugyanaz a hibaosztaly, ami ellen
# ez a szkript keszult, csak eggyel feljebb.
#
# Ezert ez a szkript ott fut, ahol a bitek elnek: a fejlesztoi gepen. Utemezett
# feladatbol vagy egy pre-push hookbol hivd.
#
# HAROM MECHANIZMUS, EGY CSALAD -- mindharom ugyanazt tudja: egy elteres soha nem
# jelenik meg a `git status`-ban.
#
#   skip-worktree      a fajl kovetve van, a git a helyi modositasait FIGYELMEN
#                      KIVUL HAGYJA. Megmerve: beallitva, egy valodi modositas
#                      utan a `git status --porcelain` URES kimenetet ad.
#   assume-unchanged   ugyanaz a tunet, mas szandekkal (teljesitmeny-optimalizacio).
#   .git/info/exclude  gep-lokalis ignore-lista. Igy maradt harom cronbol futo
#                      guard-szkript verziokoveteseg nelkul, ugy hogy a
#                      `git status` vegig tisztat mutatott.
#
# POZITIV KONTROLL. A szkript eloszor azt allitja, hogy a MUSZER MERT: ha a
# `git ls-files -v` nem ad kimenetet, az nem "tiszta", hanem "nem tudtam
# megnezni", es ERROR-ral all meg. A nulla talalat csak akkor bizonyitek, ha a
# meres megtortent.

set -uo pipefail

fail=0
checked_trees=0

say()  { printf '%s\n' "$*"; }
bad()  { printf 'TALALAT  %s\n' "$*"; fail=1; }

# Minden worktree kulon indexet hordoz, tehat kulon is kell megnezni. A fo
# checkout is szerepel a listaban.
mapfile -t trees < <(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}')
if [ ${#trees[@]} -eq 0 ]; then
  say "ERROR  a 'git worktree list' semmit nem adott -- ez nem git checkout, vagy a git nem elerheto"
  exit 2
fi

for tree in "${trees[@]}"; do
  [ -d "$tree" ] || { say "ERROR  a worktree utja nem letezik: $tree"; exit 2; }
  checked_trees=$((checked_trees + 1))

  # --- pozitiv kontroll: latunk-e egyaltalan fajlokat ebben a fabant? ---
  total=$(git -C "$tree" ls-files -v 2>/dev/null | wc -l)
  if [ "$total" -eq 0 ]; then
    say "ERROR  $tree: a 'git ls-files -v' nulla sort adott -- a muszer nem mert, ez NEM tiszta allapot"
    exit 2
  fi

  # `S` = skip-worktree. Kisbetus elso karakter = assume-unchanged.
  while IFS= read -r line; do
    [ -n "$line" ] && bad "$tree: skip-worktree -> ${line#* }"
  done < <(git -C "$tree" ls-files -v | grep '^S ' || true)

  while IFS= read -r line; do
    [ -n "$line" ] && bad "$tree: assume-unchanged -> ${line#* }"
  done < <(git -C "$tree" ls-files -v | grep '^[a-z] ' || true)

  # --- .git/info/exclude: a nem-komment, nem-ures sorok ---
  gitdir=$(git -C "$tree" rev-parse --git-dir 2>/dev/null)
  case "$gitdir" in /*) ;; *) gitdir="$tree/$gitdir" ;; esac
  ex="$gitdir/info/exclude"
  if [ -f "$ex" ]; then
    while IFS= read -r pat; do
      [ -n "$pat" ] && bad "$tree: .git/info/exclude -> $pat"
    done < <(grep -vE '^\s*(#|$)' "$ex" || true)
  fi
done

# A globalis excludesFile ugyanez egy szinttel feljebb: egyetlen fajl, ami minden
# repoban rejt, es egyetlen `git status` sem emliti.
gx=$(git config --get core.excludesFile 2>/dev/null || true)
if [ -n "$gx" ] && [ -f "${gx/#\~/$HOME}" ]; then
  while IFS= read -r pat; do
    [ -n "$pat" ] && bad "GLOBAL core.excludesFile ($gx) -> $pat"
  done < <(grep -vE '^\s*(#|$)' "${gx/#\~/$HOME}" || true)
fi

if [ "$fail" -eq 0 ]; then
  say "OK  $checked_trees worktree atvizsgalva, nulla rejtett bit es nulla lokalis exclude-minta."
  say "    (a muszer mert: mindegyik faban volt kovetett fajl)"
fi
exit "$fail"
