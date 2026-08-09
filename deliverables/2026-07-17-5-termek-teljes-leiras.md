# Marveen fleet — Az 5 termék teljes leírása

**Dátum:** 2026-07-17 · **Összeállította:** marveen · **Cél:** Istvan elemzéséhez — célcsoport, üzleti scope, funkciók, UI mind az 5 termékről
**Állapot-referencia:** a 2026-07-17-i élő fleet-állapot (business feature-scope 2026-07-03 + azóta épült funkciók szintézise)

> Megjegyzés az olvasáshoz: minden terméknél jelölöm, mi ÉL ma (deployolt), mi ROADMAP (tervezett), és hol tart a pozicionálás. A pozíció-mondatok ("wedge" = belépő éket adó fő differenciátor) a versenytárs-kutatásból származnak.

---

## 1. MikroKönyv (MK) — Átalányadó asszisztens

### Célcsoport
Magyar egyéni vállalkozók (EV), akik **átalányadózást** választottak vagy fontolgatnak. Nem a könyvelőt célozza, hanem magát a vállalkozót, aki maga akarja átlátni az adóterhét. Tipikusan: szabadúszók, kisiparosok, mellékállású vállalkozók, akiknek egy teljes könyvelőprogram túl sok, de az Excel/kézi számolás kockázatos.

### Üzleti scope és pozíció
- **Wedge:** NAV-adatok automatikus behúzása (NAV auto-pull) mint belépő pont. A számlázók (Számlázz.hu, Billingo) a SAJÁT adatbázisukban tárolnak, NEM a NAV-ból húznak vissza — ez az AI/adat-differenciátor.
- **Nem teljes könyvelőprogram** (tudatos MVP-first döntés): átalányadó-asszisztens, nem kettős könyvvitel. Ha a piac kéri, előbb validáljuk.
- **Honest-estimate garancia (2026-07 döntés C):** könyvelő-validáció nélkül a rendszer NEM ad kamu számot — ahol nincs accountant-validált számítás (nyugdíjas, szüneteltetés, táppénz, kedvezmények), ott szándékosan blokkolt, reason-code-os eredményt ad szám helyett. Ez a termék bizalmi alapja.
- **Árazás:** 3 500 Ft/hó, 1 hó trial (Istvan-lockolt).
- **Go-live állapot:** hard launch gate GREEN (QA e2e 20/20, 0 kamu-szám szivárgás), élesben, rejtett regisztrációs gombbal (kontrollált indulás).

### Funkciók
**Élő:**
- Átalányadó-kalkulátor + EV-forduló kezelés
- NAV auto-pull (MK-F1, QA-zva)
- Nyilvántartás UI (MK-F2)
- Határidő-naptár (F4), export (F6, PDF/ZIP — a UI belépési pont most került élesbe)
- Onboarding wizard (14 jogosultsági kérdés → számok → becslés → NAV-setup → dashboard)
- KATA vs átalányadó összehasonlító
- Ágazati pótlék-számítás támogatás (komplex Excel-igény, folyamatban)

**Roadmap:** banki tranzakció-szinkron (open banking, a legkeresettebb VOC-feature), több jogviszony kezelése (főállás+mellékállás+EV), SZJA-bevallás előkészítés (NAV-tervezet összevetés), KATA/átalányadó/SZJA váltás-szimuláció, hosszú távon AI-alapú banki sor-kategorizálás (senki nem csinálja a HU piacon — XL differenciátor).

### UI
Világos, magyar nyelvű SaaS-felület. Belépés → dashboard: felül összegző kártyák (aktuális adóteher, közelgő határidők), navigáció jelenleg felső tab-sáv (Státusz / KATA-összehasonlító / Számlák / Beállítások), mobilon floating bottom dock (MobileDock). Az onboarding lépcsős kérdés-flow. Az export panel a Státusz fül alján (havi/éves PDF + könyvelői csomag ZIP). A blokkolt becslések reason-code-dal, nem üres hibaként jelennek meg. (A nav-irány most áll át egységes bal sidebar-ra a flotta-szintű nav-shell migrációval.)

---

## 2. QuickQuote (QQ) — Szakipari árajánlatkészítő

### Célcsoport
Magyar szakiparosok: villanyszerelők, vízvezeték-szerelők, burkolók, festők — akik helyszínen mérnek fel és gyorsan akarnak árajánlatot adni. Mobil-első munkavégzés, gyakran net nélküli helyszín. A jelenlegi alternatívájuk: kézi jegyzet + utólagos Excel, vagy semmi.

