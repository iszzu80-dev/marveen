# Családi bölcsőde (Zsibongó / Bölcsőde Iránytű) — Prototípus feature-inventory + gap analízis

Spec-truth foundation a max-prioritású buildhez (FOLYAMAT 2.0: a vastag működő proto = a spec/acceptance igazság).
Read-only elemzés. Minden feature a tényleges fájlokból van kiolvasva; nincs kitalált funkció.

Elemzett források:
- Thick "Zsibongó" proto: `/mnt/c/Users/iszzu/OneDrive/Documents/marveen-protos/bolcsi-proto-thick/index.html` (48 KB, single-file, inline app). A `marveen-review/bolcsi-proto.html` **byte-azonos másolat** (diff: IDENTICAL) — nem külön proto.
- "Bölcsőde Iránytű" V1: `.../családi bolcsode management app/index.html` + `app.js` (121 sor, sűrű) + `style.css`
- "Bölcsőde Iránytű" V2: `.../családi bolcsode management app/v2/index.html` + `app.js` (1428 sor) + `README.md`
- `KUTATASI_TANULSAGOK.md`, `MEGFELELOSEGI_JEGYZET.md`, `családi bolcsi vezetők.txt`

---

## 1. Összefoglaló — melyik proto a legteljesebb / ajánlott bázis

Három **külön fejlődési vonal** van, nem inkrementek:

| Proto | Jelleg | Mélység | User-oldalak | Adatmodell |
|---|---|---|---|---|
| **Thick "Zsibongó"** | Keskeny, de fogalmilag a legtisztább | 1 csoport, 10 gyerek, 11 nézet | Admin + (light) szülő | Child/Guardian/Group + 2 forrás-esemény |
| **V1 Iránytű** | Széles operátor-app | 17+ nézet (JS-injektált modulok), leader/staff role-switch | Admin + gondozó | localStorage `bolcsode-iranytu-state`, ~15 entitás |
| **V2 Iránytű** | Teljes újraírás, 3 valódi workspace | 13 admin + 5 staff + 5 parent nézet | **Admin + gondozó + szülő** | localStorage `bolcsode-iranytu-v2`, ~25 entitás, a leggazdagabb |

**Ajánlott bázis: V2.** Ez fedi le a legtöbb Istvan-követelményt: 3 role-workspace, multi-group, csoport-lefedettség és csoportnyitás-készenlét logika, KENYSZI-motor, számla+bevételi bizonylat+ebédjóváírás-főkönyv, kommunikációs automatizációk, gazdag gyermek- és személyzeti dosszié.

**A thick "Zsibongó" protóból át kell emelni a fogalmi magot:** az "egy-adatfelvitel → több kimenet" derivációs-gráf modellt és az **auditált fan-out naplót** (forrás-esemény → determinisztikus kimenetek). Ez a modell egyik V1/V2-ben sincs ilyen explicit, auditálható formában, pedig ez oldja meg a bölcsődevezetők valódi fájdalmát: a **dupla-felvitelt**.

**V1-ből átemelendő, amit V2 gyengébben visz:** vegyszerkészlet részletei (kategória, lejárat, minimum), higiéniai ütemezés kadenciával (14 naponta / hetente / használat után), HACCP hőmérsékleti napló, személyzeti dokumentum-lejáratok, üzemeltetési rend (4–12h gondozási idő, ≤5 hét nyári zárás, febr. 15. tájékoztatás).

Egyik proto sem éles rendszer: mind localStorage, nincs auth/RBAC/szerveroldal/titkosítás (a MEGFELELOSEGI_JEGYZET és a README ezt kifejezetten deklarálja).

---

## 2. Feature-inventory protónként (3 user-oldalra bontva)

### 2.A — Thick "Zsibongó" proto

**Nézetek (11), nav 3 csoportban:** Adatfelvitel (Áttekintő, Gyerekek/roster, Egy-adatfelvitel→kimenetek, Jelenlét rögzítése, Szülői ebéd-lemondás) · Számított kimenetek (Normatíva-alap, Térítési díj, Csoportnapló) · Kötelező jelentések (Csoport+arány, Határidők, Befizetések).

