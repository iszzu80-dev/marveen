# Marveen-kérés — APG Phase 1 A1 observe-only live pilot

GO az APG Phase 1 A1 observe-only live pilot aktiválására.

Pilotkártya:

`0e8d3bc5 — APG Phase 1 -- A1 observe-only live pilot (change 9959f705)`

Megfigyelt change:

`9959f705 — DORA lint-port`

## AKTIVÁLÁSI ELŐFELTÉTEL

Az adapterbekötés előtt ellenőrizd a `9959f705` tényleges állapotát.

A pilot ezen a change-en csak akkor aktiválható, ha:

- a change még nincs DONE/CLOSED állapotban;
- a lényegi implementációs commit még nem történt meg, vagy legalább a teszt/build lánc még nem zárult le;
- létrehozható egy egyértelmű `observation_started_at` UTC időpont;
- rögzíthető source-onként az induló watermark;
- a későbbi live események megkülönböztethetők a pilot előtt keletkezett történeti eseményektől.

Ha ezek nem teljesülnek:

- ne rekonstruáld a történeti eseményeket live pilotként;
- ne aktiváld automatikusan a fallback candidate-et;
- a kártya maradjon PLANNED;
- verdict: `A1_CANDIDATE_NO_LONGER_ELIGIBLE`;
- következő lépésként kérj új owner-döntést a fallback change-re.

## PILOTMÓD

Autonómiaszint:

`A1 — LIVE OBSERVE-ONLY`

Az APG kizárólag:

- jóváhagyott read-only forrásokat olvashat;
- a saját sidecar store-jába írhat;
- execution receiptet építhet;
- checkpointokat értékelhet;
- replayt és mérést végezhet;
- recommendation és acceptance reportot készíthet.

Tilos:

- Kanban write vagy státuszmódosítás;
- agent dispatch;
- source-módosítás;
- commit, push vagy PR;
- build vagy teszt indítása;
- deploy vagy rollback;
- feature flag módosítása;
- külső kommunikáció;
- Marveen core DB- vagy konfigurációírás;
- a normál change-flow lassítása vagy blokkolása.

## PRODUCER ÉS SESSION

Az adapterbekötéshez:

- egy producer agent;
- fresh session: `fresh:true`;
- `--continue` nélkül;
- ne örökölje a Phase 0 vagy korábbi fejlesztési sessionök kontextusát;
- initial Context Packet target: ≤3000 token;
- nincs kumulatív hard tokenlimit;
- quality-first és adaptív context policy marad érvényben.

A producer csak az adapterek bekötését és a sidecar A1 konfigurációját végezheti. A megfigyelt DORA change megvalósításában nem vehet részt.

## AKTÍV PROFIL

Induláskor:

`safe-release`

Az `identity-test-data` profil ne legyen aktív alapértelmezetten.

Csak akkor aktiválható, ha a live eventláncban tényleges test identity vagy test-data isolation evidence jelenik meg. Ebben az esetben rögzítsd:

- az aktiválás okát;
- az érintett evidence-et;
- az aktiválás időpontját;
- hogy az új profil nem változtatja meg visszamenőleg a korábbi checkpointokat.

## ENGEDÉLYEZETT ADAPTEREK

Kizárólag az alábbi öt read-only adapter:

1. Kanban card/event read;
2. agent message/completion metadata read;
3. Git commit/status read;
4. build/test evidence read;
5. token_usage read.

Render deploy-history és `/health` adapter nem aktiválható, mert ehhez a change-hez nincs runtime consumer.

Minden adapterhez még aktiválás előtt rögzítsd:

- olvasott mezők;
- read-only credential scope;
- polling vagy event mód;
- induló watermark;
- idempotency key;
- adatminimalizálás;
- output recordtípus;
- konkrét execution-receipt vagy mérési consumer;
- kiesési viselkedés.

Consumer nélküli mezőt vagy rekordtípust ne hozz létre.

## LIVE/HISTORICAL HATÁR

Minden bevett eseménynél legyen megkülönböztethető:

- `LIVE_OBSERVED`;
- `HISTORICAL_CONTEXT`;
- `UNKNOWN_ORIGIN`.

A pilot sikerességéhez szükséges commit/test/build evidence csak akkor számíthat live megfigyelésnek, ha az esemény source timestampje és ingestion timestampje az adapter watermarkja után van.

A pilot előtt keletkezett adat használható kontextusként, de nem állítható live megfigyelési bizonyítékként.

## VÁRHATÓ RECEIPT

A várt lánc:

`change → work_item → commit → test → build`

Elvárt állapot:

- change: PRESENT;
- work_item: PRESENT;
- commit: PRESENT vagy kezdetben MISSING;
- test: PRESENT vagy kezdetben MISSING;
- build: PRESENT vagy kezdetben MISSING;
- deployment: NOT_APPLICABLE;
- runtime evidence: NOT_APPLICABLE.

A NOT_APPLICABLE és UNKNOWN ne váljon PASS állapottá.

## CHECKPOINTOK

Értékeld:

- `spec_ready`;
- `implementation_ready`;
- `verification_ready`.

A következőket ennél a change-nél ne erőltesd PASS-ra:

- `release_ready`;
- `runtime_acceptance`.

Ezek legyenek a kanonikus modell által támogatott módon `NOT_APPLICABLE`, vagy ha ez nem reprezentálható egyértelműen, `UNKNOWN`, pontos indoklással.

## KÖTELEZŐ LIVE PILOT ESEMÉNYEK

A pilot alatt bizonyítandó:

1. első Kanban/source esemény ingestionje;
2. exact duplicate újraolvasása no-opként;
3. legalább egy agent completion metadata esemény;
4. Git commit linkelése a work itemhez;
5. teszteredmény vagy build evidence linkelése;
6. checkpoint újraértékelése új evidence érkezésekor;
7. hiányzó deployment/runtime evidence helyes N/A vagy MISSING címkézése;
8. élő receipt lezárása;
9. ingestion leállítása;
10. teljes replay kizárólag a tárolt rekordokból;
11. live és replay eredmény összehasonlítása.

Ne generálj mesterséges termékeseményt csak a pilot kedvéért. A megfigyelt change normál működését figyeld.

## STOP CONDITIONÖK

A pilot azonnal álljon le, ha:

- sidecaron kívüli write történne;
- bármely adapter credentialje nem read-only;
- credential vagy tiltott PII kerülne a store-ba;
- exact duplicate új rekordot vagy eltérő eredményt okozna;
- conflicting event felülírná az eredetit;
- checkpoint nem reprodukálható;
- a normál DORA change-flow lassulna vagy blokkolódna;
- a sidecar integrity sérülne;
- consumer nélküli rekordok aránya elérné vagy meghaladná a 30%-ot;
- folyamatos manuális beavatkozás válna szükségessé;
- az adapter source-határa nem különíti el a live és historical eseményeket.

Stop esetén:

- adapterek leállítása;
- ingestion kikapcsolása;
- rekordok és watermarkok megőrzése;
- normál Marveen-flow változatlan folytatása;
- `A1_PILOT_STOPPED` riport;
- automatikus javítás vagy újraindítás nélkül.

## FÜGGETLEN ACCEPTANCE

A producer nem fogadhatja el a saját pilotját.

Marveen főagent külön ellenőrizze:

- adapterenként a read-only határt;
- watermarkokat;
- live/historical besorolást;
- exact duplicate no-opot;
- conflictkezelést;
- credential/PII boundaryt;
- receipt-láncot;
- checkpointokat;
- side-effectek hiányát;
- ingestion leállíthatóságát;
- store-only replayt;
- live és replay egyezőségét;
- core érintetlenségét.

## SIKERKRITÉRIUM

A pilot csak akkor fogadható el, ha:

- live receipt és store-only replay azonos;
- invented evidence = 0;
- false PASS = 0;
- külső side effect = 0;
- duplicate record = 0;
- credential/PII leak = 0;
- core-módosítás = 0;
- a megfigyelt change APG nélkül is változatlanul végigment volna;
- checkpointok determinisztikusak;
- minden event-gap és MISSING állapot látható;
- minden rekordnak van consumerje;
- token-, runtime- és ceremony-adatok MEASURED/ESTIMATED/UNKNOWN címkézése korrekt;
- nincs megalapozatlan tokenmegtakarítási állítás.

## LEHETSÉGES VERDIKTEK

- `A1_PILOT_ACCEPTED`
- `A1_PILOT_RETURN_FOR_FIX`
- `A1_PILOT_STOPPED`
- `A1_PILOT_BLOCKED`
- `A1_CANDIDATE_NO_LONGER_ELIGIBLE`

Az elfogadott A1 pilot után Phase 2, A2, Kanban-write, agent-dispatch vagy recommendation-execution nem indulhat automatikusan.

## KÖZTES JELENTÉS

Csak ezeknél:

- candidate eligibility ellenőrzése;
- `A1_PRODUCER_ACKNOWLEDGED`;
- adapterek aktiválásra készek;
- első live event sikeresen beérkezett;
- stop condition;
- blocker;
- change lezárult, acceptance indul.

## ZÁRÓ RIPORT

Add vissza:

- candidate eligibility eredménye;
- pilotkártya státusza;
- producer és fresh session;
- initial packet mérete;
- observation_started_at és adapter-watermarkok;
- aktív profilok;
- aktivált adapterek;
- adapterenként olvasott mezők és credential scope;
- live/historical/unknown eseményszám;
- létrehozott rekordok és consumerek;
- receipt-lánc végállapota;
- checkpointok;
- exact duplicate eredménye;
- conflicting event eredménye;
- credential/PII scan;
- live receipt vs replay összehasonlítás;
- invented evidence;
- false PASS/false FAIL;
- UNKNOWN/MISSING/N-A;
- runtime overhead;
- ceremony overhead;
- tokenadatok MEASURED/ESTIMATED/UNKNOWN bontása;
- normál change-flow-ra gyakorolt hatás;
- core-módosítások;
- commit/deploy/upstream állapot;
- végleges pilotverdikt;
- következő egyetlen ajánlott lépés.

A következő döntési pont az A1 pilot tényleges eredménye. Az elfogadás sem jelent automatikus továbblépést A2-re vagy Phase 2-re.
