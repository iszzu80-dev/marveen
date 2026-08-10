# Marveen Optimalizálás oldal — teljes, egylépéses implementációs utasítás

> Owner spec, Istvan, 2026-07-30 (Telegram 7399-7407). Reprodukálva verbatim a producer számára.
> Ez a task 1 a "két dolog egymás után" éjszakai munkából. (Task 2 külön érkezik.)

Valósítsd meg teljes egészében a Marveen dashboard új Optimalizálás oldalát.
A Lean Optimization Phase 1, 2, 3 és 4 elkészült. Ez a feladat nem a háttérlogika újraírása, hanem az elkészült képességek egységes, egyszerűen használható és biztonságosan kapcsolható kezelőfelületének kialakítása.

## Végrehajtási felhatalmazás
Tulajdonosi GO van:
- a szükséges frontend fejlesztésre;
- az aggregáló read API-k létrehozására;
- a funkciókapcsolók és biztonságos konfigurációs API-k kialakítására;
- a szükséges, additív lokális konfigurációs séma bevezetésére;
- a dashboard navigáció módosítására;
- a HU és EN lokalizációra;
- a tesztekre;
- az as-built dokumentációra;
- a canaryra és a helyi deploymentben történő aktiválásra.

Ne állj meg köztes tervjóváhagyásért. Először ellenőrizd a jelenlegi élő kódot és a Phase 1–4 as-built dokumentációját, majd implementáld a teljes scope-ot.

Csak valódi hard blocker esetén állj meg:
- nem visszagörgethető adatvesztés;
- security vagy privacy kockázat;
- a Phase 1–4 tényleges implementációja lényegesen eltér az as-built dokumentációtól;
- a jelenlegi dashboard-architektúrában nem izolálható a változtatás;
- upstream-ütközés miatt tartós fork keletkezne.

Javítható build-, UI-, teszt- vagy kompatibilitási probléma miatt ne kérj új engedélyt. Javítsd és folytasd.

## 1. Termékcél
Az Optimalizálás oldal egyetlen helyen válaszoljon ezekre a kérdésekre:
- Működik-e jelenleg az optimalizálási rendszer?
- Van-e kapacitás-, routing-, minőségi vagy költségprobléma?
- Szükséges-e most tulajdonosi döntés?
- Mit javasol a rendszer? Miért ezt javasolja? Milyen bizonyíték alapján?
- Mekkora a várható pénzügyi és működési hatás?
- Mely funkciók aktívak?
- Hogyan kapcsolható ki az egész rendszer vagy annak egy része?
- Kikapcsoláskor mi marad biztonságosan működőképes?

Az oldal ne legyen technikai adattemető. A részletes nyers adatok maradjanak a meglévő oldalakon:
- Költségek: pénzügyi ledger, csomagok, költségforrások, budgetek;
- Token Monitor: tokenforgalom, input/output/cache tokenek, részletes agent- és modellhasználat;
- Optimalizálás: döntés, állapot, routing, hatékonyság, ajánlás és vezérlés.
Az Optimalizálás oldalon csak annyi költség- és tokenadat jelenjen meg, amennyi a döntéshez szükséges. Minden részletes adatnál legyen link a megfelelő meglévő oldalra.

## 2. Navigáció
A meglévő STATISZTIKÁK menücsoportban maradjon három külön oldal: Költségek, Token Monitor, Optimalizálás.
Új sidebar-elem: `data-page="optimization"`, label HU: Optimalizálás, EN: Optimization.
Ne vond össze és ne távolítsd el a Költségek vagy Token Monitor oldalt.
Sorrend: STATISZTIKÁK → Költségek → Token Monitor → Optimalizálás.
Az ikon egyszerű, a meglévő SVG-stílushoz illeszkedő (csúszkák/irányváltás/célkereszt). Ne vezess be új ikonkönyvtárat.

## 3. Információs architektúra
Négy belső nézet (nem több első szintű tab): Áttekintés / Routing és kapacitás / Döntések / Vezérlés.
HU: Áttekintés, Routing és kapacitás, Döntések, Vezérlés. EN: Overview, Routing & Capacity, Decisions, Controls.
A teljesítmény-, költség- és tokenadatok az Áttekintésben és a routing drill-downokban tömören; részletes elemzés a meglévő Költségek/Token Monitor oldalra mutat.
Tabváltás: ne töltsön újra teljes oldalt; őrizze meg az időszak- és agentszűrőt; billentyűzettel használható; mobilon vízszintesen görgethető/kompakt.

