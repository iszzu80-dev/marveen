# Progression v1.3.1 — a hiányzó szakaszok, és az éles frissítés menete

**Ág:** `claude/progression-v131-fixes-qe1z7m` (a `claude/cos-review-fixes-qe1z7m` @ `d217745` tetejéről)
**Forrás:** `audits/progression-v1.3.1-szakaszonkenti-allapot-2026-08-12.md`
**Spec:** `docs/marveen-autonomous-case-progression-spec-v1.3.1.md`

---

## 🔴 0/a. A §21 Delegation Envelope — amit MUSZÁJ elolvasnod frissítés előtt

**Ez az egyetlen változás a csomagban, ami után Marveen a nevedben küld levelet
anélkül, hogy megkérdezne.** Minden más csak mér, ír vagy megjelenít.

A hét válaszod alapján ez lépett életbe:

| | Személyes (PRI) | Céges (ZST) |
|---|---|---|
| szándékok | factual_reply, clarification, **quote_request**, routine_followup, scheduling | factual_reply, clarification, routine_followup |
| új szálat indíthat | igen — de **nem** árajánlatkéréssel | **nem, semmivel** |
| címzett | **bárki** ⚠️ | **csak** `relacio@t-online.hu` |
| pénzügyi keret | 0 Ft | 0 Ft |
| napi keret | 10 levél | 5 levél |

### ⚠️ Amit külön nézz meg: a személyes oldalon nincs címzett-lista

Az 5. kérdésre a könyvelőt adtad meg, és a kérdés a **céges** listáról szólt. A
személyes envelope ezért **bármely címzettnek** engedi a fenti szándékokat.
Ez a csomag legnagyobb hatósugarú sora.

Ha ez nem így volt szánva, egy sor:

```ts
// src/cos/delegation-envelope.ts — PERSONAL_EMAIL_ENVELOPE
recipientAllowlist: ['ugyved@…', 'relacio@t-online.hu'],   // null helyett
```

### Ami NEM változott

Az envelope **kizárólag a jóváhagyást** váltja ki. A connector-ellenőrzés, az
érzékenységi szabály és a §22 autonómia-fokozat változatlanul ÉS-elve fut, és az
envelope csak utánuk kerül sorra. Ha a fokozat nem enged küldést, a delegálás
nem segít rajta — ez teszttel rögzítve.

### Kikapcsolás, ha baj van

```ts
revokeEnvelope(db, 'pri-email-v1', 'miért', now)   // azonnal, deploy nélkül
restoreEnvelope(db, 'pri-email-v1', 'istvan', now) // vissza, csak kézzel
```

A „rossz küldés" ágat magától is észreveszi: ha egy delegálás alatt küldött
levél `FAILED_TERMINAL` / `OUTCOME_UNKNOWN` / `RECOVERY_REQUIRED` állapotban
végzi, a következő delegált küldés **elutasításra kerül**, amíg vissza nem
kapcsolod. Ez nem időzítőn jár le — egy magától visszatérő delegálás nem volt
igazán visszavonva.

### Az első hét ellenőrzése

```sql
SELECT a.delegation_envelope_id, a.intent, COUNT(*)
  FROM action_authorizations a
 WHERE a.delegation_envelope_id IS NOT NULL
 GROUP BY 1, 2;
```

Ez a lista **pontosan az**, amit Marveen megkérdezés nélkül küldött. Ha üres, a
delegálás egyszer sem talált el semmit — az sem hiba, az osztályozó szándékosan
csak biztos találatra mond igent.

---

## ⚠️ 0. Amit az éles frissítésnél meg kell csinálni

**Séma-migráció NINCS.** Egyetlen oszlop sem került be, egyetlen `CHECK` sem
változott. A `personal_case_events` / `zst_case_events` tábláknak nincs
`event_type` megszorításuk, tehát az új eseménytípusok írásához semmit nem kell
átalakítani, és a `semantic_completion_status` oszlop `VERIFIED` értéke már eddig
is engedélyezett volt — csak nem írta senki.

Amit **meg kell** csinálni, sorrendben:

### 0.1 A dashboard statikus fájlját frissíteni kell

`web/coscontrol.js` változott (`COMPLETION_LABEL`, `COMPLETION_COLOR`). Ha a
böngésző a régi verziót cache-eli, a lezárt ügyek továbbra is a nyers enum-nevet
mutatják. **Hard refresh** (Ctrl+Shift+R), vagy a statikus fájl verziózása.

### 0.2 Az első ciklus után ellenőrizni, hogy nem indult-e eseményáradat

