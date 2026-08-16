# Marveen Personal Chief of Staff v4.3

## A MEGÉPÍTETT rendszer specifikációja

**Célrendszer:** Marveen Personal & Household Operating System
**Elsődleges felhasználó:** Istvan
**Időzóna:** Europe/Budapest
**Repo:** `iszzu80-dev/marveen-private`, ág: `develop` (a `Szotasz/marveen` az upstream, oda nem tolunk)
**Verzió:** 4.3
**Dátum:** 2026-08-16
**Előző baseline:** `marveen-personal-chief-of-staff-v4.1.md` (teljes, §-számozott) + `v4.2.md` (freeze-candidate korrekciók) + `v4.2.1.md` (patch)
**Szerző:** Marveen

---

## Miért van ez a verzió, és mi a viszonya a v4.1/v4.2-höz

A v4.1–v4.2.1 **2026-08-04-én** készült, a megépítés előtt. Azóta 2026-08-16-ig
**259 commit** érintette a COS-t, tizenkét nap alatt, és a rendszer élesben fut:
82 személyes ügy, 42 céges ügy, 109 tárolt dokumentum, napi ciklus tíz percenként.

A v4.1 **szándék-specifikáció** volt. Ez a v4.3 **állapot-specifikáció**: azt írja
le, ami VAN, és külön megnevezi, ami csak papíron van.

**Ezért minden állítás mellett ott a bizonyíték fajtája:**

| jelölés | jelentése |
|---|---|
| **[ÉLŐ]** | fut a valódi store-on, és ma megmértem |
| **[MEGÉPÍTVE]** | kód + teszt van rá, de nincs friss élő mérésem |
| **[PAPÍR]** | a v4.1/v4.2 leírja, a kód nem tartalmazza |
| **[VISSZAVONVA]** | a v4.1/v4.2 leírta, és szándékosan másképp lett |

**És egy ötödik állapot, amit a négy jelölés NEM tud kifejezni: „megépült, és
semmi nem fogyasztja a kimenetét."** A `parent_case_id` fél éven át pontosan
`[MEGÉPÍTVE]`-nek látszott volna — volt sémája, voltak tesztjei, és 0/79 sora.

Ezért a jelölés önmagában nem elég, és **a következő szabály minden `[ÉLŐ]` és
`[MEGÉPÍTVE]` állításra kötelező:**

> **Nevezd meg a FOGYASZTÓT — vagy mondd ki, hogy nincs.**

Mert az a kérdés, ami mind a kilenc leletet megtalálta (§19), nem az volt, hogy
„megvan-e", hanem hogy **„ki olvassa?"**. (A szabályt a PR #18 társ-ágense
javasolta, miután a jelen dokumentum §9.1-én bemutatta, hogy enélkül átcsúszik
egy fogyasztó nélküli fél.)

Ez a megkülönböztetés nem formaság. A 2026-08-04 és 08-16 közötti munka
visszatérő lelete pontosan az volt, hogy **egy fogalom megépült, a fogyasztója
nem, és semmi nem jelezte a különbséget** — nyolc ilyen esetet találtunk egyetlen
napon (§19). Egy specifikáció, ami nem különbözteti meg a szándékot a
működéstől, ennek a hibának a papír alapú változata.

---

# 1. Amit a rendszer ma csinál (egy bekezdésben)

Marveen beolvassa Istvan két postaládáját (privát + ZST), a levelekből ügyeket
nyit, az ügyeket egy állapotgépen viszi előre, kérdez, ha nem tud dönteni,
megfogalmazza a válaszleveleket, de **elküldeni csak jóváhagyással** küld,
figyeli a határidőket, tárolja a mellékleteket, árakat figyel a radaron, és
mindezt naponta és tíz percenként lefutó determinisztikus ciklusokban teszi.
A kérdései egy **külön Telegram-csatornán** mennek ki, és a válasz visszaér az
ügyhöz.

---

# 2. Névterek és a köztük lévő fal