## 4. Globális fejléc (minden tabon azonos)
### 4.1 Cím
"Optimalizálás" / "Modell-, kapacitás-, költség- és csomagoptimalizálás".
### 4.2 Globális állapotjelző
Mutassa: globális mód; aktív modulok száma; adatfrissesség; van-e beavatkozást igénylő tétel.
Példák: `AKTÍV · 5/5 modul · Frissítve 3 perce`; `MEGFIGYELÉS · Automatikus routing kikapcsolva`; `KIKAPCSOLVA · Statikus agent-default működés`; `FIGYELMET IGÉNYEL · 2 döntés vár`.
A státusz ne csak színnel: szöveg + ikon + badge + tooltip/rövid magyarázat.
### 4.3 Globális módválasztó (jól látható, véletlenül ne kapcsolható)
Presetek:
- **Kikapcsolva**: minden opcionális modul leáll. Megmarad: statikus modelProfile feloldás; agent-default modell; CostOps/Token Monitor saját működése; privacy/security guardok; tárolt történeti adatok; read-only történeti nézet. Leáll: új attribution; Context Packet optimalizáció; capacity-aware runtime routing; automatikus fallback; új ajánlások; market watch scheduler; automatikus benchmark/screening scheduler.
- **Megfigyelés**: aktív: mérés; attribution; capacity-state gyűjtés; routing döntések szimulációja; recommendation calculation; market watch. Nem aktív: runtime routing beavatkozás; automatikus fallback; automatikus configváltoztatás. A felület mutathatja Would route / Would fallback / Would recommend, de nem módosít runtime viselkedést.
- **Tanácsadó**: aktív: mérés; Context Packet és session-hatékonyság; ajánlások; market watch; canary-javaslatok; routing előnézet. Nem aktív: automatikus capacity fallback. Minden routingváltozás emberi jóváhagyást igényel.
- **Aktív**: aktív: mérés; Context Packet; session guard; trusted-provider capacity-aware runtime routing; engedélyezett fallback; ajánlások; market watch. Továbbra sem aktív: automatikus csomagvásárlás; automatikus csomaglemondás; nem trusted provider külön engedély nélkül; automatikus privacy downgrade; több egymás utáni korlátlan fallback.
- **Egyedi**: a modulok külön kapcsolókkal, nem egyeznek egyik presettel sem.
### 4.4 Globális kikapcsolás
Külön "Optimalizálás kikapcsolása" gomb. Megnyomáskor előnézet (mi kapcsol ki / mi marad működőképes). Megerősítés után: atomikusan master OFF; ne töröljön adatot; ne írja át agentkonfigurációkat; ne szakítsa meg futó sticky munkacsomagot; új dispatch statikus default úton; előző modulkonfiguráció tárolása visszakapcsoláshoz; audit event.
Külön vészkapcsoló: "Routing azonnali leállítása" — csak a runtime routingot és új fallbacket állítja le; mérés/CostOps/ajánlások maradhatnak.

