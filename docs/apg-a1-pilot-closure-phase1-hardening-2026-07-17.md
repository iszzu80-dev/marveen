# Marveen-utasítás — A1 pilot lezárása és célzott Phase 1 hardening

Az A1 pilot eddigi működését helyesnek értékelem.

A pilot pontosan a kívánt viselkedést mutatta:

- csak a jóváhagyott read-only látókörből dolgozott;
- nem gyártott bizonyítékot;
- a commit- és test/build-linket artifact hiányában helyesen MISSING állapotban hagyta;
- az exact duplicate no-op működött;
- a normál change-flow-ra nem gyakorolt hatást;
- a felmerült scope-bővítéseknél megállt;
- egy valós shared-checkout/branch kockázatot passzívan felszínre hozott.

## DÖNTÉS A JELENLEGI PILOTRÓL

Folytasd és fejezd be a jelenlegi `9959f705` A1 pilotot a már jóváhagyott scope-ban.

Most:

1. ne adj hozzá új adaptert;
2. ne módosítsd a W3 receipt-kódot;
3. ne próbáld a hiányzó commit- vagy test/build-evidence-et rekonstruálni;
4. ne módosítsd a DORA change-et vagy annak branchét;
5. ne induljon automatikusan második A1 pilot.

A jelenlegi pilot lezárásakor:

- zárd le az observation window-t;
- állítsd le az ingestiont;
- őrizd meg a watermarkokat és append-only rekordokat;
- készíts receiptet kizárólag a ténylegesen tárolt eseményekből;
- futtasd le a store-only replayt;
- hasonlítsd össze az előállított receiptet és a replay eredményét;
- futtasd a checkpointértékelést;
- végezd el a független acceptance-et.

## A HÁROM FELTÁRT RÉS BESOROLÁSA

### 1. Commit kívül esett a jóváhagyott adapter-látókörön

Besorolás:

`OBSERVABILITY_GAP`

Következmény:

- implementation evidence: `MISSING`;
- nem invented evidence;
- nem APG-integritási hiba;
- nem javítható a jelenlegi pilot scope-jának tágításával.

A záró riport rögzítse:

- mely repository/branch tartalmazza a commitot;
- mely jóváhagyott adapter miatt nem volt látható;
- ez false PASS-t vagy invented evidence-et nem okozott-e.

### 2. Érdemi bizonyíték Kanban-kommentben található

Besorolás:

`ADAPTER_COVERAGE_GAP`

Javasolt következő képesség:

`kanban_comments read-only adapter`

Ez ne kerüljön be automatikusan a jelenlegi pilotba.

A későbbi implementáció előtt külön rögzíteni kell:

- pontosan mely kommentmezők olvashatók;
- hogyan különül el szerzői állítás a verifikált evidence-től;
- hogyan történik a PII/credential-szűrés;
- mi az idempotency key;
- mely receipt-link a konkrét consumer;
- a komment tartalma önmagában milyen evidence-szintet érhet el.

Fontos szabály:

> Kanban-komment sem lehet automatikusan verifikált evidence. Elsősorban locator vagy állítás lehet, amely egy függetlenül ellenőrizhető artifactra mutat.

### 3. Live receipt-builder nincs implementálva

Besorolás:

`A1_CAPABILITY_GAP`

A jelenlegi pilotban megengedett:

- az observation window után, kizárólag a sidecarban tárolt élő eseményekből receiptet építeni;
- ezt egyértelműen `POST_OBSERVATION_RECEIPT` vagy azzal egyenértékű címkével jelölni.

Nem állítható:

- hogy a receipt folyamatosan, élőben épült;
- hogy minden checkpoint valós időben újraértékelődött, ha ez nem történt meg.

A következő megerősítő A1 pilot előtt szükséges:

- minimális live receipt-builder;
- új evidence érkezésekor determinisztikus receipt-frissítés;
- checkpoint újraértékelés;
- ugyanazon tárolt eventláncból store-only replay;
- live final state és replay final state összehasonlítása.

Ez sidecar-képesség, de már nem puszta konfigurációs javítás. Külön szűk implementációs kártyát igényel.