**[ÉLŐ]** Két, egymást soha nem érintő névtér:

| | személyes | céges |
|---|---|---|
| ügy-tábla | `personal_cases` (82 sor) | `zst_cases` (42 sor) |
| esemény | `personal_case_events` | `zst_case_events` |
| forrás | iszzu80@gmail.com | istvan.szabo@zstradio.com |
| típuskészlet | HOME_REPAIR, QUOTE, ADMIN, TRAVEL, FINANCE, CALL, EMAIL, … | ACCOUNTING, INVOICE_*, CONTRACT, VENDOR, REGULATORY_DEADLINE, … |

A határ nem konvenció, hanem **konnektor-identitás**: az `/api/cos/intake`
`accountId` mezője dönt, és a két store külön motor-példányt kap ugyanabból a
`makeCaseEngine`-ből. Egy személyes ügy soha nem lehet egy céges ügy szülője,
mert a parancsok a saját tábláikhoz vannak kötve.

**Új a v4.1-hez képest:** a v4.1 egyetlen ügy-táblát írt le. A céges névtér
(Slice 1, 2026-08-06) azóta épült meg.

---

# 3. Az ügy életciklusa

**[ÉLŐ]** Státuszok (`schema.ts`, egyetlen forrás, a CHECK constraint is innen jön):

```
NEW  TRIAGE  INFO_REQUIRED  READY  PLANNING  AWAITING_APPROVAL  EXECUTING
WAITING_EXTERNAL  FOLLOW_UP_DUE  CALL_REQUIRED  AWAITING_SELECTION  SCHEDULED
BLOCKED  RECOVERY_REQUIRED  COMPLETED  CANCELLED  ARCHIVED
```

Terminális: `COMPLETED`, `CANCELLED`, `ARCHIVED`. Figyelmet igénylő (a Today
nézet külön hozza): `INFO_REQUIRED`, `FOLLOW_UP_DUE`, `CALL_REQUIRED`,
`AWAITING_SELECTION`, `RECOVERY_REQUIRED`.

## 3.1 Optimista konkurencia

**[ÉLŐ]** Minden állapotváltás `seenVersion`-t követel, és ütközésnél
`CaseConcurrencyError`-t dob — soha nem ír felül csendben. (v4.2 P0.5, megépítve.)

## 3.2 Az esemény az igazság, nem a sor

**[ÉLŐ]** Minden írás eseményt hagy: `CREATED`, `STATUS_CHANGED`, `PLAN_CREATED`,
`PARENT_LINKED`, `CALENDAR_EVENTS_LINKED`, `EVIDENCE_RECEIVED`, … Az
esemény-táblán append-only trigger van, amit **minden induláskor újraírunk**, nem
`IF NOT EXISTS`-szel (2026-08-09: az `IF NOT EXISTS` egy elrontott triggert
örökre a helyén hagyott volna).

---

# 4. Bejövő út: levéltől az ügyig

**[ÉLŐ]** A lánc: `email-triage-fetch.py` (read-only Gmail, determinisztikus
zajszűrés) → ítélet (LLM, de csak besorolás) → `POST /api/cos/intake` → Case Store.

Négy döntés, ami eltér a v4.1-től:

**4.1 [VISSZAVONVA] Nincs natív `history.list` delta-poller.** A v4.1 §8 azt írta
le. Helyette a triage-seam hajtja a beolvasást. Szándékos: a COS nem duplikálja a
Gmail-olvasást, és a triage amúgy is fut. (Rögzítve: `cos-spec-implementation-verification-2026-08-06.md`.)

**4.2 [ÉLŐ] Fiók-szintű kurzor, nem üzenetenkénti** (v4.2 P0.2). A kurzor
mozgatása a köteg lezárásához kötött (`source-commit.ts`), és egy kihagyott
commit ezt KIMONDJA, nem csendben hagyja ki.

**4.3 [ÉLŐ] Méreg-karantén.** Egy levél kihagyása tanúkat követel
(`poison-quarantine.ts`, A.1): a némán kihagyott levél és a „nem volt levél"
megkülönböztethetetlen lenne.

