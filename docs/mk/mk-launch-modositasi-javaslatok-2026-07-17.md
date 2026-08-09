# MikroKönyv – egyértelmű launch-módosítási javaslatok

_(Istvan által Telegramon beillesztve, 2026-07-17. Több részletben érkezik.)_

## Vezetői álláspont

Az MK-t nem javaslom általánosan „minden átalányadózónak" megnyitni a jelenlegi első launchban. A kontrollált indulás megfelelő, de csak szűken meghatározott, accountant-validált élethelyzetekkel.

A jelenlegi termék jó alapjai:
- NAV-adatok behúzása;
- átalányadó-számítás;
- 14 kérdéses onboarding;
- határidő-naptár;
- export;
- KATA–átalányadó összehasonlító;
- reason-code-os blokkolás, ha nincs validált eredmény;
- 3 500 Ft/hó ár.

A fő probléma nem az, hogy kevés a funkció, hanem hogy a piacvezető számlázók már adóteher-számítást, határidőfigyelést, negyedéves 2658-as bevallástámogatást és SZJA-bevallási segítséget is kínálnak. A Billingo Plusz XML-alapú '58-as bevallástervezetet ad ONYA/ÁNYK importhoz, a Számlázz.hu pedig bevallás-varázslót és adófigyelést biztosít.

Ezért az MK launch-pozíciója nem lehet egyszerűen:
> „NAV-ból behúzott adatokkal kiszámítjuk az átalányadódat."

Hanem:
> „Megmutatjuk, hogy teljesek-e az adataid, mennyit kell félretenned, mit kell következőként megtenned, és minden számnál láthatod, miből és milyen szabály alapján készült."

---

## 1. Szűkítsük a launch által támogatott élethelyzeteket

### Jelenlegi probléma
Az átalányadózás nem egyetlen kalkuláció. A végeredményt befolyásolja:
- főállású vagy mellékállású jogviszony;
- nyugdíjas vagy tanulói státusz;
- évközi kezdés vagy megszűnés;
- szüneteltetés;
- táppénz és más ellátások;
- alkalmazott költséghányad;
- adókedvezmények;
- tevékenységváltás;
- több párhuzamos jogviszony.

A 2026-os 2658-as bevallás szabályai naparányos és szünetelési eseteket is kezelnek; egy hónapon belüli szüneteltetésnél eltérő minimumalap-szabályok is felmerülhetnek.

### Javasolt launch-corridor
Az első nyilvános verzió csak az alábbi két „zöld útvonalat" támogassa teljes számítással.

**A. Főfoglalkozású, folyamatosan működő EV**
- egész évben vagy egyértelmű kezdőnappal aktív;
- nincs szünetelés;
- nincs speciális ellátás;
- nincs jogviszonyváltás a negyedévben;
- 45%-os költséghányad;
- nincs összetett vagy részben érvényesíthető kedvezmény;
- nincs külföldi vagy nehezen besorolható bevétel.

**B. Legalább heti 36 órás munkaviszony mellett működő EV**
- a jogviszony a teljes vizsgált időszakban fennáll;
- nincs szünetelés;
- 45%-os költséghányad;
- nincs összetett kedvezmény vagy évközi státuszváltás.

A többi felhasználó regisztrálhat, adatot tölthet be és megtekintheti az előzetes helyzetét, de pontos adóösszeg helyett ezt kapja:
> „Ez az élethelyzet még könyvelői ellenőrzést igényel. Nem mutatunk olyan összeget, amelynek a helyességét nem tudjuk garantálni."

### Következő támogatási sorrend
1. 80%-os és 90%-os költséghányad;
2. nyugdíjas EV;
3. nappali tagozatos hallgató;
4. évközi indulás;
5. szüneteltetés;
6. jogviszonyváltás;
7. speciális adókedvezmények;
8. több jogviszony kombinációja;
9. ellátásokkal érintett időszakok.

---

## 2. A 2026-os szabálycsomag legyen verziózott termékkomponens

2026-ban több lényeges szabály változott:
- az általános költséghányad 40%-ról 45%-ra emelkedett;
- az adómentes jövedelemrész 1 936 800 Ft;
- az általános átalányadó-bevételi határ 38 736 000 Ft;
- az alanyi adómentesség határa 20 millió Ft;
- a járulék- és szochobevallás havi helyett negyedéves lett;
- a 2026-os nyomtatvány a 2658, külön 2658-EV lappal;
- a szocho mértéke továbbra is 13%, a tb-járuléké 18,5%;
- a főfoglalkozású vállalkozók minimum-szochoalapjának szabálya is módosult.

### Kötelező módosítás
A szabályok ne szétszórt konstansok legyenek a kódban. Minden számítás használjon verziózott szabályprofilt:

```
tax_rule_profile
├── jurisdiction: HU
├── tax_year: 2026
├── effective_from: 2026-01-01
├── effective_to: 2026-12-31
├── status: VALIDATED
├── validated_by: accountant/legal reviewer
├── source_refs
├── formula_version
└── golden_test_suite_version
```

