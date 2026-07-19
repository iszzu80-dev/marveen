# MK – 2bc3fae0 P0 launch-blocker felülvizsgálata és javasolt végrehajtási specifikáció

**Dátum:** 2026. július 15.  
**Tárgy:** `2bc3fae0 – FLEET IN-FLIGHT (high, qa): accountant-jóváhagyott automata edge-case teszt-mátrix`  
**Döntési szint:** P0 launch gate  
**Kapcsolódó állapot:** a 2026-os KATA- és átalányadó-szabálycsomag jelenleg `validated:false`  
**Javasolt tulajdonosok:** QA, Fullstack, adószakértő/könyvelő, jogász, BA/Product  
**Összefoglaló döntés:** a kártya helyes és szükséges, de jelenlegi megfogalmazásában túl monolitikus és félreérthető. Nem egy globális `validated:true` flipet kell létrehoznia, hanem külön validációs scope-okat, accountant-approved golden test packot, hard eligibility gate-et és release-gate automatizmust.

---

# 1. Vezetői döntés

A `2bc3fae0` kártyát **meg kell tartani P0 launch-blockernek**, de a scope-ját és elfogadási feltételeit át kell írni.

A jelenlegi megfogalmazás:

> „accountant-jóváhagyott automata edge-case teszt-mátrix. Ez a P0 launch-blocker: a 2026 KATA/átalányadó szabálycsomag validated:false → a validated:true flip ehhez a mátrixhoz kötött. QA építi, fullstack köti a számítást.”

jó irányt jelöl, de négy kockázatot hordoz:

1. **Túl általános `validated:true`:** azt sugallhatja, hogy minden KATA- és átalányadózási eset támogatott.
2. **KATA és átalányadó összekeverése:** eltérő jogosultsági, számítási és tesztelési logikájuk miatt külön kell validálni őket.
3. **Pozitív tesztekre szűkülhet:** a mátrixnak azt is igazolnia kell, hogy a nem támogatott eseteket a rendszer blokkolja.
4. **A könyvelői jóváhagyás félreérthető:** a könyvelő nem a kódot és nem a teljes terméket hagyja jóvá, hanem a dokumentált scope-ot, inputokat, elvárt eredményeket és kizárásokat.

A helyes cél:

> **Accountant-approved, scope-specifikus golden test pack + automatikus regressziós tesztek + futásidejű eligibility gate + verziózott release gate.**

---

# 2. Miért P0 launch-blocker?

Az adóbecslő termék elsődleges értéke a számítás megbízhatósága. Ha a rendszer:

- hibás negyedéves összeget mutat;
- nem kezelt élethelyzetre is „validált” eredményt ad;
- régi KATA-logikát használ;
- bizonytalan vagy nem jóváhagyott szabálycsomagot véglegesnek prezentál;

akkor az egész fizetős értékajánlat sérül.

A tesztmátrix ezért nem egyszerű QA-deliverable, hanem a következőket egyszerre biztosító launch control:

- jogszabályi helyesség;
- könyvelői szakmai elfogadás;
- kód és elvárt eredmény összekapcsolása;
- regresszióvédelem;
- támogatott és kizárt scope szétválasztása;
- UI-állítások és tényleges motorképesség egyezése;
- auditálható verziókezelés.

A launch csak akkor engedhető, ha nemcsak a támogatott számítások zöldek, hanem a nem támogatott esetek is determinisztikusan blokkolódnak.

---

# 3. A globális `validated:true` problémája

## 3.1 Mit sugallna hibásan?

Egy ilyen struktúra:

```json
{
  "rulePack": "2026",
  "validated": true
}
```

azt sugallja, hogy:

- a teljes 2026-os szabályrendszer validált;
- minden felhasználói élethelyzet támogatott;
- minden KATA- és átalányadó-számítás helyes;
- nincs további eligibility vizsgálat;
- a UI minden esetben használhatja a „validált becslés” megnevezést.

Ez a jelenlegi termékállapotban nem igaz és később is túl durva modell lenne.

## 3.2 Javasolt validációs modell

Legalább a következő dimenziókat külön kell kezelni:

```json
{
  "taxYear": 2026,
  "taxRegime": "ATALANYADO",
  "calculationScope": "STANDARD_ATALANYADO_V1",
  "rulePackVersion": "2026.1.0",
  "goldenPackVersion": "2026.1.0",
  "scopeValidated": true,
  "runtimeEligibilityRequired": true,
  "validatedAt": "2026-07-15",
  "validatedByRole": "ACCOUNTANT",
  "sourcePackHash": "sha256:...",
  "goldenPackHash": "sha256:..."
}
```

A konkrét felhasználói futás külön státuszt kapjon:

```json
{
  "scopeValidated": true,
  "userEligibleForScope": true,
  "periodEligibilityConfirmed": true,
  "resultStatus": "VALIDATED_ESTIMATE"
}
```

Nem támogatott esetben:

```json
{
  "scopeValidated": true,
  "userEligibleForScope": false,
  "resultStatus": "CALCULATION_BLOCKED",
  "reasonCode": "UNSUPPORTED_TAX_ALLOWANCE"
}
```

A fontos megkülönböztetés:

> A szabálycsomag egy scope-ra validált lehet, miközben egy konkrét felhasználó vagy időszak nem jogosult ebben a scope-ban számításra.

---

# 4. KATA és átalányadó külön validációja

A `2026 KATA/átalányadó szabálycsomag` egyetlen validációs egységként kezelése nem javasolt.

## 4.1 Miért kell kettéválasztani?

A két rendszer különbözik:

- jogosultsági feltételek;
- bevételi szabályok;
- kizáró körülmények;
- fizetendő adók;
- határértékek;
- negyedéves/éves működés;
- célcsoport-relevancia;
- számítási output;
- edge case-ek.

Az egyik hibája nem blokkolhatja automatikusan a másik teljes fejlesztési és release-folyamatát, ugyanakkor a közös UI-ban sem szabad úgy megjelenniük, mintha azonos validációs státuszuk lenne.

## 4.2 Javasolt külön scope-ok

### Átalányadó

```text
STANDARD_ATALANYADO_V1
```

Például csak:

- nem nyugdíjas;
- nem szünetelő;
- nincs támogatási scope-on kívüli kieső idő;
- nincs adó- vagy családi kedvezmény;
- támogatott munkajogi/biztosítotti státusz;
- támogatott költséghányad;
- magyar, egyszerű belföldi működés;
- megfelelően ismert pénzforgalmi bevétel.

### KATA

```text
STANDARD_KATA_2026_V1
```

Csak a 2026-os KATA tényleges jogosultsági feltételeinek megfelelő személyekre, külön eligibility engine-nel.

A KATA-összehasonlító nem futhat pusztán számítási paraméterek alapján. Előbb jogosultsági kapunak kell kimondania:

- jogosult;
- nem jogosult;
- bizonytalan, szakértői ellenőrzés kell.

## 4.3 Külön release flag

```json
{
  "ATALANYADO_2026_STANDARD": "VALIDATED",
  "KATA_2026_STANDARD": "NOT_VALIDATED"
}
```

Így lehetséges, hogy az átalányadó core elinduljon, miközben a KATA-funkció még rejtett, blokkolt vagy csak tájékoztató állapotban van.

---

# 5. A kártya javasolt új megfogalmazása

## 5.1 Javasolt cím

**2bc3fae0 – P0: scope-specifikus accountant-approved tax golden matrix és runtime eligibility gate**

## 5.2 Javasolt leírás

> Készüljön külön, verziózott, könyvelő által jóváhagyott golden test pack a 2026-os támogatott átalányadó- és KATA-scope-okra.
>
> A QA a jóváhagyott input–expected output eseteket automatikus regressziós tesztekké alakítja. A Fullstack a közös számítási motorhoz köti a teszteket, implementálja a runtime eligibility gate-et, és biztosítja, hogy scope-on kívüli esetben a rendszer ne számoljon „validált becslést”, hanem blokkoljon, illetve megfelelő disclosure-t és továbbvezetést adjon.
>
> A release gate csak akkor engedi az adott scope `scopeValidated:true` státuszát, ha:
> - az összes pozitív golden case sikeres;
> - az összes negatív/blocking case sikeres;
> - a forrás- és golden pack verzió/hash egyezik;
> - nincs nyitott P0/P1 adószámítási eltérés;
> - a könyvelői sign-off a konkrét scope-ra és verzióra rendelkezésre áll;
> - a UI nem állít többet a validált hatókörnél.