**4.4 [ÉLŐ] Scope Gate.** A tartalom dönt a hatókörről, a postaláda csak tanácsot
ad (`scope-gate.ts`, §2). A verdikt perzisztálva van, nem újraszámolt.

---

# 5. Kimenő út: a levél, amit nem küldünk el magunktól

**[ÉLŐ]** `outbound_ledger` + `executor` + jóváhagyási kapu. A megépített
garanciák, mind mérve:

- **idempotencia-kulcs** a §7.1 szerinti kulcs, nem sorszám (F-1)
- **kereshető külső idempotencia-jel** a levélben, hogy a readback bizonyítható legyen (v4.2 P0.3)
- **fenced claim**, hogy két futás ne küldje ugyanazt (F-4, §6.6/A.2)
- **első küldés kiértékelt döntést követel** — a tick maga nem hozhat ilyet (F-7)
- **a transzport előtti hiba LOKÁLIS**, nem „ismeretlen" (F-3)
- **RECOVERY_REQUIRED-et soha nem küldünk újra automatikusan** — ember oldja fel
- **a válasz szálba fűződik** (a builder korábban minden fejlécet eldobott, 2026-08-10)

**5.1 [ÉLŐ] A PLANNED sor naponta megszólal.** 2026-08-15-ös lelet: egy valódi
levél két napja állt jóváhagyásra várva, és semmi nem tolta Istvan elé. Azóta
napi kivonat van rá, és **a nulla esetet is kimondja**. (Ma is áll benne egy
levél: az AIMS-nek szóló emlékeztető.)

**5.2 [ÉLŐ] Céges kimenő ajtó** ugyanazzal a jóváhagyó maggal (F-9), és a
2026-08-15-i három védelem (compose-kapu, mód-kapu, engedély-jegy) **átér a
vállalati útra is**.

---

# 6. A kérdés, amit Istvannak teszünk fel

Ez a v4.1 óta a legtöbbet változott alrendszer, mert itt a hiba **közvetlenül
Istvan idejébe kerül**.

## 6.1 Saját csatorna **[ÉLŐ]**

A kérdések nem a fő Telegram-csatornán mennek ki, hanem a CoS saját botján
(`telegram:cos`), és a válasz visszaér az ügyhöz (`cos-channel-poll.ts`).
A kérdés megjegyzi, MELYIK csatornán ment ki.

## 6.2 A válasz-út szabályai **[ÉLŐ]**

- a válasz **a csatornára** párosodik, nem a konkrét üzenetre
- a válasz megnevezi, mire felel — különben a motor eldobja és újra kérdez
- **egy visszakérdezés NEM válasz** (fail-closed)
- a válasz **felébreszti** az ügyet és **megérinti a sorát**, hogy ne friss válasz mellé régi olvasatból kérdezzünk
- egy ügynek **egy** nyitott kérdése van; az újrafogalmazás lecseréli a régit
- globális plafon a nyitott kérdésekre, és **a csatorna kimondja, ha tele van** — megnevezve, mi foglalja

## 6.3 A kérdés minősége — 2026-08-15/16 **[ÉLŐ]**

Három szabály, mind valódi rossz kérdésből:

1. **Olvasható javaslat vagy semmi.** Ha a javaslat gépi belső szöveg (a tervező
   saját címke-halmazából való), kiesik, és vele az opciók is. Egy „igen" egy
   semmit sem jelentő mondatra rögzített döntés lenne.
   *Első megoldásom regex volt egyetlen látott rossz mondatra; egy ciklussal
   később átcsúszott rajta egy másik. A javítás nem hosszabb szólista, hanem a
   tervező SAJÁT címke-halmaza.*
2. **A lejárt határidő után más a kérdés.** Nem „csináljam?", hanem „megtörtént
   vagy elmaradt?" — és az „elmaradt" nem lezárás, hanem új teendő.
