# COS bejövő email-út: spec vs. megépült rendszer

**Dátum:** 2026-08-09 | **Ág:** `develop` HEAD `396b673` | **Kiváltó ok:** a GLS futár-visszaigazolás és a cloud-kredit levelek nem jelentek meg a Mission Controlon
**Kérdés amire válaszol:** "Az eredeti CoS specifikációban ezek a hibák benne voltak? Mindent lekövettünk abból?"

**Módszer:** minden állítás az élő DB-n, a kódon vagy a futásnaplón mérve. Negatív állítás (`nincs ilyen`) csak pozitív kontrollal.

---

## 0. Rövid válasz

**Nem, a spec nem tartalmazta ezeket a hibákat.** Mindkettőt lefedte, névvel:

| Ma talált hiba | A spec mit írt elő | Hol |
|---|---|---|
| A szűrő a feladó technikai címe alapján dobott | A szűrő NINCS a specben. `email-triage-fetch.py` a COS előtt született (2026-07-18 heartbeat), és utólag lett a COS betápláló szerve, spec nélkül | — |
| Az ügyek nem kapcsolódtak szálhoz | `§8`: `... -> teljes thread + Scope Gate + delta + **case-match** -> LOCAL_APPLIED`; `§6.3` és `§A.3 [P0.3]`: `UNIQUE(gmail_account_id, **thread_id**, message_id)` | v4.2 §8, §6.3; v4.2.1 §A.3 |

**"Mindent lekövettünk abból" — nem.** Az eltérés dokumentált: `docs/cos-spec-implementation-verification-2026-08-06.md` §4/2. pontja rögzíti, hogy a §8 delta-modellje helyett a triage HTTP-seam a driver, és hozzáteszi: *"Szándékos"*, majd a doksi zárása: *"Egyik sem korrektségi rés."* **Ez a minősítés téves volt.** A mai hiba ennek a következménye.

---

## 1. Mit ejtett el a triage-seam a spec §8-hoz képest

`§8`: `DISCOVERED -> CLAIMED (atomikus) -> teljes thread + Scope Gate + delta + case-match -> LOCAL_APPLIED -> SOURCE_COMMITTED`

| §8 lépés | Megépült? | Bizonyíték |
|---|---|---|
| teljes thread olvasás | **NEM** | `grep` a `src/cos/*.ts` + intake route felett: nulla thread-olvasás. Pozitív kontroll: `src/cos/adapters/gmail-api-transport.ts` megvan, tehát a keresés működik. Az intake 300 karakteres snippetet kap |
| Scope Gate | **HELYETTESÍTVE** | `src/web/routes/cos.ts:70` — `accountId` szerinti routing (connector identity = scope határ). Tartalmi kapu nincs |
| delta (`history.list`) | **NEM** | `email_source_checkpoints` tábla **ÜRES** (0 sor) |
| case-match | **CSAK SZÁLON**, és az sem működött | `intake.ts:63` `findActiveCaseByThread` csak `gmail_thread_ids`-re illeszt; a betápláló soha nem adta át a `threadId`-t → **17/18** `email_processing` sor `thread_id` NULL |
| `LOCAL_APPLIED` | igen | 18/18 sor eljut ide |
| `SOURCE_COMMITTED` | **SOHA** | `select status,count(*) from email_processing` → `LOCAL_APPLIED: 18`. Más állapot nincs |
| batch terminális + cursor | **SOHA** | `email_processing_batches`: **18/18 `OPEN`**. Egy batch sem záródott le |

### 1.1 Megépült, tesztelt, de éles hívó nélkül

```
sourceCommit          -> hívók: CSAK tesztek (cos-email-ingest, cos-gmail-history-guard)
tryAdvanceCheckpoint  -> hívók: CSAK tesztek
openBatch             -> hívó: src/cos/triage-bridge.ts:57   <-- POZITÍV KONTROLL
```

A §8 második fele (label, source-commit, batch-lezárás, cursor) le van kódolva és tesztelve, de a produkciós út soha nem hívja meg. Ez a `built-but-never-invoked` osztály.

### 1.2 Séma-eltérések a spectől

| Spec | Megépült |
|---|---|
| `UNIQUE(gmail_account_id, thread_id, message_id)` | `UNIQUE(gmail_account_id, message_id)` — a `thread_id` kimaradt a kulcsból, és nullable |
| batch státuszok: `OPEN, PROCESSING, READY_TO_COMMIT, COMMITTED, RECOVERY_REQUIRED, BLOCKED` | `OPEN, PROCESSING, TERMINAL, QUARANTINED` |
| `email_source_checkpoints`: `committed_history_id, discovered_history_id, active_batch_id` | egyetlen `history_cursor` |

---

## 2. Elfogadási kritériumok (§23): melyik teljesül, és melyik csak ÜRESEN igaz