## 5. Áttekintés tab (vezetői főképernyő)
Alapnézet: max 6–8 elsődleges információblokk desktopon görgetés nélkül.
### 5.1 Első sor — döntési KPI-k (max öt kártya)
- **Rendszerállapot**: Rendben/Megfigyelés/Figyelmet igényel/Részben kikapcsolva/Kikapcsolva; globális mód; aktív modulok; konfiguráció érvényessége.
- **Döntésre vár**: nyitott ajánlások száma; kritikus döntések száma; legrégebbi nyitott döntés. Kattintás → Döntések tab pending szűrővel.
- **Kapacitáskockázat**: hány account/provider limited/blocked; van-e trusted fallback; legközelebbi ismert reset. Ne mutasson százalékot hiteles adat nélkül → `Nincs megbízható kvótaadat`.
- **Elfogadási minőség** (alap 30 nap): first-pass acceptance; retry rate; trend az előző időszakhoz. Kevés adat → `Nincs elegendő adat`.
- **Költség / elfogadott feladat**: marginális költség/accepted task; allokált költség/accepted task; trend; pénznem lokalizált (pl. `1 240 Ft / elfogadott feladat`). Ne keverd a marginális és allokált értéket.
### 5.2 „Mi igényel figyelmet?” blokk (az oldal legfontosabb része)
Max öt aktív tétel prioritás szerint: kritikus runtime/konfig probléma; blokkolt munkacsomag; kapacitásprobléma; minőségi/retry-regresszió; költség-/csomagajánlás; market change; adatfrissesség/evidence probléma.
Minden sor: severity; rövid cím; egy mondatos magyarázat; várható hatás; elsődleges cselekvés; részletek. Nincs tétel → `Nincs beavatkozást igénylő esemény.`
### 5.3 Kapacitásösszefoglaló
Account/provider kártyák/sorok: megjelenített név; provider; billing mód; capacity state; confidence; usage ha hitelesen mérhető; reset ha ismert; aktív agentek; fallback eligibility. Ismeretlen → `UNKNOWN / Nincs friss, megbízható kapacitásadat.` A UI ne fordítsa az unknownt 0%-ra.
### 5.4 Routing pillanatkép
Statikus primaryn futó agentek; trusted fallbacken futó csomagok; blokkolt dispatch; elmúlt 24h fallbackjei; primary retryre váró csomagok. Kompakt táblázat max öt sor (agent; modelProfile; configured primary; runtime; állapot; ok; mikor retry). Link: "Összes routing megnyitása" → Routing és kapacitás tab.
### 5.5 Hatékonysági összefoglaló
Négy mutató: fresh context medián; tokens/accepted task; retry rate; saturated session események. Két link (Részletes tokenhasználat / Részletes költségek) a meglévő oldalakra. Ne ismételd a grafikonokat.
### 5.6 Legfontosabb ajánlás
Csak egy elsődleges ajánlás kiemelve (pl. REBALANCE; bizonyosság; evidence; becsült hatás; minőségi kockázat; gombok). Nincs ajánlás → `Nincs aktuális változtatási javaslat.` Kevés evidence → `Még nincs elegendő adat megbízható ajánláshoz.`

## 6. Routing és kapacitás tab (operációs drill-down, nem nyers logoldal)
### 6.1 Felső szűrők: időszak; agent; modelProfile; provider/account; capacity state; routing state; fallback használt/nem; csak problémás. Alap: aktuális állapot, problémás felül.
### 6.2 Agent/runtime táblázat: Agent; Model profile; Configured primary; Runtime model; Account/provider; Capacity; Routing state; Fallback; Utolsó döntés; Részletek. Routing state: Primary/Fallback/Waiting for primary/Blocked/Static mode/Disabled/Unknown. Ne csak színnel.
### 6.3 Agent részletező drawer (oldalról nyíló): Konfiguráció (agent; modelProfile; explicit override; configured primary; fallback lista; account/auth profile; task profile-ok). Aktuális runtime (runtime model; provider; capacity state; sticky package; routing decision version; fallback oka; primary retry ideje). Teljesítmény (accepted task; first-pass; retry; tokens/accepted; cost/accepted; 30 nap trend). Eseménytörténet CSAK metadata (routing decision; capacity change; fallback; primary retry; block; config change) — prompt/tasktartalom SOHA. Műveletek: routing preview; fallback ideiglenes letiltása; static primary mode; canary kérése; konfiguráció megnyitása. Veszélyes változtatás: ne közvetlenül; approval request; pontos diff; rollbackterv.
### 6.4 Capacity timeline: provider/account szinten available/degraded/limited/blocked/unknown. Nem részletes grafikon — idővonal/kompakt eseménylista (pl. `10:42 LIMITED — 429`, `11:05 FALLBACK ACTIVATED`).
### 6.5 Routing előnézet (read-only "Mi történne most?"): bemenet agent; opcionális task profile; data sensitivity; task size. Kimenet: configured primary; capacity state; választott runtime; fallback; reason code; lenne-e block; melyik modul döntött. Ne indítson valós dispatch-et; ne kérjen promptot/tasktartalmat.