3. **A valódi ismeretlen a törzsbe.** „Amit magamtól nem tudok eldönteni: …",
   nem a lap alján egy „Bizonytalanság" címke alatt. Mérve: 202 tárolt
   beolvasásból ez a sor 168-szor valódi (83%), 34-szer belső jegyzet.

## 6.4 A tulajdonos szavára nincs türelmi ablak **[ÉLŐ]**

2026-08-16, valódi eset: Istvan 00:44:15-kor megválaszolt egy kérdést, és
00:44:52-kor — **37 másodperccel később** — a rendszer ugyanarról az ügyről
kérdezett újra, épp azt a kétértelműséget, amit akkor tisztázott.

Ok: 120 másodperces türelmi ablak a kérdés-összeállításban, gépi versenyhelyzetre
méretezve. **Az érvelés gépi írásokra szól, a tulajdonos válaszára nem.**
Javítva: ha Istvantól jött esemény a beolvasás óta, a kérdés elavult, türelmi
ablak nélkül. A gépi jitter-tűrés megmarad, két pozitív kontrollal.

---

# 7. Progresszió (ACP) — hol a határ

**[ÉLŐ]** A progressziós motor önálló specifikációt kapott:
`marveen-autonomous-case-progression-spec-v1.4-proactive-core.md` (belső verzió
**v1.4.4**, lásd az amendment logot). Ez a dokumentum csak a COS-oldali
csatlakozási pontokat rögzíti:

- `case_progression_state` per (domain, case_id), `progression_enabled` + `progression_mode`
- öt mód: `off | shadow | internal | external_shadow | live` — és a módnak **foga van** (2026-08-15)
- **`progression-migrate` MINDEN nem-terminális ügyet automatikusan beléptet** `enabled=1`-gyel. Csak hiányzó sorra `INSERT`-el, tehát egy szándékosan kikapcsolt sor stabil.
- kill-switch (`§22`): a `pauseAll` megnyomható, és a jóváhagyás ÉLŐ állapota is újraellenőrződik (TOCTOU, §22.2)

---

# 8. Ütemezés és ébresztés

## 8.1 A ciklus **[ÉLŐ]**

`scripts/cos-cycle.ts`, tíz percenként, **tíz lépés**, sorrendben:

```
progression → batches → threads → followups → plannedDigest → radarDigest
→ wakeAlert → deadlineAudit → channel → inbox
```

Egy lépés hibája nem állítja meg a többit; a végén egyetlen JSON `problems`
tömbbel. **A lépéseknek szabálynak kell lenniük, nem ítéletnek**: egy forduló,
ami a tízből hetet futtat le, megkülönböztethetetlen attól, amelyik mindet
lefuttatta és nem talált semmit (§21 záró elve).

## 8.2 Az ébresztő, aminek nem volt fogyasztója **[ÉLŐ, 2026-08-16]**

`next_wake_at` = „gyere vissza ehhez ekkor". Az írója (`setNextWake`) és az
olvasója (`dueCases`) is megvolt, a tick minden ciklusban hívta is az olvasót —
és ezt csinálta:

```ts
dueCases: dueCases(db, now).length
```

Az azonosítók eldobva. **Egy számra nem lehet cselekedni**, tehát soha semmi nem
cselekedett, tehát senki nem töltötte ki az oszlopot: **0 / 61 nyitott ügy.**

Javítva: a tick a sorokat adja vissza, és a `wakeAlert` lépés kiposztolja őket,
majd **törli** az ébresztőt. A törlés kétszeresen indokolt: egy ébresztés
időpont, nem tulajdonság; és ez a dedup — nélküle tíz percenként ismételné magát,
és pontosan így némul el egy valódi jelzés. **Sorrend: előbb posztol, aztán
töröl** (a helyrehozható hibát választjuk a némával szemben).

## 8.3 A prózában élő határidő **[ÉLŐ, 2026-08-16]**

