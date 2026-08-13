# Marveen ACP v1.4 / v1.5 — melyik fájl mit mond

**Dátum:** 2026-08-13. Ez a mappa a v1.4 és v1.5 normatív dokumentumkészletét tartja.

## A jelenlegi készlet

| Fájl | Mi ez |
|---|---|
| `marveen-autonomous-case-progression-spec-v1.4-proactive-core.md` | **A v1.4 baseline.** Proaktív észlelés, kvalifikáció és belső előkészítés — nulla új külső végrehajtási felület. |
| `marveen-acp-v1.4-acceptance-fixtures.md` | A v1.4 kötelező elfogadási fixture-jei (`V4-F1`–`V4-F14`). Külön fájlban, hogy a fixture-növekedés ne törje a core spec szerkezetét. |
| `marveen-autonomous-case-progression-spec-v1.5-external-research-browser-autonomy.md` | **A leválasztott következő release.** Böngésző, külső kutatás, adatkiadás. A v1.4 Definition of Done-nak nem része. |
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

**Az audit összegzése:** M4=5, M3=9, M2=4, M1=5, M0=8. A v1.4 nem egyenletesen brownfield —
kétharmada meglévő infrastruktúra, egyharmada (mérési apparátus + jóváhagyási csatorna) új építés.

## Amit a §26 sorrendből még nem lehetett elkezdeni

Nem fejlesztési feladat, hanem előfeltétel:

- **3–5. (replay korpusz, kalibráció, value-gate befagyasztás)** — éles adat kell hozzá.
  A §1.4.1 regisztrációnak a shadow **előtt** kell megtörténnie, ezért ez a legsürgősebb tétel.
- **31. (adjudikátor kijelölése)** — nevesített **független ember** kell, nem LLM és nem a Proactive
  Core kimenetét előállító rendszer. Szervezeti döntés.