## 7. Döntések tab (ajánlások + tulajdonosi döntések inboxa)
### 7.1 Státuszok: Új; Megtekintett; Elfogadott; Elutasított; Elhalasztott; Canary szükséges; Végrehajtva; Lejárt; Insufficient evidence.
### 7.2 Szűrők: státusz; ajánlástípus; provider; csomag; agent/modelProfile; confidence; időszak; csak döntésre vár.
### 7.3 Ajánláskártya (egységes szerkezet):
- Fejléc: action (KEEP/UPGRADE/DOWNGRADE/CANCEL/ADD/ENABLE_USAGE_CREDIT/REBALANCE); rövid cím; confidence; státusz; létrehozás dátuma.
- Mit javasol? Egy mondat.
- Miért? 3–5 rövid bizonyíték (kihasználtság; overflow; blocked work; cost per accepted task; minőségi mutató; piaci változás).
- Mekkora a várható hatás? Külön: közvetlen havi pénzügyi hatás; allokált költséghatás; minőségi hatás; kapacitáshatás; privacy/vendor risk.
- Mennyire biztos? magas/közepes/alacsony/insufficient evidence + evidence window + adatfrissesség.
- Mi történik, ha elfogadom? Pontos magyarázat. KEEP → nincs configváltozás, lezárul. REBALANCE → routing/config diff + approval request + esetleg canary, csak jóváhagyás után. UPGRADE/DOWNGRADE/CANCEL/ADD → nincs automatikus külső vásárlás/lemondás; kézi teendőlista; "Elfogadva, külső végrehajtásra vár". ENABLE_USAGE_CREDIT → provideroldali kézi lépés, ne kapcsolja be automatikusan.
- Gombok (csak releváns): Elfogadom; Elutasítom; Elhalasztom; Bizonyíték; Canary előkészítése; Konfigurációs diff; Külső teendő kész; Döntés visszavonása.
### 7.4 Elhalasztás: 7 nap / következő billing ciklus / következő havi review / egyedi dátum. Elhalasztott ne legyen aktív sürgős az időpontig, kivéve ha az evidence lényegesen változik.
### 7.5 Döntési audit: ki; mikor; mit döntött; evidence version; config diff; végrehajtási állapot; rollback hivatkozás. Ne tároljon promptot/PII-t/secretet.

## 8. Vezérlés tab (biztonságos kapcsolófelület; advanced külön lenyitható)
### 8.1 Master kapcsoló: "Optimalizálási rendszer [BE/KI]" + rövid magyarázat. Kikapcsoláskor: előnézet; dependency hatás; megerősítés; audit; előző konfiguráció mentése.
### 8.2 Presetek: Kikapcsolva/Megfigyelés/Tanácsadó/Aktív; Egyedi automatikusan ha modul módosul. Minden preset kártyán: mit kapcsol be; mit nem; van-e runtime hatás; van-e automatikus fallback; van-e külső kereskedelmi hatás.
### 8.3 Modulkapcsolók:
- **A. Mérés és attribution**: dispatch_id; routing event; outcome; CostOps attribution; efficiency KPI-k. Kikapcsolás: új attribution leáll; történeti megmarad; Költségek/Token Monitor alapmérés NE álljon le; capacity routing és ajánlások nem maradhatnak aktívak. Dependency: routing és recommendation engine igényli.
- **B. Context efficiency**: Context Packet; artifact references; fresh token budget; checkpoint; no-new-large-task guard. Kikapcsolás: új packet-transzformáció leáll; meglévő biztonsági hard stop NE gyengüljön automatikusan; sessionek legacy dispatch formátumot használhatnak. Külön kapcsolható (advanced): packet compaction; artifact references; large-task session guard; automatic checkpoint request.
- **C. Capacity monitoring**: collectorok; capacity state; reset; confidence; capacity timeline. Kikapcsolás: új snapshotok leállnak; routing nem maradhat aktív; meglévő adatok stale-be.
- **D. Runtime routing**: subscription-first resolver; runtime-only fallback; sticky routing; primary retry. Kikapcsolás: új dispatch statikus configured primaryn; futó sticky package normál kikapcsolásnál befejezhető; vészleállításnál új fallback azonnal tiltott; configured primary nem változik. Dependency: modelProfile core; measurement; capacity monitoring.
- **E. Ajánlások**: KEEP/UPGRADE/DOWNGRADE; REBALANCE; evidence calculation; havi review. Kikapcsolás: új ajánlás nem készül; régiek történetként; pending "generation disabled" jelzés; nincs configváltozás. Dependency: measurement; CostOps attribution.
- **F. Market watch**: hivatalos forrásfigyelés; pricing diff; changelog; deprecation; change events. Kikapcsolás: scheduler leáll; manuális régi eredmények megmaradnak; ajánlások jelezzék hogy a piaci adat elavult lehet. Függetlenül kapcsolható az ajánlásoktól, de market-alapú recommendation nem készülhet friss market evidence nélkül.
- **G. Benchmark és canary recommendation**: benchmark pack; shadow evaluation; canary-javaslat. Kikapcsolás: új automatikus tesztjavaslat ne készüljön; kézi canary maradjon lehetséges az adminfelületen.
### 8.4 Nem kapcsolható alapok (a master switch NE kapcsolja ki): Statikus modelProfile resolution; Agent configured primary (mindig elérhető statikus alapút); Privacy és security guardok (ne legyenek a master alá rendelve — csak állapotként: Privacy gate OBSERVE/ENFORCE/OFF; Channel coverage COMPLETE/PARTIAL; External provider routing ENABLED/DISABLED; a privacy gate csak saját security beállításában, külön jóváhagyással kapcsolható); Költségek és Token Monitor önállóan tovább.
### 8.5 Dependency-kezelés: ne engedj érvénytelen kombinációt. Mérés kikapcsolása → Runtime routing + Ajánlások is kikapcsol (Market watch külön aktív maradhat). Routing bekapcsolása → ellenőrizd: measurement aktív; capacity monitoring aktív; config valid; legalább egy primary; fallback csak trusted provider; feature flag; rollback elérhető. Hiányzó előfeltétel → ne kapcsolja be részlegesen; mutassa mi hiányzik; ajánljon javítást.
### 8.6 Advanced konfiguráció (lenyitható): context thresholdok; capacity TTL-k; fallback maximum; primary retry policy; market watch schedule; recommendation evidence minimum; billing ciklus; dashboard időablakok. Ne default nézetben. Minden mező: érthető cím; magyarázat; valid tartomány; jelenlegi érték; default; reset gomb. Ne engedj veszélyes szabad szöveges JSON-szerkesztést az alapfelületen.

