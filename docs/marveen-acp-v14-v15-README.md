# Marveen ACP v1.4 / v1.5 — melyik fájl mit mond

**Dátum:** 2026-08-13. Frissítve: **2026-08-16**. Ez a mappa a v1.4 és v1.5 normatív dokumentumkészletét tartja.

## Frissítés — 2026-08-16: current state vs next target

Három külön szerepet kell megkülönböztetni:

1. **v1.4.4 — CURRENT IMPLEMENTED STATE.**  
   A `marveen-autonomous-case-progression-spec-v1.4-proactive-core.md` belső spec-verziója v1.4.4, státusza **implemented baseline**. A dokumentum azt rögzíti, mi fut jelenleg.

2. **v1.4.5 — NEXT HARDENING TARGET.**  
   A `marveen-autonomous-case-progression-spec-v1.4.5-hardening.md` a 2026-08-16-i közös CoS+ACP auditból levezetett **proposed implementation baseline**. Nem állítja, hogy a benne szereplő új gate-ek megépültek. Fő témái: temporal semantic integrity, actionability, consumer completeness, stale-evidence protection, pre-existing backlog proof és promotion gate-ek.

3. **v1.5 — SEPARATE FUTURE RELEASE, NOT BUILT.**  
   A `marveen-autonomous-case-progression-spec-v1.5-external-research-browser-autonomy.md` továbbra is a leválasztott külső kutatás/böngésző-autonómia release. A v1.4.5 **nem lép a helyére** és nem nyit új external execution surface-t.

A CoS-oldali párok:

- **Personal current state:** `marveen-personal-chief-of-staff-v4.3.md`
- **Personal next target:** `marveen-personal-chief-of-staff-v4.4.md`
- **ZST next operational target:** `zst/marveen-zst-radio-chief-of-staff-v1.2.md`

## A jelenlegi készlet

| Fájl | Mi ez |
|---|---|
| `marveen-autonomous-case-progression-spec-v1.4-proactive-core.md` | **v1.4.4 current implemented baseline.** Proaktív észlelés, kvalifikáció és belső előkészítés — nulla új külső végrehajtási felület. |
| `marveen-autonomous-case-progression-spec-v1.4.5-hardening.md` | **Következő hardening target.** Semantic time + complete producer→consumer→receipt lánc + promotion/readiness gate-ek. |
| `marveen-acp-v1.4-acceptance-fixtures.md` | A korábbi v1.4 kötelező elfogadási fixture-jei (`V4-F1`–`V4-F14`). A v1.4.5 további fixture-eket normatívan hozzáad. |
| `marveen-autonomous-case-progression-spec-v1.5-external-research-browser-autonomy.md` | **Leválasztott következő funkcionális release.** Böngésző, külső kutatás, adatkiadás. **NOT BUILT.** |
| `marveen-acp-v1.4-v1.5-release-split-handoff.md` | Miért lett kettévágva, és mi megy át melyik oldalra. |
| `marveen-autonomous-case-progression-spec-v1.4.1-superseded.md` | **Túlhaladott.** Az egyben tartott v1.4.1, a szétvágás előtt. Történeti hivatkozásnak. |

Korábbi baseline-ok ugyanebben a mappában: `...-v1.2.md`, `...-v1.3.md`, `...-v1.3.1.md`.

## Hol tart az implementáció

| Dokumentum | Mit rögzít |
|---|---|
| `audits/v14-proactive-core-capability-audit-2026-08-13.md` | §25 élő capability audit, 1. rész (1–13, 21, 23–24) |
| `audits/v14-proactive-core-capability-audit-part2-2026-08-13.md` | §25 élő capability audit, 2. rész (14–20, 22, 26–31) |
| `audits/v14-audit-nyitott-talalatok-javitva-2026-08-13.md` | Az audit 3., 4. és 13. pontja javítva |
| `docs/cos-v14-proactive-core-stage0-2026-08-13.md` | A §26 sorrend 6., 7., 9., 10. és 21. pontja megépítve |
| `docs/cos-v14-wait-system-es-hatarido-ontologia-2026-08-13.md` | A §26 sorrend 28. és 13. pontja megépítve |
| `docs/cos-v14-replay-kontroll-ag-2026-08-13.md` | A §26 sorrend 26. pontja megépítve (§1.4.6 kontroll-ág) |
| `docs/cos-v14-adjudikacios-csomag-2026-08-13.md` | A §26 sorrend 29. és 30. pontja megépítve (§1.4.3 vak adjudikáció) |
| `docs/cos-v14-replay-eval-value-gate-2026-08-13.md` | A §26 sorrend 32. pontja megépítve (§24.2 value gate) |
| `docs/cos-v14-sweep-detektorok-preparation-2026-08-13.md` | A §26 sorrend 14–18., 20., 22–23. pontja megépítve |
| `docs/cos-v14-case-hid-approval-fixtures-2026-08-13.md` | A §26 sorrend 11–12., 19., 24–25., 27., 33. pontja megépítve |

**Fontos:** a fenti 2026-08-13-i audit-összesítések történeti állapotot írnak le. A 2026-08-16-i v1.4.4 state spec és a v1.4.5 target baseline az újabb igazságforrás.

## Amit a v1.4.5 előtt külön bizonyítani kell

A v1.4.5 DoD szerint nem elég a zöld unit/integration suite. Kötelező:

- producer → persist → consumer → observable effect → receipt/readback → dedup → recovery → zero-case lánc;
- temporal semantic consistency;
- owner input utáni stale evidence blokkolása;
- deploy előtt már létező, feldolgozatlan input feldolgozása;
- Personal és ZST domain külön promotion bizonyítéka;
- legalább 7 egymást követő nap P1 silent-failure nélkül a promoted scope-ban.

## v1.5 unlock

A v1.5 implementációs/live szakasza csak a v1.4.5 production gate teljesülése után nyitható meg. A v1.5 specifikáció megléte önmagában nem felhatalmazás az external research/browser autonomy élesítésére.