# Kódátvizsgálás: négy hiba-osztály, négy ügynök, verifikálva

**Dátum:** 2026-08-10 05:30 · **Kérte:** Istvan · **Futtatta és ellenőrizte:** Marveen

Négy ügynök, egy-egy hiba-osztályra, a teljes `src/` fán. Mindegyiknek három
szabálya volt: ne javítson, minden találathoz adjon futtatható bizonyítékot, és
a nulla találatot mondja ki tisztán.

**A lenti listán minden állítást magam futtattam újra.** Ahol csak az ügynök
szava van mögötte, ott ezt kiírom. Ez nem udvariasság: ma éjjel négyszer
találtam olyan magabiztos állítást, ami nem volt igaz, és egy ügynök jelentése
sem más.

---

## P0 — a biztonsági telemetria konstans

**7223 futás, egyetlen különböző érték.**

A haladás-motor hét kemény biztonsági állítást ellenőriz minden futásnál:
cross-domain szivárgás, rossz címzett, duplikált külső művelet, automatikus
fizetés, szerződés-aláírás, korai lezárás, szabály-megkerülés.

Verifikálva (saját lekérdezés):

```
safety_assertions_json distinct: 1
összes futás:                    7223
error_code:                      [(None, 7223)]
status:                          [('COMPLETED', 7223)]
```

Az ok, `src/cos/progression-eval.ts:100-180`:

- **négy** állítás kizárólag egy `error_code` értéket néz, amit a pipeline
  `null` literálként ad át (`progression-pipeline.ts:929`), és amit az INSERT is
  `NULL`-ként ír ki;
- **három** olyan döntés-értékekhez hasonlít (`EXECUTE_PAYMENT`,
  `COMMIT_CONTRACT`, `SIGN_LEGAL`), amik nincsenek a `ProgressionDecision`
  felsorolásban, tehát típusból elérhetetlenek;
- a `wrong_recipient` törzse szó szerint egy komment és egy `return null`.
  Semmilyen bemenetre nem tud elsülni.

Következmény: `runStatus` mindig `COMPLETED`, tehát a `safetyViolations.length`
soha nem nagyobb nullánál, tehát a terv-léptetés és a DoD-kapu feltétele is
mindig teljesül.

Ugyanaz a mondat, amit ma éjjel a lezáró kapura írtam: hetvenkét azonos
indoklás nem egyetértés, hanem az, hogy senki nem néz oda. Ez most 7223.

## P0 — nincs vészleállító

`pauseAll` (`src/cos/autonomy-ladder.ts:116`) globálisan megállítja a személyes
asszisztens minden autonóm műveletét; a kapcsolóját minden `permits()` döntés
olvassa. **Nincs hívója.** Se végpont, se script, se ütemezett feladat.

Verifikálva: a grep egyetlen sort ad, a definíciót. A `cos_autonomy_global`
tábla **0 soros**, tehát soha nem volt lenyomva.

## P1 — a megőrzési takarítás soha nem futott

`purgeExpiredAttachmentContent` (`src/cos/retention.ts:36`) a 90 napnál régebbi
melléklet-tartalmat nullázná ki, a checksum-sírkövet meghagyva. Nincs hívója.
A `cos_documents` tábla **88 sor**.

Ugyanebben a családban, mind verifikálva (a grep egyetlen sort ad, a
definíciót): `createEncryptedBackup` (titkosított mentés soha nem készült),
`revokeCampaign` / `pauseCampaign` / `resumeCampaign` (egy futó kampányt nem
lehet leállítani), `releaseQuota` (a kvóta csak felfelé számol, egy elbukott
küldés foglalása bent ragad), `markInvoicePaid` (céges számlát nem lehet
kifizetettre állítani), `assertStorePermissions` és `redactSensitive`,
`createRadarItem` (árfigyelést kód nem tud létrehozni; a 9 élő sor kézzel
került be).

## P1 — a "single choke point" nem choke point

`src/cos/dispatch-gate.ts:1-7` azt állítja, hogy MINDEN kimenő művelet egyetlen
kapun megy át, és hogy ez azért így van, hogy *"egy új küldési út ne
felejthessen el egy ellenőrzést"*.

Verifikálva: az `evaluateDispatch`-nek pontosan **egy** hívója van
(`send-flow.ts:176`). A `zst-send.ts` egy **második, párhuzamos** kaput
definiál (`evaluateZstSendGate`) — vagyis az az új küldési út, amiről a komment
azt mondja, nem fordulhat elő, már létezik. A `tick.ts:58` közvetlenül hív
`executeAction`-t, a fájlban nincs `dispatch-gate` import.

**Ez ma latens, nem élő:** a `safeCosDeps()` (`runtime.ts:39`) nem drótoz be
kimenő adaptert, tehát a `tick.ts` ága mindig `continue`-val kihagyja. De a
védelem nem a dokumentált mechanizmus, hanem egy hiányzó adapter.

## P1 — a jóváhagyási boríték nagy része nincs kikényszerítve