---

# 6. Szerepek és felelősségek

## 6.1 Jogász / adójogi forrásfelelős

Feladata:

- hivatalos jogforrások rögzítése;
- alkalmazandó szabályok értelmezési kérdéseinek dokumentálása;
- OQ-8 lezárása;
- 18,5%-os TB, 13%-os szocho, költséghányad-listák és kapcsolódó feltételek igazolása;
- forrásverzió és hatálydátum megadása;
- bizonytalan jogértelmezés flagelése.

Nem feladata:

- tesztesetek számszerű jóváhagyása önmagában;
- kód review;
- termék teljes megfelelőségének aláírása.

## 6.2 Könyvelő / adószakértő

Feladata:

- támogatott scope ellenőrzése;
- tesztinputok és aranyértékek jóváhagyása;
- kerekítési és időszaki logika ellenőrzése;
- kizárt esetek listájának jóváhagyása;
- sign-off kiadása konkrét scope-ra, adóévre és verzióra.

Nem általános jóváhagyás:

> „A MikroKönyv helyesen számol.”

Hanem:

> „A STANDARD_ATALANYADO_V1 scope-ban, a dokumentált feltételek és kizárások mellett a 2026.1.0 golden pack elvárt eredményei megfelelnek a megjelölt szabályoknak.”

## 6.3 QA

Feladata:

- tesztmátrix szerkezete;
- golden fixture-ek;
- pozitív és negatív tesztek;
- property/invariant tesztek;
- regressziós suite;
- határértékek;
- UI/API/engine konzisztencia;
- release-gate riport.

A QA nem „kitalálja” az elvárt adóértékeket, hanem a szakmailag jóváhagyott aranyértékeket automatizálja.

## 6.4 Fullstack / számítási motor

Feladata:

- az engine javítása;
- F4 kumulatív/göngyölítéses negyedéves logika;
- KATA-logika korrekciója;
- runtime eligibility gate;
- reason code-ok;
- scope és eredménystátusz továbbítása az API-n;
- ugyanazon eredmény használata UI-ban, PDF-ben, határidőben és chatben;
- külön számítási logika megszüntetése a frontendben.

## 6.5 BA / Product

Feladata:

- scope egyértelmű definiálása;
- kizárt esetek üzleti döntése;
- UI disclosure;
- onboarding és negyedéves reconfirmation;
- feature visibility;
- pricing és értékajánlat összehangolása a tényleges scope-pal.

## 6.6 Release/Delivery lead

Feladata:

- P0 kapu működtetése;
- sign-off artefaktumok ellenőrzése;
- megfelelő commit/verzió/hash összekapcsolása;
- release tiltása eltérés esetén.

---

# 7. A tesztmátrix szerkezete

## 7.1 Egy teszteset minimális mezői

```yaml
case_id: AT_2026_Q2_004
tax_year: 2026
tax_regime: ATALANYADO
scope: STANDARD_ATALANYADO_V1
description: "Q2-ben átlépett adómentes jövedelemhatár, egyenetlen bevétel"
legal_sources:
  - source_id: NAV_IF_100_2026
    section: "..."
input:
  employment_status: MAIN_ACTIVITY
  pensioner: false
  suspended_periods: []
  excluded_months: []
  tax_allowances: []
  cost_ratio: 0.45
  cash_revenues:
    - date: 2026-02-10
      amount_huf: 2000000
    - date: 2026-05-10
      amount_huf: 3000000
expected:
  q1:
    szja_advance_huf: 0
    tb_huf: ...
    szocho_huf: ...
  q2:
    szja_advance_huf: ...
    tb_huf: ...
    szocho_huf: ...
  cumulative_huf:
    szja: ...
    tb: ...
    szocho: ...
expected_status: VALIDATED_ESTIMATE
approved_by:
  role: ACCOUNTANT
  approval_id: ...
```