A §8 miatt a progression mostantól ír a case eseménytörténetébe. A védelem be van
építve (esemény csak akkor, ha a tény **megváltozott**), és teszt méri, de a
meglévő 100+ ügy első ciklusa **egyszeri** tömeges írás lesz: minden ügy megkapja
a `GOAL_DEFINED` / `PLAN_CREATED` sorát.

Nagyságrend: ügyenként 1–3 sor, egyszer. Az első ciklus után ellenőrizhető:

```sql
SELECT source_system, event_type, COUNT(*)
  FROM personal_case_events WHERE source_system = 'progression'
 GROUP BY 1, 2 ORDER BY 3 DESC;
```

Ha bármelyik típus **ügyszámnál nagyobb** darabszámon áll, az hiba — jelezni kell.

### 0.3 A `semantic_completion_status` visszamenőleg NEM javul magától

A `VERIFIED` értéket a következő ciklus írja rá arra az ügyre, amelyiket
ténylegesen megnéz. A már lezárt, `progression_enabled = 0` ügyek **`PROPOSED`
állapotban maradnak**, mert a motor nem futtat rájuk több ciklust — és ez így
helyes: a 2026-08-09-i 72 hamis lezárás **nem** volt bizonyított, tehát nem is
kaphat `VERIFIED` címkét visszamenőleg.

Amit ez jelent a dashboardon: a régi lezárt ügyek **borostyánsárgán**
("Lezárásra javasolt") fognak látszani. Ez nem hiba, hanem az első alkalom, hogy
a rendszer őszintén megmutatja, mennyi lezárás nem volt igazolva.

### 0.4 Az új végpont

`GET /api/cos/progression/quality[?domain=personal|zst]` — a §4.2 mérőszámok.
Nincs authentikációs változás, ugyanazon a felületen ül, mint
`/api/cos/progression`.

**Az első lekérdezés az éles adaton a lényeg.** Ha a `distinct_value_ratio`
50% alatt van, a `goal-enrichment` még nem futott végig az ügyeken — nem a mérés
hibás.

---

## 1. Ami elkészült

| § | Mi hiányzott | Mi lett belőle |
|---|---|---|
| **16** | 7 hard safety assertion futott minden cikluson; **5 közülük nem tudott megszólalni** — `run.error_code`-ot néztek egy olyan objektumon, ahol az `error_code` három sorral feljebb `null`-ra van drótozva | Az assertionök megkapják a valódi állapotot (`AssertionContext`), és a ledger + authorization sorokat olvassák |
| **8** | A spec 17 eseménytípusából **16-nak nem volt írója**. „Mit csinált a motor?" megválaszolható volt, „mi történt az üggyel?" nem | `progression-events.ts` — 8 típus, változásonként egy esemény, és nem tudja magát ütemezni |
| **25** | A `semantic_completion_status` `CHECK`-je négy értéket enged; a pipeline kettőt írt. **A `VERIFIED`-nek sehol nem volt írója** | A run végén dől el, ott ahol a döntés végleges, a DoD-bizonyíték megvan, és az ügy még progression-vezérelt |
| **20** | A kérdés a hét kötelező elemből **hármat** vitt | `decision-package.ts` — mind a hét, determinisztikusan, forrás nélküli elem **kimarad**, nem lesz kitalálva |
| **4.2** | Egyik mérőszám sem létezett | `progression-quality.ts` — mind a hat, leírt definícióval, végponttal |

---

## 2. Ami a két rendszer HATÁRÁN romlott el, és amit külön kellett javítani

Ez a rész azért van külön, mert **egyik alrendszer sem volt hibás önmagában.**
A négyből három csak akkor látszik, ha a COS-t és a progressiont együtt nézi az
ember — és kettőt közülük **ugyanaznap, saját kézzel okoztam**.

### K-1 — a Reader a motor saját narrációját olvasta

A §8 helyes: a case történetének el kell mondania, hogy terv készült. A
`context-builder` viszont a **legfrissebb húsz eseményt** szűrés nélkül teszi be
a Reader promptjába, a progression pedig minden run végén ír.

**Mérve** (3 valódi esemény, 6 ciklus): a tizenkét kontextus-elemből **kilenc**
a motor volt, ahogy magáról beszél.

Két kár, és a második a súlyosabb:

- **Kiszorítás.** A húsz egy keret. A motor eseményei kitolják belőle a
  leveleket, a tulajdonosi válaszokat, a státuszváltásokat.