**Adatmodell:**
- `groups[]`: id, name, band (korsáv "2–3 év"), cap
- `children[]`: id, name, born, group, enroll (`enrolled`|`waitlist`), `guardian{name,phone,email}`, `allergy{allergen,severity,action}` (Art.9 különleges adat)
- `attendance{childId→ present|justified|absent}` — forrás-esemény
- `mealCancels[]`: {childId, name, meal, time, credited} — időbélyeges forrás-esemény
- `log[]`: derivációs audit-napló (minden forrás + fan-out kimenete)
- Konstansok: `MEAL_FEE=820 Ft`, `MEAL_DEADLINE=09:00`, `PRIOR_PRESENCE=111`, `RATIO_RULE{version:2026.2, basis:"15/1998 NM r. M5", maxChildrenPerStaff:5, maxWithHelper:7, helperRequiredAbove:5}`

**Funkciók / logika:**
- `intakeChild()` → várólistára vesz (prompt név+szüldátum); `finalizeEnrollment(id)` → enrolled + jelen
- `setAtt(id,st)` jelenlét-forrás → fan-out: normatíva-alap + csoportnapló + igazolt-hiányzás napló
- `recordMealCancel()` / `recordParentMealCancel()` → deadline-rule (09:00 előtt = jóváírás, MealCount −1; után = terhelve marad)
- `normToday/normMonth/normUnit(presence)` = jelenléti nap / **228** → normatíva elszámolási egység
- `mealCount/feeCharged/feeCredit` = (alap − jóváírt lemondás) × 820 Ft
- `csoportView`: arány-állapot **pass / segítő-kötelező / létszám-túllépés** az egyidejűleg jelenlévő létszámra (2 nevelő / jelen); SNI külön eset
- `exportKenysziCsv()` → Cégkapu-ready CSV (gyermek, dátum, jelenlét-státusz)
- `allergyAlert()`: Art.9 operatív allergiafigyelmeztetés étkezés előtt
- Határidők nézet: KENYSZI napi jelenlét 16:00, étkezés-lemondás napi 09:00, országos jelentés jún.30/dec.31, normatíva éves elszámolás jan.31, MÁK ellenőrzés 2 évente

**User-oldalak:** (1) Admin/fenntartó — az egész; (2) Gondozó — jelenlét rögzítése; (3) Szülő — **szülői ebéd-lemondás önkiszolgáló** (az egyetlen explicit szülő-felület).

### 2.B — V1 "Bölcsőde Iránytű"

**Role-switch:** "Vezetői központ" (leader) ↔ "Csoportmunka" (staff/gondozó) — `setRole()`, body class `staff-mode`.

**Nézetek (HTML-ben statikus + JS-injektált):** Áttekintés · Csoportok és jelenlét · Beosztás és napirend · Heti étlap · Egészség és hiányzás · Szülői kapcsolat · Befizetések · Készlet és higiénia · Naplók és biztonság · Riportok és KESZI · Megfelelőségi központ. **JS-sel hozzáadott modulok:** Gyermekdossziék (`setupChildrenView`), Üzemeltetési rend (`setupOperations`), Csoportmunka/gondozói felület (`setupRoleSurfaces`), Jelentések és audit (`setupGovernance`), Jogviszonyok (`setupLifecycleHub`).