## 7.2 Pozitív golden case

Olyan támogatott eset, ahol:

- a rendszer számol;
- az expected értékek egyeznek;
- az eredmény `VALIDATED_ESTIMATE`;
- a UI mutathat fizetendő/félreteendő összeget.

## 7.3 Negatív/blocking case

Olyan eset, ahol:

- nincs számszerű validált output;
- reason code kötelező;
- a UI blokkot és továbbvezetést mutat;
- a határidő nem jeleníthet hamis összeget;
- a PDF nem generálhat végleges számítást;
- a chat nem idézhet validált összeget.

Példa:

```yaml
case_id: AT_2026_BLOCK_001
input:
  pensioner: true
expected:
  result_status: CALCULATION_BLOCKED
  reason_code: UNSUPPORTED_PENSIONER_STATUS
```

---

# 8. Kötelező átalányadó tesztcsoportok

## 8.1 Alap számítás

- általános költséghányad;
- emelt költséghányad;
- kizárólagos kiskereskedelem;
- adómentes jövedelmi határ alatt;
- pontosan a határon;
- egy forinttal a határ felett;
- bevételi limit 80%-a;
- bevételi limit 100%-a;
- limit feletti állapot.

## 8.2 Pénzforgalmi esetek

- kiállított, de nem befolyt számla;
- teljesen befolyt;
- részben befolyt;
- több részfizetés;
- két adóév között befolyó részletek;
- stornó;
- módosító;
- negatív korrekció;
- kézi bevétel;
- duplikált adat.

## 8.3 Negyedéves F4 – kötelező P0 golden set

1. egész évben az adómentes jövedelemhatár alatt;
2. Q1-ben átlépi a határt;
3. Q2-ben átlépi;
4. Q3-ban átlépi;
5. Q4-ben átlépi;
6. Q1 magas bevétel, Q2 nulla;
7. Q1 nulla, Q2 magas bevétel;
8. erősen egyenetlen havi bevétel;
9. minimum járulékalap érvényesül;
10. göngyölt alap magasabb a minimumnál;
11. garantált bérminimumhoz kötött tevékenység;
12. támogatott mellékállású státusz;
13. év közbeni indulás, ha a scope támogatja;
14. részfizetés két negyedév között;
15. korábbi negyedévekben elszámolt alap levonása;
16. stornó következő negyedévben;
17. éves kumulált összeg és negyedéves összegek egyezőségi invariánsa;
18. Határidők nézet és engine output azonossága.

## 8.4 Kerekítés

- minden közteher külön;
- kumulált és negyedéves kerekítés;
- PDF/UI/API egyezés;
- forintra kerekítés;
- negatív és nulla érték.

## 8.5 Kizárt esetek

- nyugdíjas;
- szüneteltetés;
- teljes havi táppénz vagy támogatáson kívüli kieső idő;
- adóalap-kedvezmény;
- családi járulékkedvezmény;
- nem támogatott tevékenység;
- bizonytalan költséghányad;
- külföldi/speciális áfaügylet, ha scope-on kívüli;
- hiányzó fizetési státusz;
- nem validált szabálycsomag.

---

# 9. Kötelező KATA tesztcsoportok

A KATA golden pack csak a jelenlegi jogi logika kijavítása után építhető véglegesre.

## 9.1 Jogosultság

- főfoglalkozású;
- nem főfoglalkozású;
- nyugdíjas;
- kifizetőtől származó bevétel;
- magánszemélytől származó bevétel;
- kizárt tevékenység vagy státusz;
- év közbeni belépés/kilépés.

## 9.2 Tételes adó

- teljes hónap;
- tört hónap;
- szünetelés, ha később támogatott;
- éves hónapszám;
- fizetési státusz.

## 9.3 Bevételi keret

- keret alatt;
- pontosan kereten;
- egy forinttal felette;
- év közbeni működéshez igazított keret;
- különadó;
- nem jogosult B2B eset blokkolása.