### Launch-gate (szabályprofil)
Nyilvános eredményt csak olyan számítás adhat, amelynél: a szabályprofil VALIDATED; minden input rendelkezésre áll; az élethelyzet támogatott; a golden tesztcsomag zöld; az alkalmazott szabály hatályos a számított időszakra. Más esetben kötelező a blokkolt eredmény.

---

## 3. A NAV auto-pull állítását pontosítani kell
A NAV eÁFA rendszere külön adatforrásként kezeli az online számlaadatokat, online pénztárgépi adatokat, egyszerűsített számlákat, vámadatokat. Az Online Számla-adatok önmagukban nem bizonyítják minden vállalkozás teljes bevételét (pénztárgépes/nyugtás bevétel, külföldi bizonylat, nem-számla bevétel, sztornó/módosítás).

Kommunikáció: NE „automatikusan behúzzuk minden bevételedet", HANEM „behúzzuk a NAV Online Számla rendszerben elérhető számláidat, majd megmutatjuk, milyen további adatokat kell ellenőrizned".

Kötelező adatlefedettség-státusz minden számítás előtt: **Teljesnek jelölt** / **Ellenőrzést igényel** / **Hiányos**. Hiányos adatból ne jelenjen meg „fizetendő adó" biztos számként.

## 4. Fő termékígéret módosítása
NEM: „NAV auto-pull alapú átalányadó-kalkulátor" (technikai, másolható). HANEM: „Mindig lásd, mennyit kell félretenned, mi a következő teendőd, és teljesek-e az adataid." Három pillér: **Teljesség** (mi hiányozhat), **Magyarázhatóság** (minden szám eredete), **Biztonságos blokkolás** (bizonytalanra nincs hamis pontosság).

## 5. Onboarding rövidítése és rétegezése
14 kérdés helyett: (1) jogosultsági gyorsszűrés max 5 kérdés → teljesen/részben támogatott/könyvelői ellenőrzés; (2) adózási profil csak a támogatott úthoz; (3) NAV-kapcsolat setup+teszt+lefedettség; (4) első eredmény (mennyi bevétel, teljesek-e, mennyit tegyél félre, következő teendő, mikor lépj be újra). UX: minden kérdés mellett „Miért kérdezzük?".

## 6. Dashboard mint bizalmi cockpit
Négy kérdés az első képernyőn: (1) Teljesek az adataim? (adatlefedettség + CTA); (2) Mennyit tegyek félre? (adótartalék bontással: SZJA/tb/szocho/befizetett/következő időpont/biztonsági státusz); (3) Mi a következő teendő? (negyedéves 2658 előkészítés — 2026-tól negyedéves, a napi érték az évközi tartalékképzés); (4) Megbízható az eredmény? (Ellenőrzött / Becsült / Hiányos adat / Nem támogatott). Reason-code marad háttéradat, a user emberi nyelvű magyarázatot kap.

## 7. Blokkolt eredmény = megoldható feladat
NEM „CALCULATION_BLOCKED: RELATIONSHIP_STATUS_UNVALIDATED", HANEM emberi nyelvű ok + érintett időszak + érintett adónem + szükséges adat + közvetlen CTA (Jogviszony megadása / Megkérdezem a könyvelőmet / Könyvelői ellenőrzésre küldöm).

## 8. Könyvelői workflow előre
Launchra minimum: egygombos **Könyvelői ellenőrző csomag** (adózási profil, jogviszony-idővonal, NAV-bizonylatok, manuális korrekciók, adatlefedettségi nyilatkozat, szabályverzió, részletes számítás, blokkolt pontok, változásnapló). Kontrollált launch: 3-5 könyvelői design partner, 20-30 valódi EV, min. 2 negyedéves zárás, minden eltérés kategorizálva, kritikus eltérésnél public launch STOP. A könyvelő validátor + referral + bizalmi csatorna, nem elsődleges user.

## 9. Banki szinkron ne túl korán
Launch előtt nem előzheti meg az adatlefedettséget / jogviszony-kezelést / bizonyíthatóságot / könyvelői review-t. Launch után: 1. read-only bankszinkron (párosítás, adófizetés-felismerés, be-nem-folyt jelzés); 2. kategorizálási javaslat confidence-szel + jóváhagyással. NEM launchra: automatikus felülvizsgálat nélküli kategorizálás, banksorból közvetlen adóalap-módosítás.

## 10. KATA-összehasonlító átpozicionálása
Legyen landing kalkulátor / lead-gen / éves döntési modul / „mi történne, ha" szimulátor — ne azonos súlyú fő nav-elem. Különítse el: tényleges adat / évesített becslés / feltételezett bevétel / nem támogatott szempont. NE kategorikus ajánlás („Neked az átalányadó jobb"), HANEM feltételezés-alapú becslés + jogosultsági ellenőrzés-figyelmeztetés.