Két autóbérlés ügy `next_action`-jében ez állt: *„DÖNTÉS 2026-08-16 10:00 előtt:
Hertz VAGY Sixt"*. A `due_at` a két nappal későbbi ÁTVÉTELRE mutatott, a
`follow_up_at` tegnapi volt, `next_wake_at` sehol. **Egyetlen dátum-vezérelt
felület sem látta**, a napindító sem. A határidő lejárt, mielőtt bárki szólt
volna.

`deadline-audit.ts`: **detektor, nem elemző.** Soha nem szed ki dátumot a
mondatból (az „egy mintából osztályra következtetés" ugyanaz a hiba lenne). Egy
kérdést tesz fel: *beszél-e az ügy határidőről úgy, hogy közben egyetlen
dátum-mezője sincs kitöltve?*

**Amit szándékosan NEM fog meg:** azt az ügyet, aminek van dátuma, de rossz — a
mai pár pont ilyen volt. Hat ügy szólalna meg tíz percenként, és egy detektor,
ami folyton sír, egy héten belül némítva lesz. **A „rossz dátum" kérdése nyitva
marad** (kártya `eec5ca9f`).

---

# 9. Ügyek közötti kapcsolatok

## 9.1 Szál-alapú összekötés — két fél, és csak az egyik teljes

`case-link.ts`: közös entitás (foglalási szám, rendelésszám, fuvarlevél) alapján
köt vagy javasol. `STRONG` / `WEAK` erősség.

| fél | jelölés | fogyasztó |
|---|---|---|
| automatikus kötés | **[ÉLŐ]** | `related_case_ids` + `CASE_LINKED` esemény — **8 élő kötés**, köztük két Atrapalo-eset új szálból |
| javaslat | **[MEGÉPÍTVE]** | **NINCS.** A `CASE_LINK_SUGGESTED` eseményt egyetlen helyen írjuk (`intake.ts:200`), és a kódbázisban **nulla olvasója van**. Négy ilyen esemény áll a store-ban; egyet sem látott soha senki. |

Ez a dokumentum első saját esete arra, amit a bevezető megkövetel: a korábbi
`[MEGÉPÍTVE]` jelölés a két félből csak az egyikre volt igaz, és a hiányzó felet
láthatatlanná tette. **Ugyanaz a csend, csak a specifikációban.**

## 9.2 Szülő-ügy **[ÉLŐ, 2026-08-16]**

A `parent_case_id` oszlop a séma kezdete óta létezett, és **soha semmi nem írt
bele**: 0/79 személyes, 0/42 céges. Az OLVASÓ oldala viszont a
`ResolvedContext`-ig ki volt építve (`progression-resolver` → `progression-pipeline`).

Megépült az író oldal (`attachToParent`), két őrrel:

- **a szülőnek léteznie kell** — az üres oszlop tudja magáról, hogy üres; egy nem
  létező ügyre mutató azonosító hazugság, ami adatnak olvasódik
- **nincs kör** — egy út nem lehet a saját foglalásán belül

**Kimondva, mert nem a diffből olvasandó ki:** az ELSŐ írás minden érintett ügyön
megváltoztatja a `ResolvedContext`-et. Ma egyetlen produkciós ág sem ágazik el a
`hasParent`/`hasChildren` értékeken (mérve: az összes további előfordulás
teszt-fixture), tehát döntés nem változik — de aki később elágazást tesz rá, azt
örökli, amit itt összekötöttünk.

**A szülő-ügy szabályai:**
- **nincs `next_action`-je** — különben versenyezne a gyerekeivel a Today nézetben
- **a progresszió ki van kapcsolva rajta** — egy ernyő, amit a migrate beléptet, kérdezni kezdene
- invariánsai vannak, nem teendői

Élő példány: `PRI-TRIP-2026-001` (spanyol út), 15 gyerek, 9 naptár-esemény.

## 9.3 Naptár-hivatkozás **[ÉLŐ, 2026-08-16]**

`calendar_event_ids`, szintén 0/79-en állt. A naptár közben a teljes utat tudta
kezdet-vég párokkal. Megépült a `setCalendarEvents`; üres listára `[]`-t ír, nem
`NULL`-t (a „megnéztem, nincs" és a „sose néztem" nem nézhet ki egyformán).

**Fogyasztó a `develop`-on: NINCS.** Az egyetlen olvasója a `trip-timeline`
proveniencia-ellenőrzés, ami ma a PR #18 ágán él, nem a főágon. Élesben lefutott
és két leletet adott (a málagai és a valenciai Puerto szállásról nincs ügy), de
amíg az ág nincs behúzva, ez az oszlop a főágon **író-olvasó nélküli** —
ugyanaz az alak, mint a §9.1 javaslat-fele, csak fiatalabb.

**A párosítás azonosítón alapul, nem néven:** a naptár-esemény leírásában és az
ügy címében ugyanaz a Booking-foglalási szám. Egy szabály nélkül hamis lett
volna: **egy ügy, ami TÖBB foglalási számot nevez meg, egyiknek sem fedezete** —
különben az átfedésről szóló hibajelentés tüntette volna el a saját leletét.

---

# 10. Dokumentum-tároló

**[ÉLŐ]** `cos_documents`, 109 sor, tartalom-címzett (sha256) tárolás,
melléklet-letöltés Gmailből (`cos-attachment-ingest.py`), bejövő ÉS kimenő
levélre. Idempotens.

**Ismert, kompenzált hiány:** `extracted_text` 0/109. A `context-builder.ts`
2026-08-11 óta **visszaesik a tárolt bájtokra**, tehát a Reader látja a
tartalmat. Az `amount` / `issuer` / `due_date` viszont 9 számla-PDF-en üres, és
ezekre nincs visszaesés — **ez valódi, nyitott hiány.**

---

# 11. Radar (ár- és lehetőségfigyelés)

**[ÉLŐ]** 11 tétel. A v4.1 óta épült szabályok:

- **létrehozási kapu**: célár és keresőkifejezés nélkül NINCS radar-tétel
- **két bemenet**, és az elutasítás SZÖVEGGEL jön vissza
- **a ritmust tábla dönti el, nem modell**, és a határidő magától lezár
- **szállíthatóság háromértékű** — a „nem tudom" LÁTSZIK, és nem riasztunk olyanra, amiről nem tudjuk, hogy megkapja
- **a lezárt figyelés is megszólal** — különösen az, amelyik nem talált semmit
- napi kivonat a célár alatti, de nem igazolt szállíthatóságú találatokra, a nulla esettel együtt

---

# 12. Naptárba írás — ÚJ KÖVETELMÉNY (Istvan, 2026-08-16)

**[ÉLŐ]** Eddig a ChatGPT-oldali asszisztens vitte fel az eseményeket. Istvan
kérése: ezt Marveen is tudja, ha bejön egy megerősített foglalás.

Eszköz: `calendar_create_event` a `google-private` MCP-n. **Három szabály:**

1. **Csak MEGERŐSÍTETT foglalásból.** Árajánlat, terv, „gondoltam rá" nem megy naptárba.
2. **Előbb megnézzük, benne van-e.** A ChatGPT-oldal és a Booking automatikus naptárazása is ír bele; a duplikátum ugyanolyan kárt okoz, mint a hiány, és nehezebb észrevenni. (A málagai repülő MA IS duplán szerepel.)
3. **A leírásba kerül a FORRÁS** (feladó, tárgy, message id) — egy rossz eseményt így vissza lehet vezetni arra, ami okozta.

**Nincs update/delete eszköz.** Egy rossz eseményt Istvan javít. Ezért ha
bizonytalan a bejegyzés, nem írjuk be, és megmondjuk, miért nem.

**Biztonsági lelet ugyanekkor:** a `google-private` szerver fejléce azt állította,
hogy csak olvasni tud. A tokent lemérve: `calendar.events`, `gmail.modify`,
`gmail.send`, `spreadsheets`, `drive.readonly`. **A tool-készlet nem
jogosultsági határ** — bármely kód, ami olvassa a creds-fájlt, hívhat bármit,
amit a token enged. A fejléc javítva a MÉRT scope-ra. Küldő tool nincs kitéve, és
nem is lesz.

---

# 13. Karbantartás, mentés, megőrzés

**[ÉLŐ]** `cos-maintenance.ts` naponta 04:30: jogosultság-ellenőrzés, retenció,
**titkosított mentés + visszaállítási próba**. A mai futás: 174 MB, integritás
ok, 79 ügy visszaolvasva. A `problems` nem üres esetén — különösen a „NO BACKUP
WAS MADE" sorra — jelezni kell (§25 DoD 10).

---

# 14. Fokozatos autonómia

**[ÉLŐ]** `store/autonomy-config.json`, kategóriánként 1/2/3 szint. Zárolt,
maxLevel=1 kategóriák: `publish_content`, `payment`, `data_delete`,
`permission_change`, `external_message`. Az `email_send` maxLevel=2 —
**tehát a levélküldés soha nem lehet autonóm.**

---

# 15. Mission Control (dashboard)

**[MEGÉPÍTVE]** `localhost:3420`, Bearer-token mögött. `/api/cos/*`: today,
cases, events, documents, intake, outbound (+approve/reject), radar, analytics,
monitoring, kill-switch, progression.

**Ismert korlát:** az `owner-action` végpont csak akkor fogad választ, ha van
AKTÍV kérdés az ügyön. Ügy-lezárás vagy adatjavítás nem megy rajta — az a
domain-parancsokon át történik.

---

# 16. Mit tudunk MÉRNI a rendszerről

**[ÉLŐ mérés, de a modul a PR #18 ágán él, NEM a `develop`-on]** `column-fill.ts` megméri,
oszloponként hány sorban van érték. Nem kódot elemez — **adatot mér**, tehát nem
tud hamis pozitívot adni.

Az értelmezés kulcsa, hogy a két ügy-tábla **ugyanazt a motort** használja: egy
oszlop, ami a személyes oldalon ki van töltve, BIZONYÍTJA, hogy létezik írója.
Ugyanaz üresen a ZST oldalon nem hiányzó gépezet, hanem soha elő nem állt
helyzet.

```
mindkét névtérben üres:  next_wake_at (javítva), related_contact_ids, scope_review_reason
ZST-ben üres, személyesben írott (7):  next_action, next_action_owner, due_at,
   closure_reason, category, parent_case_id, calendar_event_ids
```

---

# 17. A ZST-névtér nyitott kérdése

**[ÉLŐ lelet, DÖNTÉS KELL]** 42 céges ügyből **egyiknek sincs** `next_action`-je,
`due_at`-je, `closure_reason`-je. A motor mindhármat tudja.

Következmény: **a ZST case engine iktat, de nem hajt.** A reggeli napindító
ZST-blokkja ezért mutat mindig `decisions=0 due48h=0` — és **ez a nulla nem
mérés, hanem egy sosem írt mező árnyéka.** Egy üres oszlop nem állít semmit; egy
`decisions=0` állítást tesz, és az állítás hamis.

Kártya: `58a1d408`. Két lehetséges válasz, és a döntés Istvané:
1. **Szándékos** — a ZST ma archívum. Akkor a napindító ZST-blokkja ne úgy fogalmazzon, mintha teendőket keresne.
2. **Nem szándékos** — a ZST intake is írjon teendőt és határidőt. Nem új gépezet, csak használat.

---

# 18. Nyitott követelmények (Istvan döntésére várnak)

| # | tétel | kártya / ügy |
|---|---|---|
| 1 | ZST: iktat vagy hajt | `58a1d408` |
| 2 | Előfizetés-nyilvántartás (megújulás, próbaidő, időszaki felülvizsgálat) | `7ca41d8c` |
| 3 | A „van dátuma, de rossz" határidő-eset | `eec5ca9f` |
| 4 | Két hiányzó utazási adat (málagai + valenciai Puerto szállás ügye, résztvevő-idővonal) | `PRI-TRIP-2026-002` |

A 2. tételhez a mérés már megvan: a `zst_licenses` tábla **pontosan erre való**
(megújulási dátum, automatikus megújulás, felmondási határidő, díj, használati
státusz, lemondásra jelölt) — és **0 sor van benne**. A hiányzó rész nem a tábla,
hanem a bemenet.

---

# 19. A visszatérő hibaalak, és mit csinálunk vele

Egyetlen nap alatt (2026-08-16) **nyolc** eset került elő ugyanabból a családból:

1. link-javaslat olvasó nélkül
2. `parent_case_id` — fogyasztóig kiépített olvasólánc, fogyasztó nélkül
3. `parent_case_id` 0/79 és 0/42 — soha nem írt oszlop
4. `calendar_event_ids` 0/79 — miközben a naptár mindent tudott
5. `trip-timeline` — nulla adaton futó ellenőrző
6. `next_wake_at` 0/61 — író és olvasó megvan, a fogyasztó a `.length`-et kérte
7. határidő prózában — az adat megvan, rossz TÍPUSBAN
8. ZST 7 oszlop — a gépezet megy, a névtér nem használja

**A szabály, ami ebből lett, és amit minden új alrendszerre alkalmazunk:**

> Egy fogalom nincs kész a fogyasztójáig. Egy ellenőrző, ami csak akkor szólal
> meg, ha talál, megkülönböztethetetlen attól, amelyik el sem indult. Ezért
> minden periodikus lépés **kimondja a nullát is**, megnevezve, mit vizsgált —
> és ahol a nulla háromféle okból jöhet (nincs adat / nincs előzmény / tényleg
> nem változott), ott **megnevezi, melyik csend**.

---

# 20. Bizonyítási standard

Ez a v4.1 óta a legfontosabb eljárási változás, és minden fenti állításra
vonatkozik:

- **A zöld nem bizonyíték.** Bizonyíték az, ha a PIROS a NEVESÍTETT teszten jelenik meg.
- **Mutáció előtt commitolj** — különben a visszaállításnak szánt `git checkout` magát a javítást törli, és három egymás utáni „piros" ugyanazt az állapotot méri.
- **Minden mutáció assertelje, hogy a horgonya illeszkedett** — egy csendes no-op `replace` érintetlen forráson „bizonyít".
- **Egy mutáció, ami nem változtat viselkedést (ekvivalens mutáns), semmit nem bizonyít.**
- **Egy teszt, ami nem különböztet, ugyanígy semmit.** (Élő eset: `Math.max(1, keep)` → `keep` zöld maradt, mert `slice(-0)` a JS-ben `slice(0)`, és egyetlen elemmel a „hossza 1" mindkét viselkedésre igaz.)
- **A tool-készlet nem jogosultsági határ**, és a szerver fejléce nem scope-mérés.

---

# 21. Amendment log

| verzió | dátum | mi történt |
|---|---|---|
| v4.0–v4.2.1 | 2026-08-04 | szándék-specifikáció, megépítés előtt |
| **v4.3** | **2026-08-16** | **állapot-specifikáció.** Céges névtér (§2), triage-seam a delta-poller helyett (§4.1), kérdés-alrendszer saját csatornával és minőségi szabályokkal (§6), ébresztő-fogyasztó (§8.2), próza-határidő detektor (§8.3), szülő-ügy és naptár-hivatkozás írás-oldala (§9.2–9.3), dokumentum-tároló (§10), radar-szabályok (§11), naptárba írás mint új követelmény (§12), oszlop-kitöltöttség mérés (§16), a ZST nyitott kérdése (§17), a visszatérő hibaalak és a bizonyítási standard (§19–20). |

**A v4.1 és v4.2 NEM elavult:** a részletes mezőlisták, sémák és a §25 DoD
onnan érvényesek. Ez a dokumentum azt mondja meg, mi VALÓSULT MEG belőlük, és mi
került hozzá.