**Adatmodell (`seed`/`state`):**
- `children[]`: name, group, arrival, departure, note, status (Jelen/Hiányzik/Várjuk/Távozott), tone
- `workers[]`: name, role (Kisgyermeknevelő/Kisegítő/Segítő), tone, `shifts[5]` (napi műszak string vagy "Szabadság")
- `payments[]`: child, parent, amount, paid → status (Rendezve/Lejárt/Részfizetés)
- `stock[]`: name, category (Fertőtlenítőszer/Fogyóanyag/Védőeszköz), quantity, unit, minimum, expiry → low-stock jelzés
- `menu{nap→{date,breakfast,snack,lunch,afternoon}}` + `allergens{}` per étkezés
- `messages[]` (parent/staff), `settings{capacity, maxChildrenPerAdult, minAdultsOpening, minAdultsClosing}`
- `dailyChecks[]` (napi kontroll), `temperatures[]` (HACCP hőmérsékleti napló), `incidents[]`
- `dossiers{név→{notes[], docs[{name,done}], pickups[]}}` — **átadásra jogosultak**
- `admissions[]` (felvételi pipeline), `groupLog{activity,outdoor,handover}`
- `operation{mode(Alap/Segítő/SNI), open, close, summerWeeks, noticeSent, staffDocs[{name,document,expires}], hygiene[{task,cadence,last,status}]}`
- `governance{representative(e-képviselő), reports[MŰKENG/országos/MÁK/KSH-OSAP], complaints[]}` + `audit[]` változásnapló
- `lifecycle{cases[{child,status,start,agreement,income,endReason}], invoices[]}`

