# CostOps v1.0.1 — Simplify & Trust implementációs GO prompt

## GO — CostOps v1.0.1 Simplify & Trust implementáció, pontosított guardrailekkel

A source of truth:

`audits/costops-v101-simplify-trust-plan.md`

A tervet elfogadom, de a §15 prompt helyett ezt a pontosított GO-t kövesd.

## Cél

A jelenlegi `#costs-v2` nézet egyszerűsítése és default Costs nézetté tétele úgy, hogy a CostOps v1.0 pénzügyi, adatforrás-, forecast-, entitlement- és tokenlogikája változatlan maradjon.

## 1. Főnézet

- Előző lezárt hónap
- Aktuális MTD
- Várható hó vége
- Budget
- Adatminőség

1440 px-en lehet 5 kártya egy sorban.

1024 px-en adaptív 3+2 vagy más jól olvasható törés legyen.

Mobilon:

- MTD hero kártya;
- alatta 2×2 Past / Forecast / Budget / Adatminőség.

## 2. Előző hónap

- A júniusi 8 990 HUF egyértelműen `PARTIAL / HIÁNYOS` legyen.
- Mutassa: 1 provider / 1 line item lefedettség.
- Ne jelenjen meg reprezentatív teljes havi baseline-ként.
- A +1005% MoM ne legyen fő riasztás.
- Az „újonnan követve” és „valóban nőtt” külön kategória legyen.

## 3. Aktuális MTD és forecast

- A két összeg külön és azonnal érthető legyen.
- A forecast mutassa külön:
  - fix/manual teljes havi rész;
  - valódi run-rate rész;
  - `no_forecast` rész.
- A kis MTD–forecast eltérés ne sugallja azt, hogy a hónap majdnem véget ért.
- Tételes reconciliation maradjon:

```text
headline == selected line-item sum
```

## 4. Adatminőség

KÖTELEZŐEN összeggel súlyozott legyen, ne provider-darabszámmal.

Mutassa:

- számla/API actual összeg;
- manual összeg;
- estimate összeg;
- pending/no_data.

A jelenlegi adatoknál körülbelül 5% valós adat, nem 30%.

Ne hardcode-olj százalékot vagy összeget: mindig az élő API-ból számold.

## 5. Egységes költségtábla

Legyen default nyitva.

Minimum oszlopok:

- Provider / szolgáltatás
- Előző hónap
- Aktuális MTD
- Forecast
- Adatforrás
- Státusz / teendő

Részletekben:

- line item;
- original currency;
- FX és `fx_estimated`;
- forecast basis;
- source/confidence;
- entitlement link;
- token/model/agent;
- lifecycle;
- diagnostics.

Az accordion maradjon másodlagos részletes nézet.

## 6. Kézi forrás jelölése

Különítsd el:

- `Kézi — nincs API`
- `Kézi — API hiba`

Az első legyen semleges/szürke.

A második legyen figyelmeztető/amber.

## 7. Csomagok és keretek

Maradjon külön az operational spendtől.

Severity-sorrend:

- friss blocked/critical;
- warning;
- stale/frissítés szükséges;
- no_data;
- ok.

A DeepSeek korábbi 105% blocked állapota stale snapshot volt.

KÖTELEZŐ freshness-gate:

- friss adat nélkül ne jelenjen meg aktuális blocked truth-ként;
- stale esetben „Frissítés szükséges” vagy `stale/unknown`;
- mutasd a last successful sync időpontját.

Kapcsold össze a provider költségsorát és entitlement sorát, de ne számold össze őket.

## 8. Warnings

- Felül maximum 3 valóban actionable warning.
- Teljes lista collapsed.
- Duplikált warningokat deduplikáld.
- Információs állapot ne nézzen ki kritikus hibának.
- Top barban lehet warning-count.

## 9. Opportunity-cost

Két fogalmat különíts el.

### A) Token usage-equivalent

- `NEM SZÁMLÁZOTT`
- `Előfizetésben foglalt tokenhasználat`
- `API-áron számított költségekvivalens`
- mindig collapsed;
- nem kerülhet a pénzügyi headline-ok közelébe;
- nem kerül operational spendbe vagy budgetbe.

### B) Kihasználatlan entitlement