| # | Kritérium | Valós állapot |
|---|---|---|
| 10 | `LOCAL_APPLIED` egyszer; label/cursor külön pótolható | **FELE.** A `LOCAL_APPLIED` működik. A label/cursor fele soha nem fut |
| 11 | Cursor csak akkor lép, ha minden batch-elem terminális | **ÜRESEN IGAZ.** A cursor soha nem lép, mert nem létezik |
| 12 | Cursor-visszaállás / kézi label-eltávolítás nem okoz újra-write-ot | **NEM ÉRTELMEZHETŐ** élesben: nincs cursor és nincs label |
| 13 | Atomikus claim | `case_claims`: **0 sor**. A gépezet megvan és tesztelt, az éles út nem használja |
| 17 | ZST/céges tartalom nem kerül a personal store-ba | **MA MEGSÉRÜLT.** Két ZST-üzletrész ügy a `personal_cases`-ben (`case-private-19fe78e382f4c02c`, `case-private-19fe75b3420a5b29`), mert privát postafiókból jöttek. Ez a **hozott döntés** (connector identity = scope határ) és az **AC ütközése** -> Istvan döntése, nem hiba amit magamtól felülírok |

---

## 3. Miért nem fogta meg egyik teszt sem

- **362 COS teszt zöld** (12 további `jsdom`-hiány miatt nem futott a worktree-ben — környezeti, nem valós bukás).
- A tesztek a modulokat izoláltan hajtják, és a `threadId`-t **kézzel adják be**: `cos-intake.test.ts:16` explicit `threadId` paraméterrel nyit batch-et.
- **Nincs teszt, amely a valódi láncot hajtaná végig** (betápláló -> HTTP route -> intake). Így pontosan az az egy dimenzió maradt fedetlen, amelyik élesben törött volt: hogy a betápláló egyáltalán ad-e szálazonosítót.
- A fixture ingyen adta azt, amit a produkció nem. A tesztek zöldek maradnak akkor is, ha az éles út a §8 felénél megáll.

---

## 4. Mennyire élt egyáltalán ez a rendszer

- `personal_cases`: **61** ügy — ebből `chatgpt-cos-drive` **42**, `gmail` **18**, `telegram` **1**.
- A mai 13 ügy előtt az email-intake **4 nap alatt 5 ügyet** hozott létre. A "levélfigyelés" gyakorlatilag nem termelt.
- `zst_cases`: 34 ügy, ebből **25 hordoz szálazonosítót** — a ZST-oldal saját Gmail-úton olvas, ezért ott a szál-kapcsolás működött. A hiány a személyes ágra volt jellemző.

### 4.1 Külön ok: a heartbeat csendben kiesik

`~/.claude/scheduled-tasks/email-triage/task-config.json`: `"schedule": "0 */3 * * *"`, `"skipIfBusy": true`.

`src/web/schedule-runner.ts:1330` — ha a session foglalt: *"Schedule busy, skipIfBusy=true: dropping tick silently"*. Nincs retry-sor, nincs riasztás.

A futásnaplóban **6 email-triage tick esett ki** így (09:00, 18:00, 21:00, két napon). A kód kommentje szerint *"egy kimaradt tick ártalmatlan, mert a következő már úton van"* — ez egy 30 perces heartbeatre igaz, egy **3 órásra nem**, és ez az egyetlen út a Case Store-ba. Ez az oka, hogy a délután érkezett Google-levél nem került be.

---

## 5. Verdikt

A specifikáció rendben volt. A korrektségi felület (P0/P1/P2) tényleg megépült és tesztelt. **A hiba az, hogy a spec §8 pipeline-ját egy másik, sosem speccelt betápláló szervre cseréltük, ezt "szándékos architekturális választásnak" minősítettük, és a 2026-08-06-i verifikáció "nem korrektségi rés"-nek zárta.** A csere három dolgot ejtett el — teljes thread, szálazonosítás, case-match —, és a rendszer emiatt nem az volt, aminek látszott: egy zöld tesztfelület fölött egy félig futó éles út.

**Visszavonom** a `cos-spec-implementation-verification-2026-08-06.md` 78. sorának "Egyik sem korrektségi rés" állítását.

---

## 6. Következő lépések (Istvan döntése)

1. **Kicsi, most:** a `thread_id` felvétele az `email_processing` UNIQUE kulcsába, és a meglévő 17 NULL sor visszatöltése. (A betáplálás már ad szálazonosítót, 396b673.)
2. **Közepes:** a §8 második fele bekötése az éles útba (`sourceCommit` + `tryAdvanceCheckpoint` hívása), hogy a batch lezáruljon és a cursor létezzen — vagy explicit döntés, hogy ezt NEM kötjük be, és akkor a spec §8 + AC 10/11/12 hivatalosan törlődik, nem "teljesítettnek" számít.
3. **Kicsi:** `skipIfBusy: false` az email-triage-re (3 órás kadencia mellett a csendes eldobás nem arányos), vagy a kiesés riasztása.
4. **Döntés:** AC #17 vs. a connector-identity scope szabály. Melyik az igazság, ha céges tartalom privát postafiókból érkezik?
5. **Nyitva marad:** szálon túlmutató, entitás-alapú case-match (kártya `4c6695d9`) — ez a specben sem szerepelt.