## SHARED-CHECKOUT / BRANCH TALÁLAT

A `shared-dev/dora-app` branchre került linter-commit külön delivery-flow finding.

Besorolás:

`NORMAL_FLOW_REPOSITORY_TARGET_RISK`

Az APG:

- csak rögzítse és linkelje;
- ne mozgassa a commitot;
- ne cherry-pickeljen;
- ne javítsa a branchhelyzetet;
- ne írjon Kanbanra;
- ne avatkozzon be a normál delivery-flow-ba.

A deliverylead/devops külön kezelje a normál folyamatban.

A pilot záró riportban jelezd:

- az APG passzívan észlelte;
- volt-e bármilyen hatása a change-re;
- a findinghez milyen source event vagy evidence vezetett;
- a finding nem változtatta-e meg a checkpointot bizonyíték nélkül.

## PILOTVERDIKT

A független acceptance az alábbiak közül válasszon:

### `A1_PILOT_ACCEPTED_WITH_OBSERVABILITY_GAPS`

Akkor használható, ha:

- read-only boundary PASS;
- side-effect 0;
- credential/PII leak 0;
- duplicate kezelés PASS;
- stored-event replay determinisztikus;
- invented evidence 0;
- false PASS 0;
- a MISSING állapotok őszintén megmaradtak;
- a receipt egyértelműen post-observation receiptként van címkézve;
- a hiányzó live builder és adapter coverage nem okozott hamis eredményt.

### `A1_PILOT_RETURN_FOR_CAPABILITY_FIX`

Akkor használd, ha:

- a store-only receipt/replay nem reprodukálható;
- a checkpointeredmény nem determinisztikus;
- a live és historical események nem választhatók el;
- valamely gap hamis PASS-t vagy invented evidence-et okozott;
- a pilot acceptance a live receipt-builder nélkül nem bizonyítható.

### `A1_PILOT_STOPPED`

A már rögzített biztonsági vagy integritási stop condition esetén.

## GYORSÍTOTT KÖVETKEZŐ LÉPÉS

A jelenlegi pilot után ne induljon automatikusan a második pilot.

Az acceptance-riport alapján készíts egyetlen szűk Phase 1 hardening csomagot, legfeljebb két work itemmel:

1. `Minimal live receipt and checkpoint refresh`
2. `Kanban comments read-only evidence locator adapter`

Csak azokat hozd létre, amelyek az acceptance alapján ténylegesen szükségesek.

A kártyák:

- legyenek PLANNED;
- ne legyenek automatikusan dispatcholva;
- Marveen core módosítás: 0;
- sidecar-only;
- read-only;
- A1;
- ne tartalmazzanak új write-jogosultságot;
- ne tartalmazzanak schedulert vagy általános event platformot.

A következő owner-döntés egyetlen csomagra vonatkozzon:

`A1_CONFIRMATION_PILOT_HARDENING_GO`

Az előző gyorsítási utasítás többi elve megmarad:

- fázison belüli automatikus acceptance;
- legfeljebb két szűk fix–retest kör;
- adaptív context policy;
- A0 rollback minden pilotnál;
- Phase 2/A2 előtt külön owner-GO.

## A VÉGÉN CSAK EZT ADD VISSZA

- jelenlegi pilot végleges verdiktje;
- observation window;
- live/historical/unknown eseményszám;
- stored-event receipt és replay egyezése;
- receipt típusa: LIVE vagy POST_OBSERVATION;
- checkpointok;
- invented evidence;
- false PASS / false FAIL;
- MISSING / UNKNOWN / N-A;
- read-only boundary;
- credential/PII scan;
- duplicate/conflict eredmény;
- normál change-flow-ra gyakorolt hatás;
- shared-checkout finding;
- core-módosítás;
- szükséges Phase 1 hardening work itemek;
- létrejöttek-e PLANNED kártyák;
- automatikus második pilot indult-e: NEM;
- `READY_FOR_A1_CONFIRMATION_HARDENING_OWNER_APPROVAL` vagy `NOT_READY_FOR_A1_CONFIRMATION_HARDENING_OWNER_APPROVAL`;
- következő egyetlen ajánlott lépés.