## 9. Konfigurációs modell (verziózott, deployment-local)
Javasolt séma:
```json
{
  "version": 1,
  "masterEnabled": true,
  "preset": "active",
  "modules": {
    "measurement": true, "contextEfficiency": true, "capacityMonitoring": true,
    "runtimeRouting": true, "recommendations": true, "marketWatch": true,
    "benchmarkRecommendations": true
  },
  "routing": { "automaticFallback": true, "trustedProvidersOnly": true, "maxFallbacksPerProfile": 2, "maxAutomaticFallbacksPerDispatch": 1 },
  "ui": { "defaultWindow": "30d", "showAllocationCost": true }
}
```
A tényleges séma igazodjon a meglévő Phase 1–4 implementációhoz. Követelmények: local; gitignored; schema-validált; atomikusan írható; verziózott; mentés előtt backup; safe example fájl a repóban; secretet nem tartalmaz; invalid confignál fail-safe statikus mód; a dashboard mutassa a validációs hibát. A master OFF állapot őrizze meg az előző modulkonfigurációt (`lastEnabledConfiguration`); visszakapcsoláskor ajánlja: "Előző konfiguráció visszaállítása".

## 10. Backend API (ne implementálj párhuzamos üzleti logikát a frontendben; aggregált API-k)
### 10.1 Read endpointok
- `GET /api/optimization/summary`: globális mód; modulállapotok; config health; data freshness; attention queue; fő KPI-k; capacity summary; routing summary; top recommendation; privacy/external-provider guardrail státusz. Ne írjon GET-re.
- `GET /api/optimization/routing` (params: agent; provider; state; time window; fallback; problematicOnly): current agent routes; active sticky packages; capacity states; routing events; retry schedule.
- `GET /api/optimization/recommendations` (params: status; action; confidence; provider; time window).
- `GET /api/optimization/settings`: master config; module config; dependencies; defaults; validation state; config version.
- `GET /api/optimization/audit`: csak metadata-alapú config- és döntéstörténet.
- `POST /api/optimization/routing/preview`: csak metadata (agent; task profile; sensitivity; task size). Nem fogad teljes promptot; nem indít dispatch-et.
### 10.2 Write endpointok
- `PATCH /api/optimization/settings`: config version/ETag; optimistic concurrency; schema validation; dependency validation; atomic write; backup; audit event; preview mód.
- `POST /api/optimization/emergency-disable`: azonnal runtime routing off; new fallback off; statikus primary mode. Ne állítsa le a teljes Marveent.
- Recommendation action endpointok: acknowledge; accept; reject; snooze; request_canary; mark_external_action_done. A commercial action elfogadása ne vásároljon semmit.
### 10.3 Auth és biztonság: minden /api/* a meglévő bearer/session auth; write endpointoknál megfelelő jogosultság; configváltozások auditálva; response ne tartalmazzon promptot/secretet/credentialt/raw account ID-t; frontend ne tároljon secretet localStorage-ban; érzékeny account megjelenítési név maszkolható.