Az `ApprovalEnvelope` (`approval-core.ts:37-63`) 22 mezőt ígér: kinek, milyen
csatornán, hányszor, meddig, milyen összeghatárig, mi állítja le. Az
`authorizeSend` ebből négyet kényszerít ki. A többi vagy olyan lekérdezési
mező mögött van, amit senki nem ad át, vagy egyáltalán nincs olvasva.

A `dispatch-gate.ts:78-81` nem adja át a `channel`, `outboundKind` és
`usedVariables` mezőket — pont az a három, ami a csatorna-, darabszám- és
változó-korlátokat feloldaná. Kilenc további oszlop íródik és nincs olvasva.

Gyakorlati következmény: ha egy kampányt "legfeljebb egy utánkövetés"
kikötéssel hagysz jóvá, az oszlop beíródik, az API sikert jelent, és a korlát
nem létezik.

*(Ez a rész az ügynök jelentéséből van, a `dispatch-gate.ts:78-81` hívást
ellenőriztem, a 22 mező végigkövetését nem.)*

## P1 — a "megváltozott a piszkozat" védelem néma minden valódi kattintásnál

A jóváhagyó végpont összeveti a látott szöveg ujjlenyomatát a tárolttal — de
csak ha a hívó elküldi. A dashboard **nem küldi el**:

```
web/coscontrol.js:577
  body: JSON.stringify(yes ? { ledgerId: ledger } : { ledgerId: ledger, reason: ... })
```

Verifikálva: `grep -rn "renderedPayloadHash" web/` nem ad találatot. A hiányzó
paraméter egyetértésnek számít. Én magam írtam tegnap a kódba, hogy ez aktív
védelem.

## P2 — kilenc komment azt állítja, hogy öt CostOps-modul nincs bekötve

`alerts.ts`, `fx.ts`, `optimization.ts`, `invoice.ts`, `forecast.ts` —
mindegyik fejléce és séma-definíciója azt mondja, *"not mounted anywhere"*,
illetve *"NOT called from db.ts or src/costops/schema.ts"*.

Verifikálva: a `schema.ts:116-130` mind az ötöt meghívja, a `db.ts:828` pedig a
`schema.ts`-t. A táblák élnek és minden bootnál létrejönnek.

Ehhez tartozik egy **felhasználó felé látszó** hiba: az `inventory.ts:16-19`
kommentje szerint egyetlen collector sem fut automatikus intervallumon, és a
`:219` ezért soha nem ad `automatic_interval` értéket. A
`reliability-observation.ts:132-140` viszont bootkor és 15 percenként futtatja
őket. A dashboard tehát minden automatikusan szinkronizált szolgáltatót
kézinek mutat, és a hazug komment a rossz kimenet indoklása.

## P2 — halott oszlop, ami csapda a következő fejlesztőnek

Az `outbound_ledger` tartalmaz `rfc_message_id` és `provider_message_id`
oszlopot. Verifikálva: az egyetlen nem-séma hivatkozás egy teszt, ami azt
állítja, hogy az oszlopok LÉTEZNEK. Se író, se olvasó.

Ez pont a ma reggeli szálazási kártya (`169fca9b`) hátralévő fele: aki
befejezi, látni fogja az oszlopot, azt hiszi, a szülő azonosító már el van
mentve, és `NULL`-t fog kapni minden sorra. Ugyanaz a hiba visszatérne, egy
oszlopon keresztül, ami ígéretnek olvasódik.

## P2 — két rés a tegnap esti saját munkámban

`allowedRecipients`: a kód csak azt kényszeríti ki, hogy a lista TARTALMAZZA a
címzettet, tehát egy bővebb lista is átmegy, és a bővebb lista tárolódik el
jóváhagyásként. A közvetlenül fölötte lévő komment azt mondja, hogy egy IGEN
nem lehet állandó engedély. A kód ezt nem tartja be.

`completionActor`: alapból nyitott. Ami nem pontosan a `'progression-engine'`
sztring, az tulajdonosnak számít, és a tulajdonos előtt a DoD-kapu azonnal
kinyílik. Ma latens (mindhárom hívó a motor), de a helyes forma a fordítottja:
tulajdonos-allowlist, minden más motor.

---

## Amit az ügynökök tisztának találtak

Nem minden lett piros, és ez is információ. Ellenőrizve és rendben:
`output-floor` (a padlók tudnak pirosat adni, és a hibás lekérdezés riaszt, nem
átenged), `attachments.verifyAttachment` (újraszámolt sha256, a törölt és a
sérült eset elkülönül), `autonomy-ladder` engedély-oldala (fizetés és
approved-on-túli megosztás a fokozat olvasása ELŐTT elutasítva), a ma éjjel
javított DoD-kapu maga, és kilenc olyan komment, ami igaznak bizonyult.

## Módszer

Négy `Explore` ügynök, párhuzamosan, azonos szabályokkal. A jelentéseikből a
P0/P1 állításokat és a P2-k felét magam futtattam újra: grep-ek a `src/`,
`scripts/`, `web/` és `~/.claude/scheduled-tasks/` fákon, tesztek és a két
elfogadási kapu kizárva, plusz közvetlen SQLite lekérdezések az élő
`store/claudeclaw.db`-ből. Ahol nem verifikáltam, ott a szakasz végén ki van
írva.
