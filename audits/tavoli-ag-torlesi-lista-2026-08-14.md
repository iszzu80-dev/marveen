# Távoli ág-törlési lista — FÜGGETLEN MÁSODIK RÖGZÍTÉS

**Dátum:** 2026-08-14 · **Készítette:** Marveen · **Állapot:** ELŐKÉSZÍTVE, NEM VÉGREHAJTVA

A törlés Istvan közvetlen GO-jára vár. Ez a fájl azért létezik, mert egy fel nem
jegyzett SHA-t egy törölt távoli ref után semmi nem hoz vissza: a helyi reflog a
másik gépen nincs meg, a GitHub pedig a ref törlésével elengedi.

Mérési mód mindkét listán: `git merge-base --is-ancestor <ág> <default>` ÉS
`git cherry <default> <ág>` (patch-id) — utóbbi nulla egyedi commitot mutat.

---

## 1. marveen-private (default: `private/develop` = `250359eb4efc`)

| Ág | Fej-SHA | Egyedi commit |
|---|---|---|
| `claude/apg-review-fixes-qe1z7m` | `616053f27b34` | 0 |
| `claude/cos-autonom-code-review-qv04y2` | `509ace1dbbf0` | 0 |
| `claude/cos-review-fixes-qe1z7m` | `d217745ad552` | 0 |
| `claude/costops-agp-lean-review-mksxlj` | `c955093518aa` | 0 |
| `claude/costops-review-fixes-qe1z7m` | `7132cd32b235` | 0 |
| `claude/marveen-code-review-rizx4k` | `05ca16bef409` | 0 |
| `claude/marveen-cos-code-review-qe1z7m` | `47b788ec37f8` | 0 |
| `claude/marveen-review-decisions-98abi4` | `250359eb4efc` | 0 |
| `claude/progression-v131-fixes-qe1z7m` | `b2160e4ecf48` | 0 |
| `cos-review-fixes-2026-08-10` | `5c151c2ec0c3` | 0 |
| `private` (ág, nem távoli név) | `250359eb4efc` | 0 |

**NEM törlendő, bár a mérés bevonná:** `private/main` (`05ca16bef409`) — ez a repó
másik állandó ága, nem munkaág.

## 2. marveen-apg-kernel (default: `origin/main` = `db47bea1183b`)

| Ág | Fej-SHA | Egyedi commit |
|---|---|---|
| `claude/apg-kernel-review-fixes-qe1z7m` | `f93ff58ebf3f` | 0 |
| `claude/costops-agp-lean-review-mksxlj` | `0c3b9618bfe5` | 0 |
| `claude/marveen-code-review-rizx4k` | `79613ab15ef2` | 0 |
| `claude/marveen-cos-code-review-qe1z7m` | `cf610f1c1315` | 0 |
| `claude/marveen-review-decisions-98abi4` | `db47bea1183b` | 0 |
| `fix/merge-three-failures-and-the-last-owner-path` | `2d5590cc19bd` | 0 |
| `wp1-slice1-executor-registry` | `79613ab15ef2` | 0 |

**MEGTARTANDÓ, mert friss és nincs bemergelve:**
`fix/module-scope-import-that-killed-the-feed` (a mai feed-javítás + a modul-import őr).

---

## 3. Eltérés a társ méréséhez képest

A társ 15 távoli ágat mért (9 privát + 6 kernel). Én 11-et és 7-et találok, a
`private/main` kizárásával 10 + 7 = **17**. A különbség nem hiba egyik oldalon
sem, hanem **más halmazdefiníció**: nem tudom, ő kizárta-e a `main`-t, a
`private` nevű ágat, és a saját, ma keletkezett ágait.

Ezért törlés előtt a végrehajtó listát KI KELL írni és egyeztetni — a
„tizenöt" szó két különböző halmazra hivatkozik, és pont ez az a fajta
eltérés, ami egy visszafordíthatatlan lépésnél számít.

## 4. Amit a törlés parancsa lesz, ha GO jön

```
git push private --delete <ág>      # a private repóban
git push origin  --delete <ág>      # az apg-kernel repóban
```

Előtte a fenti fej-SHA-k innen visszaolvashatók; egy törölt ág ezekből
`git branch <név> <sha>` + push paranccsal visszaállítható, amíg a szemétgyűjtő
el nem viszi az objektumot.