## 11. Adatállapotok
A UI minden adathoz: fresh / stale / unknown / insufficient_evidence / disabled / error. Ne mutasson nullát ha nincs adat. Helytelen: `Claude usage: 0%` collector nélkül. Helyes: `Nincs megbízható usage adat / Utolsó sikeres mérés: 2 napja`. Helytelen: `Ajánlás: KEEP` két feladat alapján. Helyes: `INSUFFICIENT EVIDENCE / Legalább egy teljes billing ciklus szükséges.`

## 12. Vizualizációs elvek
Ne zsúfolt BI-dashboard. Használható: KPI-kártya; progress bar hiteles százaléknál; egyszerű trendjelző; rövid sparkline; kompakt táblázat; státuszbadge; prioritási lista; esemény-idővonal; részletező drawer. Kerülendő: kördiagramok tömege; több tengelyes grafikonok; dekoratív gauge-ok; 10-nél több szín; hosszú nyers JSON; teljes routing log az alapnézetben; minden metrika egyszerre; zavaró animáció. Szín ne legyen az egyetlen információhordozó. Státuszok: Rendben/Figyelés/Döntés szükséges/Kritikus/Kikapcsolva/Nincs elegendő adat/Elavult adat.

## 13. Reszponzív viselkedés
Desktop: KPI-k 4–5 oszlop; fő tartalom 2 oszlop; routing táblázat teljes szélesség; drawer jobbról. Tablet: KPI-k 2 oszlop; blokkok egymás alatt; táblázat vízszintesen görgethető. Mobil: egy oszlop; tabok kompaktak; routing táblázat agentkártyákká; elsődleges művelet könnyen elérhető; veszélyes gombok ne egymás mellett; fejlécben csak állapot+menü; részletes konfiguráció accordionokban. Ne legyen csak desktopon használható.

## 14. Akadálymentesség
Szemantikus HTML; heading hierarchy; keyboard navigation; látható focus; ARIA-label; tabok ARIA-szerepe; modálból focus return; ESC bezárás; kontrasztos világos+sötét mód; státusz ne csak színnel; screen reader számára érthető kapcsolóállapot; confirmation szöveg felolvasása.

## 15. Lokalizáció
Minden user-facing szöveg HU+EN. Használd a meglévő `web/lang/hu.js` és `web/lang/en.js` mintát. Magyar formázás: pénz hu-HU (pl. `82 400 Ft`); dátum/idő magyar locale; százalék lokalizálva. Ne legyen hardcoded magyar szöveg a JS üzleti logikában. Fallback nyelv a jelenlegi dashboard szabályai szerint.

## 16. Teljesítmény és frissítés
Az oldal megnyitása: ne indítson LLM-hívást; ne market screeninget; ne módosítson configot; ne írjon DB-be; csak meglévő aggregált adatot olvasson. A summary lehetőleg egy aggregált API-ból. Auto-frissítés: alap 60s vagy ritkább; láthatatlan tabon ne polloljon; manuális Frissítés gomb; utolsó frissítés ideje; stale response esetén ne villogjon/nullázzon. Ne adj hozzá nagy frontend frameworköt/chart libraryt csak ezért, ha a meglévő vanilla dashboardból megoldható.