### Üzleti scope és pozíció
- **Wedge:** AI-capture — jegyzetből vagy hangból tételezett árajánlat. EGYEDÜLÁLLÓ a magyar piacon. A legközelebbi versenytárs (Colostok) form-alapú; a Számlázz.hu/Billingo a default, de nincs árajánlat-készítésük.
- **Pozíció:** nem számlázó (scope-guard), de a meglévő számlázóhoz integráció OK.
- **Árazás:** 4 900 Ft/hó, 3 ingyenes ajánlat után (Istvan-lockolt). 4 hetes ingyenes trial.
- **Go-live állapot:** AI-capture + quote-send + tracking élő. Email-kézbesítés (SES) most került teljes bekötésre — sandbox-módban bizonyítottan működik, az éles ügyfél-küldés az AWS production-jóváhagyásra vár (~24h). A fotó-becslés DPA-konform (Bedrock-EU).

### Funkciók
**Élő:**
- AI-capture (jegyzet/hang → tételezett ajánlat)
- Árajánlat küldés + megnyitás-követés (delivery-status)
- Online elfogadás gomb (quote accepted — bezárja a hurkot)
- Kézbesítés-státusz + újraküldés (most került UI-ra)
- Bounce/complaint kezelés (SES + SNS webhook)

**Roadmap:** SMS-küldés email mellett (a HU szakiparosok SMS-t használnak), fotó-csatolmány ajánlathoz, follow-up automatizmus (emlékeztető ha 3 napja nem nyitották meg), quote-templates (jó-jobb-legjobb 3 opció → magasabb átlag-ajánlat), voice-to-quote (STT+LLM pipeline — a capture-sebesség a wedge), Számlázz.hu/Billingo integráció (quote→invoice), PWA install + offline (helyszíni munkához).

### UI
Mobil-első, gyors bevitelre optimalizált. Fő képernyő: új ajánlat → capture (szöveg/hang) → a rendszer tételezi → szerkeszthető tétel-lista (nettó/ÁFA/bruttó) → küldés. Az ajánlat-lista státusz-jelölésekkel (elküldve / megnyitva / elfogadva). Az elfogadás-link a címzettnek rendes HTML-oldalt ad (nem nyers JSON), elfogadás/elutasítás formmal. Landing: prototípus-demo a headline AI-feature-rel (kliens-oldali mock, egyértelmű jelöléssel). A hangbevitel pontossága most kerül valós mikrofonos mérésre.

---

## 3. Zsibongo — Családi bölcsőde adminisztráció

### Célcsoport
Magyar **családi bölcsőde** fenntartók és üzemeltetők: kis létszámú, hatóság (KENYSZI/SZTFH) felé jelentési kötelezettséggel terhelt intézmények. A napi jelenlét-vezetéstől a normatíva-igénylésig terjedő adminisztráció a fájdalompont. Másodlagos: a szülők (értesítések, később önálló app).

### Üzleti scope és pozíció
- **Wedge:** KENYSZI portál-asszisztens — a napi jelenlét → KENYSZI → normatíva folyamat integrálása. EGYEDÜLÁLLÓ a magyar piacon; a Miniped más kategória (pedagógiai, nem adminisztrációs).
- **GDPR Art.9 érzékenység:** gyermek-adatok, allergia/étkezési adatok — determinisztikus cross-check és DPA/DPIA a production-deploy előfeltétele.
- **Árazás:** 4 990 Ft/hó alap + 3 900/telephely + 2 900/csoport, 1 hó trial (Istvan-véglegesítve).
- **Fontos elhatárolás:** az ágazati pótlék a Zsibongo/Bölcsi témája (bér-kiegészítés), NEM a MikroKönyvé.

### Funkciók
**Élő:**
- Jelenlét-nyilvántartás, étkezés-nyilvántartás
- Normatíva-számítás
- KENYSZI export
- Szülői értesítések
- Allergia-alert (determinisztikus)
- Helyettes-hálózat alapok (több-üzemeltetős marketplace irány)

**Roadmap:** Excel-import (gyerek-/költségadatok — az áttérési pain csökkentése), KENYSZI portál-kitöltési segédlet (verify-and-click: melyik mezőbe mit, kattintás-sorrendben — a fő ígéret), MAK igénylési segédlet (normatíva → térítési díj), onboarding wizard (<10 perc az első KENYSZI tábláig), multi-bölcsőde/lánc dashboard (a pricing már támogatja), szülői PWA app (viral wedge: a szülő szereti, a bölcsőde fizet), NAV auto-pull (MK-ből átemelve).

### UI
Adminisztráció-központú webes felület, most kap per-szerep mobil-navigációt. Fő nézetek: napi jelenlét-rács (gyerekenként/csoportonként), étkezés-jelölés, normatíva-nézet, KENYSZI-export képernyő. A helyettes-hálózat cross-operator marketplace nézet. Az onboarding a fenntartói setup lépcsős folyamata. A szülő-oldal jelenleg értesítés-alapú, később önálló app.