**Kulcs-funkciók / logika:**
- `renderCompliance()`: élő gépi kontrollok — kapacitás, **felnőtt–gyermek lefedettség** (`needed=ceil(present/ratio)`, elérhető = nem-szabadságos dolgozók), napi kontroll, készletbiztonság → % score
- `modeCapacity()`: Alap 5 / **Segítő személlyel 7** / SNI 3; `hoursOpen()` 4–12h ellenőrzés; nyári zárás ≤5 hét; febr.15 tájékoztatás
- Home coverage-sáv (07–09/09–13/13–15/15–17) + "13:00–15:00 szűk létszám, Katalin szabadsága miatt" figyelmeztetés
- `lifecycleSteps[8]`: Érdeklődő→Jelentkező→Hiánypótlás→Felvett→Beszoktatás→Aktív→Ideiglenesen szünetel→Megszűnt; megszűnés-ok (Szülői kérés / **Korcsoportváltás** / Egyéb); újranyitás
- `addArrival/addAbsence/addShift/addStock/addCharge/editMenu` modálok; `addIncident`, `recordTemperature`, `addStaffDoc`, `addHygieneTask`, `newComplaint`, `newApplication`, `newAgreement`, `createInvoice` (belső bizonylat CB-YYYY-####)
- KESZI-előkészítő CSV export; audit CSV export

**User-oldalak:** (1) Admin/fenntartó — vezetői központ, pénzügy, riportok, megfelelőség, üzemeltetés, jogviszony, governance; (2) Gondozó — Csoportmunka felület (mai csoport, érkezés, megfigyelés, egészség, csoportnapló, napi ellenőrzések); (3) Szülő — csak **közvetett** (Szülői kapcsolat: üzenetek + hozzájárulások admin-oldalról; nincs önálló szülői app).

### 2.C — V2 "Bölcsőde Iránytű" (ajánlott bázis)

**3 valódi role-workspace** (`roleViews`, `defaultView`):
- **admin** (13): Vezérlőpult · Csoportok · Jelentkezések · Gyermekek · Napi működés · Kommunikáció · Személyzet · Üzemeltetés · Jogviszony · Pénzügyek · Megfelelőség · Jelentések · Fenntartó
- **staff/gondozó** (5): Ma (Katica) · Gyermekek · Üzenetek · Csoportnapló · Továbbiak
- **parent/szülő** (5): Kezdőlap · Gyermekem · Naptár · Üzenetek · Profil

**Adatmodell (a leggazdagabb — `seed`):**
- `groups[]`: id, name, **status (Aktív/Induló)**, capacity (7/7/5), room, **site (telephely)**, open, close, lead, ageRule, program, meal, documents[]; induló csoportnál: plannedStart, applicants, registeredParents, unregisteredParents, **waitlist[]**, openingTasks[]
- `children[]`: id, name, group, **careStatus (Jár/Beszokó/Felvett/Kifut/Szüneteltetett)**, **lifecycle (ACTIVE/SETTLING_IN/CONTRACT_SIGNED/APPLICATION_ACCEPTED/WAITING/CLOSING)**, **attendance (NOT_ARRIVED/CHECKED_IN/CHECKED_OUT/ABSENT)**, arrival, checkout, **taj**, **sni**, **immunization** (oltás/igazolás), allergy, **pickup[]** (átvevők), consent{photo, communication}
- `staff[]`: id, name, role, group, **workStatus (Dolgozik/Próbaidő/Helyettesítés/Beteg/…)**, shift (idősáv string), doc (dokumentum-státusz)
- `applications[]`: child, parent, group, **stage (Érdeklődő/Várólista/Felvett/Szerződés)**, note
- `events[]` (napi gondozási napló), `messages[]`, `documents[{name,type,status(REVIEW/MISSING/DRAFT/SIGNED),due}]`, `incidents[]`
- `dailyChecks[]`, `hygiene[]`, `stock[{name,value,min}]`
- `menu[]`: id, day, date, breakfast, lunch, snack, **allergens**, **diet** (diétás alternatíva), status, **parentVisible** + `menuMeta{weekOf, status, publishedAt, approvedBy}`
- `mealPolicy{lunchFee:1450, cancellationDeadline:"előző munkanap 09:00", defaultStatus}`
- `absences[]`: childId, from, to, reason, lunchCancel, **mealDays, mealCredit, mealStatus** + `mealLedger[]` (ebédjóváírás-főkönyv: period, days, amount, status, source)
- `payments[]`, **`invoices[]`** (number CSB-YYYY-####, period, issue/dueDate, amount, paid, status, paymentMethod), **`paymentReceipts[]`** (bevételi bizonylat BEV/KP-YYYY-####, payer, method, recordedBy)
- `parentContacts[]`: parent, childId, group, channel, **registered** (regisztrált-e a szülő)
- `communication{templates[], automations[], campaigns[]}` — havi programlista / heti étlap / fizetési emlékeztető, időzítéssel, célközönséggel, kizárt címzettekkel
- `governance{representative(e-képviselő), reports[MŰKENG/KENYSZI/országos/MÁK/KSH-OSAP], kenyszi{serviceDate, dailyDeadline, nextDeadline, monthlyClose, warningDays, lastSubmitted, normativeRule, checks[]}, complaints[]}`
- `privacy{notice, consents[{child,type,status,basis,channel}]}`, `safety[{munkavédelem/balesetvédelem/egészség, status, due}]`
- `organization{maintainer, tax, address, contact, site, mukeng, licenseStatus, network, coordinator, open, close, summerClosure, closureNotice}`
- `sync{mode:"Offline-first", queue[]}`, `audit[]`

**Kulcs domain-logika (kiolvasott):**
- `groupCoverage(group)`: kids = aktív (nem Kifut/Szüneteltetett) gyerek; working = nem beteg/felmondás alatti dolgozó; **needed = max(minAdultsPerOpenGroup, ceil(kids/maxChildrenPerAdult))**; openOk = working≥needed; capacityOk = kids≤capacity
- `groupOpeningReadiness(group)`: hiánylista = openingTasks + (nincs dolgozó → "dolgozói beosztás") + (<2 jelentkező → "jelentkezők visszaigazolása"); ok ha üres
- `kenysziRows()`: reportable ha **careStatus ∈ {Jár,Beszokó}** ÉS jelen (CHECKED_IN/OUT) ÉS TAJ megvan ÉS igazolás nem hiányos; blocker-okok kigyűjtve (jogviszony / nincs jelenlét-igazolt-hiányzás / TAJ hiányzik / igazolás hiányos)
- `kenysziSummary()`: present/reportable/justified/blockers + napi jelenléti zárás állapot
- `mealCredit(days)=days×1450`; `childBalance = Σ számla-egyenleg` v. `amount−paid−ebédjóváírás`
- `invoiceStatus`/`invoiceBalance`/`syncPaymentSummary` — számla↔befizetés összegzés
- `openModal(type)` 33 modál-típussal (lásd lent)

**33 modál / művelet (`data-modal`):** arrival, checkout, absence, event, incident, message, document, consent, pickup, child-group, child-health, application, agreement, group, group-rule, staff-doc, shift, staff-group, stock, temperature, menu-week, menu-day, meal-policy, invoice, issue-invoice, cash-payment, communication, automation, complaint, representative, organization, network, closure.

**User-oldalak:** (1) Admin/fenntartó — 13 nézet, teljes működtetés; (2) Gondozó — Ma/Gyermekek/Üzenetek/Csoportnapló; (3) **Szülő — teljes önálló app**: napi összefoglaló, előre jelzett hiányzás + ebédlemondás, üzenet, dokumentum-feltöltés, átvevő megjelölése, heti étlap (ha publikált), pénzügyi összesítő/számlák.

---

## 3. Követelmény cross-map (Istvan explicit listája × jelenlét/hiány × proto)

Jelölés: ✅ PRESENT · 🟡 PARTIAL · ❌ MISSING (új build)

| # | Istvan követelmény | Thick | V1 | V2 | Összesített + megjegyzés |
|---|---|---|---|---|---|
| 1 | **Több telephely + több csoport** | ❌ (1 csoport) | 🟡 (Katica/Maci tab, 1 site) | 🟡 (3 csoport + `site` mező + `organization` 1 telephely + hálózati koordináció) | **Multi-group PRESENT (V2). Multi-telephely csak címke-szinten** — nincs telephely-váltás, per-site aggregáció, per-site engedély/MŰKENG. |
| 2 | **Munkaerő-nyilvántartás + beosztás, nyitvatartás-lefedettség ellenőrzés, szabadság/betegség** | ❌ (2 statikus nevelő) | 🟡 (heti `shifts[5]`, "Szabadság", coverage-sáv, staff-doc lejárat, compliance lefedettség) | 🟡 (`groupCoverage` needed vs working, `workStatus` beteg kizárva, per-group openOk) | **Reg + arány-lefedettség PRESENT. Hiányzik: valódi heti/műszak-naptár szabadság/betegség/helyettesítés roster-rel és automatikus lefedettség-rés detektálás a TELJES nyitvatartásra** (mindkettő csak sáv/single-shift közelítés). |
| 3 | **Gyerekek: betegségek, érkezés/távozás idő, ki viheti el** | 🟡 (allergy Art.9, jelenlét; nincs idő/pickup) | ✅ (arrival/departure idő, note betegség, health-nézet hiányzás/allergia/gyógyszer/incidens, dossier **pickups**) | ✅ (attendance állapotgép + arrival+checkout idő, taj/sni/immunization/allergy, **pickup[]**, absences reason/dátum, incidens) | **PRESENT (V2/V1).** Betegség-nyilvántartás: V1 health-view + V2 absences/immunization erős. |
| 4 | **Csoportnyitás, felvétel, VÁRÓLISTA, meddig marad / óvodába megy** | 🟡 (`intakeChild`→waitlist, `finalizeEnrollment`) | 🟡 (admissions pipeline + 8-állapot lifecycle, endReason "Korcsoportváltás") | ✅ (applications stage-ek **Várólista** incl., group.**waitlist[]**, "Induló" csoport plannedStart-tal, `groupOpeningReadiness`, careStatus **Kifut**/lifecycle CLOSING) | **Intake + várólista + csoportnyitás PRESENT (V2). "Meddig marad / mikor megy óvodába": csak implicit (Kifut/CLOSING)** — nincs explicit tartózkodási-idő / óvoda-kifutás dátum/kor-alapú projekció. |
| 5 | **Étlap-kezelés + létszám-kezelés** | ❌ étlap; létszám = jelenlét→mealCount | ✅ (heti étlap étkezésenként, allergének, diétás változatok, `editMenu`) | ✅ (menu per-nap allergén/diéta/status/**parentVisible**, menuMeta jóváhagyás/publikálás, `menuProgress`, ebédlemondás→mealDays) | **Étlap PRESENT (V1/V2). Létszám: jelenlét + ebédlemondás-napok. Hiányzik: aggregált konyhai adagszám (normál+diétánként) az étlaphoz kötve.** |
| 6 | **Tisztítószer-kezelés + leltár** | ❌ | ✅ (`stock` kategória/mennyiség/egység/**minimum**/**lejárat**, low-stock, `addStock` bevét/felhasználás/leltár, higiéniai ütemezés kadenciával, HACCP hőmérséklet) | 🟡 (`stock{value,min}`, hygiene done/last — de nincs kategória/lejárat/SDS) | **PRESENT (V1 a legerősebb). Hiányzik mindenhol: vegyszer biztonsági adatlap (SDS) nyilvántartás + beszerzési/rendelési workflow + vegyszer-lejárat riasztás.** |

---

## 4. Notable domain-logika (Magyar-specifikus)

**Normatíva-alap (thick):** `normatíva-egység = jelenléti napok / 228`, havi = korábbi (111) + mai jelen. A KENYSZI napi jelenlét a forrás. "Ez az elszámolás ALAPJA, nem a benyújtandó összeg; a MÁK-elszámolás a fenntartó felelőssége."

**Térítési díj / ebédjóváírás (deadline-rule):**
- Thick: `MEAL_FEE=820 Ft`, határidő **09:00**; lemondás előtte → jóváírás, MealCount−1; utána → terhelve marad. Determinisztikus, verziózott.
- V2: `lunchFee=1450 Ft`, `cancellationDeadline="előző munkanap 09:00"`; `mealCredit=days×1450`; hiányzás → `mealLedger` jóváírási tétel; a fenntartó a pénzügyi nézetben írja jóvá.

**KÉNYSZI (KENYSZI):**
- Thick: napi jelenlét 16:00-ig, Cégkapu-ready CSV export.
- V2 (leggazdagabb): `kenyszi{serviceDate, dailyDeadline 18:00, nextDeadline, monthlyClose, warningDays:2, lastSubmitted, normativeRule}`; `kenysziRows` reportability-motor (careStatus Jár/Beszokó + jelen/igazolt + TAJ + oltás-igazolás); blocker-lista; napi zárás-ellenőrzés. **normativeRule:** "Normatívába csak aktív jogviszonyú és ténylegesen jelen lévő / jogszerűen igazolt gyermek számolható."

**Gondozó–gyerek arány / 7+1:** Thick `RATIO_RULE` 5/1 alap, **segítővel max 7** (15/1998 NM r. M5), az **egyidejűleg jelenlévő** létszámra, SNI csökkentett. V1 `modeCapacity` Alap 5 / Segítővel 7 / SNI 3. V2 group.capacity 7 + `groupRules.maxChildrenPerAdult 5`. A "7+1/csoport" tehát PRESENT kapacitás/arány-szabályként.

**Az "egy-adatfelvitel → kimenetek" (single-entry) modell — a thick proto tézise:** egy forrás-eseményt EGYSZER rögzítesz (AttendanceRecord vagy MealCancel), és a derivált kimenetek (normatíva-alap, csoportnapló, MealCount, térítési díj, igazolt-hiányzás) determinisztikusan, auditáltan (`log[]` fan-out) frissülnek. A bölcsődei admin-teher fő oka a **dupla-felvitel** — ez a modell szünteti meg. **Ezt a mintát kell a V2 gazdag adatmodelljére ráültetni.**

**Governance / jelentési ritmus (V1+V2):** e-képviselő, MŰKENG törzsadat, KENYSZI napi, országos jelentés (ápr.1 + szept.1: férőhely/SNI/foglalkoztatottak), MÁK támogatás-elszámolás (köv. év márc.31), KSH/OSAP éves; offline-first kézi beküldési sor (nem küld automatikusan állami rendszerbe).

**Üzemeltetés (V1):** 4–12h napi gondozási idő, nyári zárás ≤5 hét, febr.15 szülői tájékoztatás, személyzeti dokumentum-lejáratok, textil/higiénia kadencia (ágynemű 14 naponta, törülköző hetente, pelenkázó minden használat után).

---

## 5. Gapek — amit Istvan követelményei igényelnek, de EGYIK protóban SINCS (buildelendő)

1. **Valódi multi-telephely menedzsment.** Csak `site` címke van (V2). Kell: telephely-váltó, per-telephely aggregáció (létszám/lefedettség/pénzügy/jelentés), per-telephely engedély + MŰKENG-azonosító, hálózati koordinátor több telephellyel.
2. **Valódi munkaerő-beosztás motor.** Van heti shift-string (V1) és per-group coverage (V2), de nincs: műszak-naptár szabadság/betegség/helyettesítés roster-rel, és **automatikus lefedettség-rés detektálás a teljes nyitvatartásra** (nem statikus sáv / single-shift). Ez Istvan #2 magja ("ellenőrizve hogy a nyitvatartásra elég-e a létszám").
3. **Tisztítószer/vegyszer teljes kezelés.** V1 leltár+minimum+lejárat erős, de sehol: **biztonsági adatlap (SDS) nyilvántartás**, vegyszer-lejárat riasztás, **beszerzési/rendelési workflow** (a vezetők.txt-ben konkrét fájdalom: "METRÓ-ban már nincs, hol szerezzem be").
4. **Átvevő (pickup) hitelesítéssel + egyszeri meghatalmazott.** V2-ben van pickup-lista + "átvevő megjelölése", de nincs személyazonosság-ellenőrzés és **egyszeri/alkalmi átvevő** ("holnap nagymama hozza el") naplózott kezelése.
5. **Tartózkodási idő → óvoda-kifutás projekció.** Csak implicit (careStatus Kifut / lifecycle CLOSING). Kell: kor/dátum-alapú "meddig marad, mikor megy óvodába" előrejelzés és férőhely-tervezés.
6. **Konyhai adagszám-derivació.** Diétás változatok listázva (V1/V2), de nincs az étlaphoz kötött **aggregált főzendő adagszám** (normál + diétánként) a napi jelenlét/létszámból — Istvan #5 "létszám-kezelés" konyhai fele.
7. **Ágazati pótlék.** Egyik protóban sincs (a vezetők.txt-ben és a piaci vitában felmerül: "Az ágazati pótlék? Az E."). **Megjegyzés (memória-egyeztetés):** az ágazati pótlék bér-kiegészítés → **Bölcsi/számfejtés + MÁK-igénylés modul**, NEM a MikroKönyv és feltehetően nem a core menedzsment-app scope-ja — build-döntés kell, hova kerül.
8. **Auth / RBAC / szerveroldal.** Mindhárom proto localStorage, nincs belépés, szerepkör-jogosultság, titkosítás, változásnapló szerveroldalon. Éles gyermek-PII (Art.9 egészségügyi) kezeléshez kötelező (MEGFELELOSEGI_JEGYZET 3. pont). A KUTATASI_TANULSAGOK 6 szerepkört sorol: fenntartó, telephelyvezető, gondozó, helyettes, szülő, e-képviselő.

---

## 6. Kulcs-tanulságok (KUTATASI_TANULSAGOK.md + MEGFELELOSEGI_JEGYZET.md + vezetők.txt)

**KUTATASI_TANULSAGOK.md** (forrás: deep-research a családi bölcsiről; MACSKE/jogszabály/MÁK/Szociális Ágazati Portál/NAIH):
- A családi bölcsőde **elsődlegesen megfelelőségi és működtetési környezet, nem általános daycare-app** → elkülönített vezetői + megfelelőségi központ, jelentési/audit modul.
- A napi ellátás **gyors, mobilbarát, kevés-lépéses** bevitel (gondozói felület).
- A gyermek **életciklus** (jelentkezés→beszoktatás→jogviszony megszűnése) folyamat.
- Kötelező érzékeny terület: jelenlét, egészségügyi esemény, gyermekvédelem.
- Térítési díj / számlázási nyom / támogatási elszámolás = **vezetői felelősség**.
- KENYSZI/MŰKENG/országos adatszolgáltatás **külön munkafolyamat**.
- Személyi megfelelés + helyettesítés **nem egyszeri HR-adat** (lejáratok, műszakterv).
- **Offline-first + auditálható** működés tervezési elv; élesben szerveroldali naplózás + titkosítás + RBAC váltja ki.
- Következő éles fejlesztések: valódi login + 6 szerepkör; szerveroldali titkosított DB + változásnapló + backup; strukturált jogviszony-workflow; valós KENYSZI/MŰKENG/KSH adatcsomagok; szülői mobilfelület.

**MEGFELELOSEGI_JEGYZET.md** (elsődleges jogforrások, ellenőrizendők):
- 1997. évi XXXI. tv (Gyvt.); 15/1998. (IV.30.) NM rendelet (feladatok/működési feltételek); 369/2013. (X.24.) Korm. r. (hatósági nyilvántartás/ellenőrzés); Infotv. + GDPR (gyermek egészségügyi adat); 852/2004/EK + 1169/2011/EU (HACCP, allergén).
- Rendszer vs fenntartói feladat szétválasztva: a férőhelyet/arányt/HACCP-határértéket/KESZI-sablont a **fenntartónak** kell rögzítenie/ellenőriznie; a rendszer csak támogató.
- **Éles előtt kötelező:** fenntartói működési paraméterek; szakértői jogi felülvizsgálat (személyi feltétel, férőhely, támogatás); RBAC + naplózás + titkosítás + backup + adatfeldolgozói dok. **A localStorage csak demó — nem használható éles gyermekadatra.**

**családi bölcsi vezetők.txt** (pozicionálás/hangnem, valódi vezetői hangok — FB-csoport):
- A célszemély a **vidéki kis családi bölcsőde vezetője**, akinek nincs titkárnője/helyettese/HR/műszaki/jogi háttere: "egy telefon, egy kulcscsomó, egy határidőnapló". Reggel szakmai döntés, délelőtt szülő, délben beosztás-átírás, délután ellenőrzés-készülés, este dokumentáció. **Ez a termék valódi fájdalma és üzenete** (Radics Réka).
- Konkrét, kódolható domain-igények a beszélgetésekből: **elsősegély-képzés** szervezés; éves nyitvatartási maximum a feladatmutatóhoz; KENYSZI-változások követése; **e-aláírás** (ittirdala nem elfogadott, FlintSign személyi/szervezeti — MÁK-hitelesítés); besorolás/**ágazati pótlék** (OKJ vs diploma → C/E/F, "ágazati pótlék? Az E."); önellenőrzés-javítás elszámoláskor (csak mínuszba); **konyha/HACCP** (villanytűzhely kötelező, ételminta 72h, hűtő-cimkézés hús/tej/zöldség, 2 medencés mosogató, mosogatószer SDS, "családi étkeztetés" nem NÉBIH); **hasznos alapterület** számítás (nettó 24 nm / bruttó 25,5 nm, bútor max 1,5 nm); játszótér (nem kötelező telepített eszköz); **GDPR** — ki nézhet szenzitív adatot (csak hatósági személyek, jogszabályi felhatalmazással); segítő foglalkoztatása alvásidőben (feladat-hozzárendelés).
- Hangnem-tanulság: **"Nem panaszkodunk. Elmondjuk, mi történik valójában."** — őszinte, terepismeret-alapú, nem marketinges. Illik a Marveen melankolikus-megbízható hangneméhez.

---

### Egysoros konklúzió a caller-nek
Bázis = **V2** (leggazdagabb adatmodell + 3 role-workspace + KENYSZI/coverage/opening logika), ráültetve a **thick "Zsibongó" single-entry derivációs-gráf + audit fan-out** magját. A `marveen-review/bolcsi-proto.html` a thick proto byte-azonos másolata (nem külön forrás).