## 17. Kapcsolat a meglévő oldalakkal
Költségek oldal marad source of truth (cost sources; fixed costs; ledger; budgetek; marginális/allokált). Az Optimalizálás linkjei átadhatnak szűrőket ("Költségek megnyitása ezzel a providerrel és időszakkal"). Token Monitor marad source of truth (token volume; agent; modell; input/output/cache; trend); link "Token Monitor megnyitása ezzel az agenttel és időszakkal". Jóváhagyások: routing/configváltozások approval requestet hozzanak létre, jelenjenek meg a meglévő Jóváhagyások oldalon, státuszuk az Optimalizálás oldalon is. Ügynökök: az agent lapján röviden modelProfile; configured primary; runtime model; routing state + link "Megnyitás az Optimalizálás oldalon".

## 18. Empty, disabled és error state-ek
Minden kikapcsolva: az oldal megnyitható; "Az optimalizálási rendszer ki van kapcsolva / agentek statikus modell / Költségek+Token Monitor elérhető / történeti adat nem törlődött" + [Előző konfiguráció visszaállítása][Megfigyelés bekapcsolása]. Nincs történeti adat: "Még nincs elegendő optimalizálási adat / Kapcsold be a Megfigyelést hogy viselkedésváltozás nélkül gyűjtsön". Konfigurációs hiba: "érvénytelen config / statikus primary módra állt / routing+fallback nem aktív" + [Hiba részletei][Alapérték visszaállítása]. API-hiba: betöltött adat marad stale jelzéssel, ne ürítse ki az oldalt. Modul kikapcsolva: halványított összefoglaló (pl. "Market watch kikapcsolva / Utolsó sikeres ellenőrzés: 2026. július 21.").

## 19. Tesztkövetelmények
Backend unit: summary aggregáció; unknown/stale; config schema; preset→module map; dependency validation; master off; previous config restoration; emergency routing disable; recommendation actions; no-write GET; audit redaction; invalid config fail-safe; optimistic concurrency.
Backend integration: CostOps összekapcsolás; Token Monitor összekapcsolás; routing+capacity; disabled module response; stale collector; insufficient evidence; approval creation; settings preview; atomic apply; rollback.
Frontend: oldal navigáció; négy tab; HU/EN; light/dark; globális preset; egyedi modulmód; dependency modal; master off confirmation; emergency disable; attention queue; recommendation card; agent drawer; routing preview; empty state; stale state; API error; insufficient evidence; részletes oldalak linkjei; mobil layout; keyboard navigation.
Smoke: Optimalizálás menüpont megnyílik; Költségek+Token Monitor változatlan; Summary betölt; Routing/Döntések/Vezérlés tab betölt; Megfigyelés preview működik; Master OFF működik; Előző config visszaállítható; oldalfrissítés után állapot megmarad; kikapcsolt routing mellett statikus primary; invalid config mellett safe mode.

## 20. Canary és rollout
Canary: jelenlegi lokális Marveen deployment; trusted provider setup; nincs nem trusted provider aktiválás; nincs automatikus csomag-/accountváltozás.
Forgatókönyvek: (1) Aktív — minden modul státusz helyes; summary egyezik a forrásadatokkal. (2) Megfigyelés — routing csak would_route; nincs valós váltás. (3) Runtime routing kikapcsolása — új dispatch statikus primaryn; CostOps/measurement megmarad. (4) Market watch kikapcsolása — scheduler leáll; utolsó adat stale; recommendation nem állít friss market evidence-t. (5) Teljes kikapcsolás — minden opcionális modul off; statikus modelProfile működik; agentek működnek; Költségek+Token Monitor működik; történeti adat látható. (6) Visszakapcsolás — előző modulkonfiguráció visszaáll; dependency validáció ok; scheduler/routing a konfigurált mód szerint. (7) Invalid config — static safe mode; UI egyértelmű hiba; nincs fallback. (8) Recommendation decision — elfogadás auditálódik; commercial action nem fut automatikusan; routing action approvalt hoz létre.