---

## 4. Eskuvo / LumaSeat — Esküvői ülésrend + vendor CRM

### Célcsoport
Két oldal: **(B2C) jegyespárok**, akik a saját esküvőjük vendéglistáját, RSVP-jét és ültetési rendjét szervezik; és **(B2B) esküvői szolgáltatók/szervezők** (vendor CRM). A LumaSeat a márkanév; a C0 üzletmodell-döntés szerint V1-ben a pár hívja meg a szervezőt (a professzionális több-ügyfeles planner-workflow a későbbi fizetős B2B termék).

### Üzleti scope és pozíció
- **Wedge:** AI-ültetésrend + vendor CRM egyben, HU-lokalizálva. EGYEDÜLÁLLÓ a magyar piacon; a nemzetközi versenytársak (TTO, WeddingFlow, Polivents) nem HU-lokalizáltak, a SeatPlan.io csak a seating-részhez közel.
- **Viral wedge:** RSVP ingyen — a pár ingyen használja, látja az értéket, megveszi a seating-et.
- **GDPR-modell (2026-07-16 döntés A + gpt-5.6-sol validáció):** a pár háztartási kivétel alatt (Art. 2(2)(c)), a platform az adatkezelő; split-role a fiók/analitika vs a pár által vezérelt workspace-tartalom közt; a szervező (planner) belépése szabályozott-workspace módot indít; az allergén/étkezési (Art.9) adatra a VENDÉG ad kifejezett hozzájárulást az RSVP-nél.
- **Árazás:** RSVP ingyen (viral), seating/AI-terv ~4-5k Ft/esemény + add-onok (Istvan-véglegesítve). A Premium fizetőfal a workspace-hez kötött; a Barion fizetés-integráció a fiók-hozzáférésre vár (hold).
- **Go-live állapot:** a teljes stack élesben (B1 rename, C1 planner-schema, C2 pár-hívja-meg-szervező, DXF-import UI, Premium hard-gate), rejtett regisztrációs gombbal; payer-audit: 0 fizető tenant.

### Funkciók
**Élő:**
- AI seating (ültetésrend-generálás)
- Vendor CRM (szolgáltató-oldal)
- RSVP (ingyen, viral)
- Pár meghívja a szervezőt (C2), planner acting-as workspace-scoped hozzáféréssel
- DXF floor-plan import (valós backend)
- Premium hard-gate (workspace-scoped)

**Roadmap:** seating export PDF + link-megosztás, drag-and-drop seating canvas (RoomCanvas SVG → interaktív), AI "explain" (miért így ültetett), RSVP→seating upsell flow, vendor CRM pipeline-automatizmus, e-signature/szerződés-sablonok, vendor marketplace/discovery, planner-tier B2B2C bővítés (C3/C4 HOLD — a későbbi fizetős B2B termék).

### UI
Elegáns app + funky landing (hibrid brand-irány). Az app most kap világos, meleg-ivory reskint a 08-as brand board szerint (pezsgő-arany/szilva/blush/ivory/zsálya) — eddig sötét suite-shell + arany. Fő nézetek: vendéglista/RSVP-kezelés, seating-terem (jelenleg lista/SVG, roadmap: drag-and-drop canvas), vendor CRM pipeline. A planner-meghívás flow + a szabályozott-workspace lépés (GDPR). A landing a RSVP-ingyen viral belépőt hangsúlyozza.

---

## 5. DORA — NIS2/DORA compliance platform

### Célcsoport
Közepes méretű magyar cégek IT-biztonsági / compliance vezetői és a nekik dolgozó **HU NIS2/DORA-tanácsadók**, akiknek SZTFH-konform bizonyíték-kezelés és jelentés kell. B2B, hosszabb sales-ciklus. Nem önkiszolgáló tömegtermék — tanácsadó-vezérelt bevezetés.

### Üzleti scope és pozíció
- **Wedge:** SZTFH-konform OSCAL export. EGYEDÜLÁLLÓ a magyar piacon; a SIREN a legközelebbi, de OSCAL nélkül. A valódi differenciátor a SZTFH-OSCAL + HU-lokalizáció + NIS2 catalog completeness + HU tanácsadói kapcsolatok (mert az OSCAL-t az open-source Evidentia is tudja).
- **Stratégiai kockázat:** az Evidentia (ingyenes, 13 MCP tool, 92 framework) — a differenciálás NEM az export, hanem a HU-konformitás és a kapcsolat.
- **Jogszabályi alap:** a magyar Kiberbiztonsági tv. helyes hivatkozása 2024. évi LXIX. (a 2023. évi XXIII. hatályon kívül); SZTFH 5.§(8) OSCAL-mandátum.
- **Árazás:** seat + workspace alapú recurring SaaS irány (véglegesítés folyamatban).
- **Go-live állapot:** teljes Supplier Assurance MVP epic élesben (8 feature), regisztráció rejtve, access-code-gated trial (Istvan tartja az egyetlen kódot, nincs valódi tenant).