- csak akkor mutass pénzbeli értéket, ha van bizonyítható számítási módszer;
- ellenkező esetben csak usage/remaining százalék;
- ne fabrikálj „megtakarítás” vagy „elveszett érték” összeget.

Az AC10-et ennek megfelelően értelmezd, ne „estimated unused value” gyűjtőfogalomként.

## 10. Trend

- Ne rajzolj négy üres oszlopot.
- A `no_data` hónapok továbbra is legyenek őszintén jelezve szövegben.
- Június `partial`, július `MTD/partial`.
- Hónapra kattintva tételbontás.
- Ne tüntesd el a `no_data` információt, csak az üres vizuális zajt.

## 11. Manuális rögzítés

- Ne dominálja az alapoldalt.
- Legyen collapsed drawer/modal vagy egyértelmű `+ Kézi tétel` művelet.
- A meglévő POST/PATCH működés ne változzon.
- E2E teszt után a tesztsor ne maradjon az adatbázisban.

## 12. Szűrők

Maximum:

- hónap;
- provider;
- adatforrás/adatminőség.

Ne építsd meg a korábbi gazdag, többdimenziós filterrendszert.

## 13. Legacy/rollback

- A „Klasszikus nézet” linket az alap UI-ból elrejtheted.
- A v1 route/flag technikailag MARADJON elérhető rollbackhez.
- Ne töröld a v1 kódját ebben a sprintben.
- A v2 csak zöld browser acceptance után legyen default.
- Rollback legyen flag/route visszaállítás vagy git revert, adatvesztés nélkül.

## 14. Technikai végrehajtás

- Először inspecteld a tényleges repo-struktúrát.
- Ne feltételezd, hogy `apps/web`, `web/script.js` vagy Vite a helyes út.
- A tényleges fájlokat módosítsd.
- Preferáltan UI-only.
- Backend/API módosítás csak akkor, ha meglévő endpointból ténylegesen nem állítható elő valamely kötelező aggregáció.
- Nincs DB/schema változás.
- Nincs új dependency.
- Nincs provider/sync/ingest/cost-math módosítás.

## 15. Ellenőrzés

- Használd a projekt tényleges build parancsát.
- Teljes releváns teszt.
- Dashboard-only restart, ha szükséges.
- Live API smoke.
- Browser console: 0 error.
- Before/after screenshot:
  - 1440×900
  - 1024×768
  - 390×844

Legalább ezek a journey-k:

1. előző hónap megértése;
2. MTD megértése;
3. forecast alapjának megértése;
4. provider összehasonlítás;
5. API/email/manual forrás felismerése;
6. DeepSeek keret és freshness;
7. kézi költség felvétele;
8. token opportunity-cost értelmezése;
9. mobil főfolyamat.

## 16. Acceptance

- previous month partial státusz egyértelmű;
- MTD a fő hero szám;
- forecast fixed/run-rate/no_forecast bontása látszik;
- amount-weighted data quality;
- unified cost table default nyitva;
- cost és entitlement külön;
- stale entitlement nem jelenik meg aktuális critical truth-ként;
- top warning max 3;
- token opportunity-cost collapsed és „nem számlázott”;
- `fx_estimated` látszik;
- nincs fake 0 / NaN / undefined / HUF HUF;
- desktop, laptop, mobil zöld;
- operational_spend és forecast számítási logika változatlan;
- headline reconciliation változatlan;
- v1 technikai rollback megmaradt.

## Guardrails

- nincs push;
- nincs PR;
- PR1 érintetlen;
- nincs provider-side módosítás;
- nincs DB/schema módosítás;
- nincs scraping/private API;
- nincs új secret;
- nincs PII/raw invoice/email tracked fájlban;
- a korábbi unrelated `web/style.css` módosítást ne vedd bele automatikusan; előbb azonosítsd, majd csak tudatosan integráld vagy hagyd érintetlenül.

## Végső riport

Add vissza:

- módosított fájlok;
- implementált acceptance pontok;
- elhalasztott pontok;
- previous/MTD/forecast élő érték;
- amount-weighted data quality;
- freshness viselkedés;
- opportunity-cost megjelenítés;
- browser journey eredmények;
- screenshotok helye;
- build/test/live smoke;
- commit hash;
- git status;
- rollback;
- megerősítés: nincs push/PR/DB/provider-side változás.