## 21. Acceptance kritériumok (csak ha MIND teljesül)
Optimalizálás külön menüpont Költségek+Token Monitor mellett; a két meglévő oldal nem romlik/nem vonódik össze; Áttekintés azonnal mutatja a rendszerállapotot+döntésre várókat; max négy elsődleges tab; részletes cost/token linkkel nyitható; kapacitás unknown NEM 0%; insufficient evidence esetén nincs találgatott ajánlás; recommendation kártyából érthető mit/miért/milyen evidence/milyen hatás/mit kell tenni; az egész rendszer kikapcsolható; modulok külön is; érvénytelen dependency nem menthető; kikapcsolás nem töröl adatot és nem ír át agent primary modellt; modelProfile statikus feloldás OFF módban is működik; privacy/security guard nem a master switch alatt; runtime routing külön vészkapcsolóval leállítható; kereskedelmi művelet nem automatikus; nem trusted provider nem aktiválódik; minden configváltozás auditált; GET nem ír; prompt/PII/credential/secret nem jelenik meg API-ban/auditban; HU+EN teljes; light+dark; desktop+tablet+mobil; keyboard+screen-reader alapok; build/typecheck/unit/integration/smoke zöld; rollback bizonyított; oldal nem indít LLM-et/market screeninget puszta megnyitáskor; helyi deployment upstream-frissíthető marad; as-built dokumentáció kész.

## 22. Scope-on kívül (NE valósítsd meg)
Új CostOps ledger; új Token Monitor; új recommendation engine ha Phase 4-ben van; új capacity router ha Phase 3-ban van; DeepSeek-specifikus routing; external provider aktiválás; privacy enforcement újratervezés; automatikus csomagvásárlás/lemondás/számlafizetés; minden task előtti LLM-alapú optimalizálás; frontend framework migráció; teljes dashboard redesign; unrelated UI cleanup. Az oldal a meglévő Phase 1–4 komponenseket aggregálja és vezérli.

## 23. Dokumentáció
Készíts `docs/optimization/optimization-dashboard-as-built.md`-t: cél; UI architektúra; tabok; adatforrások; API-k; konfiguráció; presetek; modulkapcsolók; dependency szabályok; OFF mód; emergency disable; approval flow; security/redaction; tesztek; canary; rollback; ismert korlátok; upstream/lokális határ. Frissítsd a releváns dashboard dokumentációt és HU/EN felhasználói leírást is.

## 24. Upstream és lokális határ
Upstream candidate: generikus Optimization dashboard shell; aggregáló API response schema; module feature-flag séma; preset/dependency rendszer; routing+recommendation UI komponensek; empty/stale/insufficient-evidence state-ek; safe-mode+emergency-disable interfész. Deployment-local: accountnevek; provider engedélyek; csomagárak; model profile mapping; recommendation thresholdok; market-watch források; trust policy; aktuális modulállapot. Ne nyiss upstream issue-t/PR-t külön tulajdonosi GO nélkül; az as-built végén készíts upstream-candidate listát.

## 25. Commitstratégia
Kevés, tiszta commit: `feat(optimization): add aggregate control-plane APIs`; `feat(dashboard): add optimization overview and routing views`; `feat(dashboard): add decisions and modular controls`; `test(optimization): cover modes, dependencies and safe rollback`; `docs(optimization): document optimization dashboard`. Ne legyen egyetlen kezelhetetlen commit; ne keverjen unrelated módosítást; ne tartalmazzon local adatot; minden commit revertálható.

## 26. Rollback (két szinten, TÉNYLEGESEN teszteld)
Runtime rollback: master OFF; runtime routing OFF; statikus configured primary; schedulerek leállítása; adatok megmaradnak. Code rollback: az UI+aggregáló API commitok revertálhatók úgy, hogy Költségek működik; Token Monitor működik; Phase 1–4 backend önállóan működik; agentek statikus defaulttal; nincs adatvesztő DB downgrade.

## 27. Végső jelentés
Jelents: kártya+státusz; branch+commit SHA-k; módosított fájlok; navigáció változása; négy tab; summary adatforrásai; presetek; modulkapcsolók; dependency szabályok; teljes OFF teszt; emergency routing disable teszt; previous config restore teszt; routing preview; recommendation decision flow; Cost/Token oldalak regressziótesztje; HU/EN; responsive+accessibility; API+security tesztek; canary; rollback; dokumentáció útvonala; upstream candidate-ek; ismert korlátok; végső verdikt.
Végső verdikt csak evidence alapján: **OPTIMIZATION DASHBOARD DONE** vagy **OPTIMIZATION DASHBOARD NO-GO**.
Az implementáció után állj meg. Ne aktiválj új providert, ne módosíts csomagot, ne nyiss upstream PR-t külön tulajdonosi GO nélkül.