### Funkciók
**Élő:**
- Compliance engine (controls, evidence, documents, interviews)
- Valódi NIST OSCAL séma-validációs kapu (bizonyítottan elutasítja a hibás dokumentumot)
- Audit package, ChatWizard
- Supplier Assurance MVP (mind a 8 feature): Scope Checker 3-utas (NIS2 / CSA-applicant / consultant), banki kérdőív-tracker, Evidence Pack 8-domain wizard, publikus Trust Profile + authed CRUD, Service Register, szerződés-checklist (HU seed szövegekkel), Audit Package OSCAL-validációval, SA-12 jóváhagyási workflow (JWT-derivált jóváhagyó, hamisíthatatlan)

**Roadmap:** SA-10 Assurance Request Inbox (churn-rés zárás vs Orbiq), SA-13 Evidence Freshness, SA-12 approval-workflow bővítés, pricing véglegesítés, KMS production key, self-service demo/trial, NIS2 catalog completeness check, OSCAL validation feedback, white-label/tenant branding, bulk evidence import, audit log/activity feed, automated evidence collectors (API), pénzügyi szektor DORA-modul, MCP/AI agent integráció (hosszú távon paritás).

### UI
B2B compliance SPA (dora-web) a landing mögött. Fő nézetek: Scope Checker (kérdőíves interjú → 4-utas eredmény-kártya), system_scopes/EIS CRUD, workspace-scoped nézetek, Evidence Pack wizard (8 domain), Trust Profile publikus megosztó-oldal + authed szerkesztés, Service Register, Audit Package export. A hangsúly a bizonyíték-lánc átláthatóságán és az OSCAL-konformitáson. Access-code-gated belépés.

---

## 6. Cross-product szinergiák

| Feature | Termékek | Megjegyzés |
|---|---|---|
| NAV auto-pull | MK → Zsibongo | MK-F1 kész, átemelhető (legmagasabb ROI cross-feature) |
| SMS shared service | QQ, Eskuvo, Zsibongo | HU-felhasználók SMS-t használnak |
| SES email deliverability | QQ (kész), Eskuvo, DORA | a QQ-lánc receptté vált (skill) |
| AI/LLM pipeline (Bedrock-EU) | QQ (voice), Eskuvo (seating), Zsibongo | közös, DPA-konform infra |
| Multi-tenant dashboard | DORA, Zsibongo, Eskuvo | RLS már működik |
| Nav-shell (bal sidebar) | mind az 5 | most migrálódik, MK-pilot elöl |
| PWA + offline | QQ, Eskuvo, Zsibongo | közös PWA-arch, hosszú táv |

## 7. Prioritási sorrend (Istvan szerint)
1. **QuickQuote** — első termék, revenue-first
2. **MikroKönyv** — stabil user-base
3. **Zsibongo** — erős KENYSZI-wedge
4. **Eskuvo/LumaSeat** — viral wedge
5. **DORA** — B2B, hosszabb sales-ciklus

---

## Összefoglaló mátrix

| Termék | Célcsoport | Wedge (fő differenciátor) | Árazás | Élő állapot |
|---|---|---|---|---|
| MikroKönyv | Átalányadós EV-k | NAV auto-pull + honest-estimate | 3 500 Ft/hó | Élő, gate-green, rejtett reg |
| QuickQuote | Szakiparosok | AI-capture (jegyzet/hang→ajánlat) | 4 900 Ft/hó | Élő, email sandbox-kész, prod-jóváhagyásra vár |
| Zsibongo | Családi bölcsődék | KENYSZI portál-asszisztens | 4 990+/hó | Élő, per-szerep mobil-nav épül |
| Eskuvo/LumaSeat | Párok + esküvői vendorok | AI-seating + vendor CRM, RSVP-viral | RSVP ingyen + ~4-5k/esemény | Élő, rejtett reg, Barion hold |
| DORA | Cégek + HU compliance-tanácsadók | SZTFH-konform OSCAL export | seat+workspace (véglegesítés) | Élő, SA-epic kész, access-code-gated |

---

*Összeállította: marveen (Istvan AI asszisztense), 2026-07-17. Forrás: business feature-scope (2026-07-03) + a 2026-07-03..07-17 közötti élő build-állapot szintézise. A roadmap-elemek prioritás-sorrendje a visszajelzések alapján módosulhat.*