## 9.4 Összehasonlító

Az összehasonlító csak akkor adhat számszerű ajánlást, ha mindkét oldal validált és a felhasználó mindkét rendszerre jogosult.

Ellenkező esetben:

```text
A KATA a megadott működés mellett nem választható,
ezért számszerű összehasonlítást nem készítünk.
```

---

# 10. Runtime eligibility gate

## 10.1 Miért nem elég az onboarding?

A státusz év közben változhat:

- szünetelés;
- nyugdíjassá válás;
- kedvezmény érvényesítése;
- táppénz;
- más munkaviszony;
- tevékenységváltás.

Ezért eligibility kell:

- onboardingkor;
- profilváltozáskor;
- minden negyedéves zárás előtt;
- éves zárás előtt;
- releváns új adat észlelésekor.

## 10.2 Kérdések

Példa átalányadó-scope-ra:

```text
Erősítsd meg az időszakra:

□ nem voltál saját jogú nyugdíjas;
□ nem szüneteltetted a vállalkozást;
□ nem volt a számítást érintő teljes havi kieső időd;
□ nem érvényesítesz támogatáson kívüli adó- vagy járulékkedvezményt;
□ nem változott a tevékenységi köröd vagy költséghányadod.
```

Ne egyetlen checkbox legyen, mert külön reason code és audit szükséges.

## 10.3 Ismeretlen válasz

Az `unknown` ne legyen automatikusan `false`.

```json
{
  "taxAllowanceApplied": "UNKNOWN"
}
```

Eredmény:

```text
CALCULATION_BLOCKED
```

---

# 11. UI-követelmények

## 11.1 Validált eredmény

```text
Validált becslés

A STANDARD_ATALANYADO_V1 hatókörben,
a 2026. szeptember 30-án megerősített adózási státusz alapján.
```

## 11.2 Scope-on kívüli eset

```text
Ezt az összeget nem számítjuk automatikusan

A megadott kedvezmény módosíthatja az SZJA- vagy
járulékkötelezettséget, ezt a jelenlegi validált motor
még nem kezeli.

A bevételi és keretadataid továbbra is elérhetők.

[Könyvelői összefoglaló] [Profil ellenőrzése]
```

## 11.3 Nem validált pack

```text
A 2026-os számítási szabályok szakértői ellenőrzése még folyamatban van.

Ezért fizetendő összeget jelenleg nem mutatunk.
```

## 11.4 Határidők nézet

A Határidők nézet:

- ugyanazt az engine outputot használja;
- nem számol külön;
- nem oszt éves összeget néggyel;
- blokkolt állapotban nem mutat számszerű fizetendőt;
- megmutathatja a jogi határidőt, de külön jelzi, hogy az összeg nem számítható.

---

# 12. Release gate

## 12.1 Automatikus ellenőrzések

Release tiltott, ha:

- bármely P0 golden case hibás;
- bármely blocking case számszerű eredményt ad;
- engine/API/UI/PDF eltérés van;
- source pack hash nem egyezik;
- accountant sign-off verzió nem egyezik;
- rule pack `validated` státusza kézzel átírható teszt nélkül;
- KATA és átalányadó státusz össze van kötve;
- nyitott P0 calculation defect van.

## 12.2 Manuális artefaktumok

Kötelező:

- scope-spec;
- kizárási lista;
- jogforrás-pack;
- accountant sign-off;
- golden matrix;
- automatikus tesztriport;
- UI disclosure screenshot vagy acceptance evidence;
- release note;
- rollback terv.

## 12.3 CI példa

```text
tax-golden-atalanyado-2026     PASS
tax-blocking-atalanyado-2026   PASS
tax-golden-kata-2026           NOT_RELEASED
engine-api-ui-parity           PASS
accountant-signoff-hash        PASS
source-pack-hash               PASS
unsupported-case-leak-test     PASS
```

Az átalányadó release ettől még engedhető, ha a KATA feature flaggel kikapcsolt.

---

# 13. Definition of Done

A kártya akkor kész, ha:

## Scope