- **Önmegerősítés.** A Readert arról kérdezzük, hogy mit mond az ügy és kinél
  van a labda. Ha „Terv készült az ügyhöz" `UNTRUSTED_SOURCE_DATA` címkével
  kerül elé, akkor a motor tevékenységét fogja az ügy tényeként jelenteni — és
  annál magabiztosabban, minél többször futott a motor. Ez a §4.2 generikus-
  mondat hibája, új ajtón át.

### K-2 — a §20 újranyitotta azt az ajtót, amit a cooldown becsukott

A Decision Package első verziója **beletette a javaslatot a kérdés hash-ébe.**
A megváltozott hash `replacesOwn`-t csinál, ami szándékosan **felmenti** a
kérdést a hatórás cooldown és a mennyiségi plafon alól — csakhogy ez a felmentés
egy homályos kérdés **újrafogalmazására** készült, nem javaslat-áradatra. A next
best action pedig minden státuszváltáskor újratervezik.

**Mérve: egy ügy harminc perc alatt NÉGY kérdést küldött**, változatlan olvasat
mellett. Pontosan az a 2026-08-11-i hiba, ami miatt az `ASK_COOLDOWN_SEC`
egyáltalán létezik.

A hash visszakerült arra, ami volt: a **kérdés** azonossága. A megváltozott
javaslat helyben frissíti a nyitott kérdés tárolt szövegét, új értesítés nélkül.

### K-3 — a céges névtérnek saját ledgere van

`zst_outbound_ledger` valódi és aktívan íródik (`zst-send.ts`). A §16
assertionök és a §20 „mit intézett" **csak az `outbound_ledger`-t** kérdezték —
tehát a hét assertionből öt **vak volt az egész céges névtérre**: nincs
policy-bypass ellenőrzés, nincs wrong-recipient, nincs duplikátum-ellenőrzés
pont azon az oldalon, ami a cég nevében küld.

Ez **ugyanaz a hiba, amit a 2026-08-12-i review T-1-ként nevezett meg** — a
javítás, ami egy névtérre válaszol és nem néz vissza a másikra. Órákkal a mondat
leírása után követtem el. Ezért van rá standing check, nem pedig fogadalom.

### K-4 — a dashboard sosem tudta felcímkézni a valódi szótárat

A `COMPLETION_LABEL` a `COMPLETED` / `BLOCKED` / `STALLED` értékeket sorolta —
**mindhármat tiltja az oszlop `CHECK`-je**, tehát meg sem jelenhettek —, a
`PROPOSED`-ot és a `VERIFIED`-et pedig kihagyta. Minden lezárt ügy a nyers
enum-nevét mutatta szürkén. Régi hiba; addig volt láthatatlan, amíg a
`VERIFIED`-nek nem volt írója.

---

## 3. Amit tudatosan NEM csináltam meg

| § | Miért nem |
|---|---|
| **13.1** — az arbitráció kimenete hasson a döntésre | Előbb látni kell, mennyire jók a javaslatok. A §4.2 mérőszámok most készültek el; **ezek adják a bizonyítékot**, és addig ez a lépés megalapozatlan lenne |
| **21** — Delegation Envelope | **Elkészült** — a hét tulajdonosi döntés megérkezett 2026-08-12-én, lásd a 0/a szakaszt. Ami továbbra sem készült el: a céges **vendor**-lista (Istvan a könyvelőt nevezte meg, szállítót nem), és az `approval_source` mező a §23 tizenkettőből |
| **4.2 küszöbértékek** | A spec megnevezi a mérőszámokat, a számokat nem. A `QUALITY_THRESHOLDS` az én becslésem, **semmit nem blokkol**, és a kódban ki van írva, hogy ítélet |
| **§8 további 9 eseménytípus** | `ACTION_PROPOSED` / `ACTION_VERIFIED` az executoré, `INFORMATION_RESOLVED` a resolveré. Ha itt írnám meg őket, **más komponens szájába adnék szavakat** |

---

## 4. Tesztek

| Fájl | Db | Mit mér |
|---|---|---|
| `progression-v131-events-and-assertions.test.ts` | 36 | §16 assertionök viselkedése (megszólal / hallgat), §8 eseménytörténet, a K-1 határ, mindkét névtér |
| `cos-decision-package.test.ts` | 23 | a §20 hét eleme, a kitalálás tilalma, a K-2 regresszió |
| `cos-progression-quality.test.ts` | 20 | a §4.2 hat mérőszám **definíciója** — nem a mai számok |

**Red-proof:** a javítások kikapcsolásával 6 teszt pirosra vált.

**Teljes futás:** 5991 sikeres, 4 bukó — ugyanaz a négy, ami a `develop`-on is
bukik (három `chmod 0500` negatív teszt, amit root felhasználóként nem lehet
reprodukálni, és egy schedule-runner).