## 11. Árazás marad, trial módosul
Havi díj: 3 500 Ft/hó tartható (Billingo: 1990-2490 Ft alap + átalányadó-asszisztens; Plusz ~4990 Ft). Az MK nem árban nyer, hanem több-forrású adatellenőrzés + magyarázhatóság + biztonságos blokkolás + könyvelőfüggetlen export.
Trial: az 1 hónap nem ideális, mert a 2658 negyedéves → a user kihagyhatja a legfontosabb zárási folyamatot. Javaslat: **Első negyedéves zárás ingyen, max 60 napig** (vagy: 60 napos próba bankkártya nélkül). Siker-kritérium nem a belépés, hanem: sikeres NAV-kapcsolat + teljes profil + első ellenőrzött eredmény + első teendő + könyvelői csomag/negyedéves zárás.

## 12. Launch-analitika
14 mérendő esemény (regisztráció → gyorsszűrés → támogatott/nem → NAV-kapcsolat → siker → adatlefedettség → első ellenőrzött számítás → blokkolt → feloldva → teendő teljesítve → könyvelői csomag → negyedéves zárás → fizetővé vált → 2. hónap visszatérés).
Elsődleges KPI: **a regisztrálók hány %-a jut el 7 napon belül teljes adatlefedettségű, ellenőrzött eredményig?** Kezdeti célok: gyorsszűrés ≥80%, támogatott→NAV ≥65%, NAV→első eredmény ≥75%, onboarding medián <10 perc, blokkolás-feloldás 7 napon ≥50%, 30 napos visszatérés ≥50%, trial→fizető ≥15-20%, kritikus eltérés 0%.

---

## Javasolt végleges launch-scope

**Kötelezően benne:** támogatott élethelyzetek definíciója; 2026 validált+verziózott szabályprofil; NAV Online Számla kapcsolat; sztornó/módosító kezelés; manuális+egyéb bevétel; adatlefedettségi státusz; főállású + 36h-munkaviszony melletti zöld út; 45% költséghányad; SZJA/tb/szocho számítás; adótartalék-javaslat; negyedéves teendőlista; határidőfigyelés; emberi nyelvű blokkolás; részletes számítási levezetés; szabály-/forráshivatkozás; könyvelői ellenőrző csomag; auditálható változásnapló; alap analitika; ügyfélszolgálati hibakezelés.

**Launch utáni 30-60 nap:** 80%/90% költséghányad; évközi indulás; nyugdíjas/tanulói státusz; 2658 XML-előkészítés; NAV-tervezet összevetés; read-only bankszinkron; könyvelői megosztás; KATA-szimuláció javítás.

**Kivenné/elhalasztaná:** teljes könyvelőprogram irány; korlátlan élethelyzet-állítás; automatikus banki kategorizálás; nem-validált kedvezmények; szüneteltetés/ellátások tesztmátrix nélkül; automatikus bevallásbeküldés; kategorikus adótanácsadás; ágazati pótlék (nem MK-domain); generikus AI-chat mint fő feature.

## Go/no-go launch gate
- [ ] Támogatott élethelyzetek dokumentáltak
- [ ] 2026 szabályprofil primary-source validált
- [ ] tb 18,5% + szocho 13% mellett minden minimumalap + naparányos szabály validált
- [ ] 45% költséghányad + 2026 értékhatárok tesztelve
- [ ] Negyedéves 2658 logika validált
- [ ] Accountant-approved edge-case tesztmátrix kész
- [ ] Minden támogatott golden teszt zöld
- [ ] Nem támogatott esetből nem szivárog pontos adóösszeg
- [ ] NAV-adatlefedettség látható+értelmezhető
- [ ] Sztornó/módosító helyesen kezelt
- [ ] Legalább 20-30 valódi EV használta
- [ ] Legalább 3 könyvelő átnézte a számításokat
- [ ] Legalább 100 különböző számítási eset összevetve
- [ ] Kritikus eltérés: 0
- [ ] Blokkolásokhoz megoldási út
- [ ] Pricing+trial egyértelmű
- [ ] Support+incidenskezelés van
- [ ] Szabályváltozáshoz kill switch / validated:false visszaállítás

## A legfontosabb termékdöntés
„NAV auto-pullos átalányadó-kalkulátor" → **„Átalányadózási kontrollközpont, amely megmutatja, teljesek-e az adataid, mennyit kell félretenned, és mi a következő teendőd — minden számot visszakövethetően, találgatás nélkül."**

Launch előtti legfontosabb munka nem új feature, hanem: (1) támogatott élethelyzetek szűkítése; (2) teljes accountant-validált tesztmátrix; (3) adatlefedettség láthatóvá tétele; (4) onboarding rövidítése; (5) blokkolt eredmények megoldható feladattá alakítása; (6) könyvelői review-csatorna. Külön automatizált 2026 NAV-szabályváltozás-figyelő, amely új közleménynél az érintett szabályprofilt ellenőrzésre visszaállítja.