- [ ] A támogatott átalányadó-scope verziózott és dokumentált.
- [ ] A támogatott KATA-scope külön dokumentált.
- [ ] A kizárt esetek explicit listája jóváhagyott.
- [ ] KATA és átalányadó külön validációs státuszt kapott.

## Szakmai jóváhagyás

- [ ] A jogforrás-pack lezárt.
- [ ] OQ-8 kérdések lezártak.
- [ ] A könyvelő az inputokat és expected outputokat jóváhagyta.
- [ ] A sign-off konkrét verzióhoz és hashhez kötött.

## QA

- [ ] Pozitív golden case-ek automatizáltak.
- [ ] Negatív/blocking case-ek automatizáltak.
- [ ] F4 göngyölítéses tesztcsoport teljes.
- [ ] Határérték- és kerekítési tesztek teljesek.
- [ ] Engine/API/UI/PDF parity tesztek zöldek.
- [ ] Regressziós futás CI-ban kötelező.

## Fullstack

- [ ] Flat éves/4 logika eltávolítva.
- [ ] Közös quarterly liability engine működik.
- [ ] Runtime eligibility gate működik.
- [ ] Reason code-ok implementálva.
- [ ] Nem támogatott eset nem ad validált összeget.
- [ ] A validációs metaadat az API output része.

## UI/Product

- [ ] Onboarding scope-gate működik.
- [ ] Negyedéves reconfirmation működik.
- [ ] Validált és blokkolt állapot külön megjelenik.
- [ ] Disclosure nem állít többet a scope-nál.
- [ ] Határidő látható maradhat, hamis összeg nem.
- [ ] KATA funkció el van rejtve vagy blokkolva, amíg nincs validálva.

## Release

- [ ] Release gate automatizált.
- [ ] Nincs kézi `validated:true` bypass.
- [ ] Feature flag és rollback rendelkezésre áll.
- [ ] Release evidence csomag archivált.

---

# 14. Javasolt végrehajtási bontás

A jelenlegi egy kártyát érdemes epic + alfeladatokra bontani.

## Epic

**2bc3fae0 – Tax validation release gate 2026**

## Alfeladatok

### A. Scope és forrás

- `MK-TAX-01` – STANDARD_ATALANYADO_V1 scope-spec
- `MK-TAX-02` – STANDARD_KATA_2026_V1 scope-spec
- `MK-TAX-03` – OQ-8 source pack lezárása
- `MK-TAX-04` – kizárási lista és reason code katalógus

### B. Számítási javítás

- `MK-ENG-01` – F4 quarterly cumulative/göngyölítés fix
- `MK-ENG-02` – KATA 2026 jogosultsági és számítási fix
- `MK-ENG-03` – common calculation result metadata
- `MK-ENG-04` – frontend külön számítások eltávolítása

### C. Tesztelés

- `MK-QA-01` – accountant golden matrix fixture format
- `MK-QA-02` – átalányadó pozitív golden suite
- `MK-QA-03` – F4 golden suite
- `MK-QA-04` – blocking/negative suite
- `MK-QA-05` – KATA golden suite
- `MK-QA-06` – parity/invariant tests

### D. Eligibility és UI

- `MK-FS-01` – onboarding eligibility gate
- `MK-FS-02` – quarterly reconfirmation
- `MK-FS-03` – blocked result UX
- `MK-FS-04` – validation badge és scope disclosure

### E. Release gate

- `MK-REL-01` – CI tax validation gate
- `MK-REL-02` – sign-off hash verification
- `MK-REL-03` – release evidence pack
- `MK-REL-04` – feature flags és rollback

---

# 15. Prioritási javaslat

## Azonnal

1. F4 javítás specifikációja.
2. Átalányadó-scope rögzítése.
3. OQ-8 lezárása.
4. Accountant golden fixture-ek.
5. Blocking esetek reason code-jai.
6. KATA különválasztása.

## Ezután

1. QA automatizálás.
2. Fullstack runtime gate.
3. UI disclosure és reconfirmation.
4. CI release gate.
5. Accountant sign-off.
6. `scopeValidated:true` aktiválása csak az átalányadó támogatott scope-ra.

## Később

- nyugdíjas scope;
- kedvezmények;
- szünetelés;
- táppénz és kieső idő;
- szélesebb KATA use case;
- új adóév pack.

---

# 16. Kockázatok és kontrollok

| Kockázat | Kontroll |
|---|---|
| Globális validáció túl széles állítást tesz | Scope-specifikus státusz |
| Nem támogatott user mégis kap összeget | Runtime eligibility + blocking tests |
| Könyvelői sign-off elavul | Verzió- és hash-kötés |
| UI más összeget mutat | Common engine + parity tests |
| KATA hiba blokkolja az átalányadó launchot | Külön feature flag és validáció |
| Jogszabály változik | Versioned source pack |
| QA saját expected értéket talál ki | Accountant-approved golden values |
| Negatív esetek kimaradnak | Kötelező blocking suite |
| Kézi validated flip | CI és deployment gate |
| Scope változik, teszt nem | Scope hash és matrix hash |

---

# 17. Konkrét döntési ajánlás a fleet számára

## Elfogadandó

- a kártya P0 launch-blocker státusza;
- QA mint tesztautomatizálási owner;
- Fullstack mint engine-integrációs owner;
- accountant-approved golden values;
- `validated:false` fenntartása a kapu teljesüléséig.

## Módosítandó

- ne legyen közös KATA/átalányadó `validated:true`;
- ne csak „edge-case tesztmátrix” legyen, hanem pozitív + blocking matrix;
- a könyvelői sign-off scope- és verzióspecifikus legyen;
- az F4 fix legyen explicit dependency;
- runtime eligibility gate legyen explicit deliverable;
- UI disclosure és quarterly reconfirmation legyen DoD-rész;
- release gate automatikusan ellenőrizze a sign-off és pack hash egyezését.

## Nem elfogadható lezárási mód

A kártya nem zárható le azzal, hogy:

- van sok unit test;
- a könyvelő megnézett néhány példát;
- valaki kézzel átírta a flaget;
- a happy path zöld;
- a UI disclaimerben közli, hogy a szám becslés;
- a nem támogatott esetekre is van eredmény, csak figyelmeztetéssel.

---

# 18. Végső ajánlás

A `2bc3fae0` helyes P0 kezdeményezés, és a launch szempontjából az egyik legfontosabb kártya. A siker feltétele azonban, hogy ne egyszerű tesztírásként vagy egy globális flag átfordításaként kezeljétek.

A célállapot:

> **A rendszer csak arra a konkrét adózási scope-ra mondja ki, hogy validált, amelyre accountant-approved golden tesztek vannak; minden más esetet felismer, blokkol és világosan továbbvezet.**

A javasolt release-sorrend:

1. **STANDARD_ATALANYADO_V1**
   - F4 fix;
   - scope-down;
   - golden és blocking matrix;
   - runtime gate;
   - accountant sign-off;
   - külön `scopeValidated:true`.

2. **STANDARD_KATA_2026_V1**
   - jogosultsági és számítási korrekció;
   - külön golden matrix;
   - külön sign-off;
   - külön release.

Ez gyorsabb, biztonságosabb és auditálhatóbb, mint egy közös, monolitikus 2026-os `validated:true`.

---

## Javasolt rövid fleet-utasítás

```text
A 2bc3fae0 marad P0 launch-blocker, de scope-módosítással.

Ne globális 2026 KATA/átalányadó validated:true készüljön.
Külön validáció kell:
1. STANDARD_ATALANYADO_V1
2. STANDARD_KATA_2026_V1

A deliverable kötelező részei:
- accountant-approved golden input/output pack;
- pozitív és blocking/negative automata tesztek;
- F4 kumulatív/göngyölítéses fix;
- runtime eligibility gate;
- scope- és verzióspecifikus sign-off;
- engine/API/UI/PDF parity;
- automatikus CI release gate;
- kézi validated bypass tiltása.

Az átalányadó scope elindulhat külön, ha zöld és aláírt.
A KATA maradjon feature flag mögött, amíg a saját scope-ja nem validált.
```
