# ZST Radio CoS — gap-analízis a speckóhoz, mérve

**Dátum:** 2026-08-10 03:00 · **Szerző:** Marveen · **Kérte:** Istvan
**Kiindulás:** a privát CoS ma éjjeli mérése (cos-acceptance: 35 kritérium, 33 PASS, 2 FAIL)

## Miért nem elég a meglévő audit

A céges oldal állapotáról ma a `zst-cos-v1.1-completion-audit-2026-08-07.md` szól.
Azt én írtam, három napja, és állítások gyűjteménye, nem mérés. Ez a dokumentum nem
azt ismétli meg: minden sora mögött egy ma hajnalban lefuttatott lekérdezés vagy
kódkeresés áll, és ahol az audit igazat mondott, azt is kiírom.

**A módszertani különbség maga is gap.** A privát oldalnak van műszere: 35
kritérium, futtatható, piros vagy zöld. A céges oldalnak **nincs**. A
`cos-acceptance.py` a `zst` szót öt helyen említi, ebből négy komment, egy pedig a
jóváhagyási rétegek szimmetria-vizsgálata (AP-2). Vagyis a céges CoS állapotát ma
egyetlen módon lehet megtudni: valaki kézzel megnézi. Ez pontosan az a bizonyíték-
osztály, amit a privát oldalon már nem fogadunk el.

---

## 1. P0 — huszonhét céges ügy be van fagyva, és élőnek látszik

**A tény.** A 40 céges ügyből 27 `NEW` státuszban áll a táblán, de a haladás-motor
**soha többé nem fogja megnézni őket**: a `case_progression_state` sorukban
`progression_enabled = 0`.

**A bizonyíték.** Mind a 27 sor `updated_at` mezője azonos:
`2026-08-09 19:01:57`. Ez másodpercre az a pillanat, amikor a motor tömegesen
lezárta az összes céges ügyet, és amit tizenöt percen belül visszaállítottunk. A
visszaállítás a **státuszt** helyreállította, a **haladás-kapcsolót nem**. A
motor a lezáráskor kikapcsolja a további pollingot (`progression-pipeline.ts:1074`),
és ezt a lépést a helyreállítás nem fordította vissza.

**Miért nem látszott.** Az ügyek a táblán `NEW`-ként jelennek meg, tehát élőnek
tűnnek. A heartbeat kimenete `zst: 4` — pont a négy `WAITING_EXTERNAL` ügy, amelyik
engedélyezve maradt. Egy `zst: 4` sor éjjel nem gyanús.

**Miért nem javítottam meg magamtól.** A kapcsoló visszakapcsolása 27 élő céges ügyön
azt kockáztatja, hogy a motor újra végigfut rajtuk ugyanazon a `NEW` úton, ami
tegnap este a tömeges lezárást okozta. A ma engedélyezett négy ügy nem bizonyíték az
ellenkezőjére: azok `WAITING_EXTERNAL` állapotúak, más ágon futnak, és a motor
helyesen `WAIT_EXTERNAL` döntést hoz rájuk (három ciklusban ellenőriztem).

**Javasolt lépés:** kanári. Két ügyet kapcsolunk vissza, egy ciklust megvárunk, és
csak akkor jön a maradék 25, ha egyik sem zárult le magától.

---

## 2. Beépítve, tesztelve, elérhetetlenül — a céges kimenő ág

A `zst-send.ts` teljes küldési láncot exportál: `draftZstSend`, `approveZstSend`,
`rejectZstSend`, `authorizeZstSend`, `evaluateZstSendGate`, `dispatchZstSend`.

**Egyetlen nem-teszt fájl sem importálja.** Kerestem az `src/`, `scripts/`, `web/`
és `dist/` fákban, `.ts .js .py .html` kiterjesztésre, teszteket kizárva: a
találatok a saját fájljában vannak (egy definíció és egy komment), plusz egy
komment a `cos-acceptance.py`-ban.

A négy céges végpont **mind GET**: `zst-cases`, `zst-today`, `zst-due`,
`zst-business`. Nincs POST a céges piszkozat-jóváhagyás-küldés útra. A privát
oldalon van (`/api/cos/outbound/approve`), és pont ezért PASS ott az OU-3.

Megerősíti a `zst_outbound_ledger`: **nulla sor**. A lánc soha nem futott.

Az audit ezt "Slice 1 write-half DONE, 9 AT-ZA teszt zöld"-ként írta le. A modul
tényleg kész és tesztelt. Képességként viszont nem létezik, mert nincs ajtaja.
Ez a built-but-never-invoked osztály, csak most a saját munkámon.

**Ugyanez a két további modul:** `zst-bank-import.ts` és `zst-productlab.ts` —
nulla nem-teszt importőr, és mindkettőnek van saját tesztfájlja. Tíz céges
tesztfájl van, moduloként egy; közülük három olyan modult fed, amit semmi nem hív.

---

## 3. Ami viszont tényleg be van kötve

Nem minden Potemkin, és ezt is meg kell mondani. Nem-teszt importőrrel rendelkezik:

| Modul | Honnan érhető el |
|---|---|
| `zst-case-store` | progression-pipeline, zst-intake, routes |
| `zst-intake` | `/api/cos/intake` (POST) |
| `zst-invoice-extract`, `zst-contract-extract` | zst-intake — vagyis **valódi bejövő levélen futnak** |
| `zst-finance` | zst-invoice-extract |
| `zst-watch` | `/api/cos/zst-due` (GET) |
| `zst-sensitivity` | zst-send és zst-intake |

És ennek van adat-nyoma: `zst_invoices` 1 sor, `zst_contracts` 2 sor. Az
extraktorok valódi levélből dolgoztak. A `zst_email_processing` 47 sorából
**47 hordoz szálazonosítót** — vagyis az IN-2 kritérium, ami a privát oldalon
piros, a céges oldalon zöld lenne.

---

## 4. Adat-valóság: 22 céges táblából 16 üres

Van sor benne: `zst_cases` 40, `zst_case_events` 115, `zst_email_processing` 47,
`zst_products` 5, `zst_contracts` 2, `zst_invoices` 1.

Üres: `zst_accounting_packages`, `zst_bank_transactions`, `zst_reconciliation_items`,
`zst_obligations`, `zst_vendors`, `zst_licenses`, `zst_procurement_radar_items`,
`zst_procurement_radar_offers`, `zst_partners`, `zst_opportunities`,
`zst_product_milestones`, `zst_product_escalations`, `zst_outbound_ledger`,
`zst_campaigns`, `zst_campaign_approvals`, `zst_case_claims`.

Az audit ezt előre jelezte és okát adta (per-dokumentumtípus kinyerő logika kell,
ami nem egy éjszaka). Ez a rész tehát ismert és vállalt, nem meglepetés. A
`zst_case_claims` üressége normális, a privát `case_claims` is üres — az egy
tranziens tábla.

---

## 5. Amit a céges oldal a közös motorból ÖRÖKÖL

A megosztott motor a v1.1 kifejezett architektúra-döntése volt, és jó döntés. De
a hibák is öröklődnek:

- **A néma stagnálás-detektor.** A `no_progress_run_count` a céges ügyekre
  ugyanúgy íródik, és ugyanúgy senki nem olvassa. Kártya: `8eb5a1e9`.
- **A szálazonosító-ajtó.** A `/api/cos/intake` nem követeli meg a `threadId`-t,
  és ugyanaz az ajtó szolgálja ki a céges beérkezést is. Ma a céges oldalon nincs
  hiányzó azonosító, de a rés ugyanaz. Kártya: `fba7e4c4`.

## 6. Amit a céges oldal NEM örököl, pedig kellene

**A napi rekonszilláció vak a céges oldalra.** A `reconcile.ts` és a
`cos-daily-reconcile.ts` a `zst` szót **nulla alkalommal** tartalmazza. A privát
MO-1 tíz riasztás-témát fed le; ezek egyike sem néz céges táblát.

Ez nem elméleti: pont ezért maradt a 27 befagyott ügy egy teljes napig láthatatlan.
A monitorozás nem tudta jelezni, mert nem néz oda.

**Időzítés:** a `zst-weekly-review` ütemezett feladat él, és **ma reggel 8-kor fut**
(hétfő). Ha addig nem oldjuk fel a fagyást, egy olyan táblát fog összefoglalni,
aminek kétharmada mozdulatlan, és ezt nem fogja tudni.

---

## Rangsorolt hiánylista

| # | Hiány | Osztály | Súly |
|---|---|---|---|
| 1 | 27 céges ügy `progression_enabled=0`, a 08-09-i incidens maradványa | élő üzemzavar | **P0** |
| 2 | A napi rekonszilláció/monitorozás nem néz céges táblát | vak műszer | **P0** |
| 3 | A céges kimenő lánc (`zst-send`) teljes, tesztelt, és nincs hívója | built-not-invoked | **P1** |
| 4 | Nincs céges acceptance-kapu; az állapot kézi auditból jön | nincs műszer | **P1** |
| 5 | `zst-bank-import`, `zst-productlab`: nincs hívó | built-not-invoked | P2 |
| 6 | 16 üres üzleti tábla (kinyerő logika hiánya) | ismert, vállalt | P2 |
| 7 | Örökölt: néma stagnálás-detektor (`8eb5a1e9`) | közös motor | P2 |
| 8 | Örökölt: opcionális `threadId` az intake ajtón (`fba7e4c4`) | közös motor | P2 |

## Amit a mérés IGAZOLT az auditból

Nem minden állítás dőlt meg, és ezt is le kell írni:

- **"Write-scope OAuth is now live"** — IGAZ. A `google-zst` token ma hét jogot
  visel, köztük `gmail.send`, `drive.file` és `spreadsheets`. Élő tokeninfo-val
  ellenőrizve. (Megjegyzés: a feasibility doc még "READ-ONLY hard dependency"-t ír
  — az a sor mára elavult.)
- **"Slice 3/6 read side DONE, `/api/cos/zst-due` live"** — IGAZ, a `zst-watch`
  importálva van a route-fájlból.
- **"a business tables are EMPTY"** — IGAZ, és az audit ezt maga is kimondta.

---

# Fejlesztési terv (Istvan GO, 2026-08-10 03:00)

A sorrendet nem a specifikáció fejezetszáma adja, hanem az, amit a privát CoS
javításán megtanultunk. Négy tanulság, és mindegyik egy-egy fázissá válik:

1. **Előbb a műszer, aztán a funkció.** A privát oldalon a 35 kritériumos kapu
   volt az, ami a hazugságokat kizárta. A céges oldalon a kapu HIÁNYA engedte,
   hogy három valós hiba egy napig láthatatlan maradjon.
2. **Egy képességnek hívója van, nem tesztje.** Zöld teszt + nulla hívó = a
   funkció nem létezik. Minden fázis akkor kész, ha a hívó grep-pel kimutatható.
3. **Ami nincs monitorozva, az nem üzemel.** A 27 befagyott ügy nem azért maradt
   rejtve, mert nehéz észrevenni, hanem mert senki nem nézett oda.
4. **Élő állapotot soha nem tömegesen.** Kanári, egy ciklus megvárása, utána a
   többi.

## F0 — a céges kapu ✅ KÉSZ (2026-08-10 03:05)

`scripts/zst-acceptance.py`, 16 kritérium, hét csoportban (motor, bejövő, kimenő,
élő hívó, monitorozás, ütemezés, pénzügy). A kritériumok a v1.1 spec §4/§6/§7/§9/
§14/§19 és a §32 AT-Z* tesztjei mentén, plusz a tegnapi incidensekből származó
kettő. Nem másolja a privát kapu segédfüggvényeit, hanem importálja: egy szabvány,
ami kétszer létezik, elcsúszik.

**Első futás: 11 PASS, 5 FAIL, 0 UNKNOWN, 0 ERROR — a kapu PIROS.** Determinisztikus
(két egymást követő futás bájtra azonos), pirosnál exit 1.

A kapu az öt valós hibát pontosan azonosítja: ZE-2 (27 befagyott ügy),
ZI-2 (gyenge dedup-kulcs), ZO-1 (hívó nélküli küldő-lánc), ZL-1 (három árva modul),
ZM-1 (vak monitorozás).

### Amit az első futás ELSŐ verziója rosszul mondott, és a javítás

A ZO-1 először ZÖLD lett, azzal az indoklással, hogy a `dispatchZstSend` hívója
a `zst-acceptance.py`. Vagyis a kapu a saját szövegét számolta hívásnak. Pont az a
hamis zöld, aminek a kizárására az egész eszköz készült.

A javítás a **szűkületnél**, a közös `prod_files` keresőben van, nem egy
kritériumban: a kapu-fájlok mérőeszközök, nem éles kód, tehát ki vannak zárva a
találatokból. Ez a privát kapu egy latens hibáját is javította — ott a
`cos-acceptance.py` szintén szerepelt a saját OU-3 és LV-2 bizonyítékában, csak
ott valódi hívók is voltak mellette, ezért nem borította a verdiktet. A privát
kapu a javítás után változatlanul 33/35, tehát nincs regresszió.

## F1 — monitorozás a céges oldalra (P0, `936559d1`)

A napi rekonszilláció nézze a `zst_cases` + `case_progression_state` párost, és
riasszon, ha nem-lezárt ügy kikapcsolt haladás-kapcsolóval áll. Ez pontosan a
ZE-2 kritérium futásidejű párja: a kapu megmondja, a monitor pedig szól.

DoD: a ZM-1 kritérium zöld, és a riasztás bizonyítottan tud pirosat adni.

## F2 — a 27 befagyott ügy feloldása (P0, `13648f40`) — Istvan GO kell

Kanári: előbb tisztázni, javult-e a generikus DoD, ami az incidenst okozta; utána
KETTŐ ügy visszakapcsolása; egy teljes heartbeat ciklus megvárása és a
`case_progression_runs` döntésének megnézése; és csak ha egyik sem zárult le
magától, jön a maradék 25.

DoD: a ZE-2 kritérium zöld, és a `case_progression_runs` bizonyítja, hogy a
visszakapcsolt ügyek WAIT/PROGRESS döntést kaptak, nem COMPLETE-et.

## F3 — a céges kimenő ajtó (P1, `f832abf3`)

POST végpont a piszkozat-jóváhagyás-küldés útra, a privát
`/api/cos/outbound/approve` mintájára. Valódi céges email megy ki rajta, tehát a
kapuk (pontos payload-hash, címzett-lista, ZST sensitivity, connector
write-usable) mind álljanak, MIELŐTT az ajtó kinyílik. Az OAuth kész.

DoD: ZO-1 zöld, és a `zst_outbound_ledger` egy valódi, jóváhagyott küldés nyomát
hordozza. Amíg a ledger üres, ez a fázis nem kész.

## F4 — a maradék árva modul + a dedup-kulcs (P2)

`zst-bank-import` és `zst-productlab` bekötése vagy tudatos kivezetése (egy modul,
amit nem akarunk használni, törlendő, nem tárolandó). Plusz a `ZI-2`: a céges
feldolgozási napló egyedi kulcsa kapja meg a `thread_id`-t, ahogy a személyesé.

DoD: ZL-1 és ZI-2 zöld.

## F5 — üzleti kinyerő logika (P2, hosszú)

A 16 üres tábla feltöltése per-dokumentumtípus kinyerőkkel. Ez a valóban nagy
tétel, és tudatosan a végére kerül: addig minden más réteg mérhető és stabil.

## Módszer

Minden szám a `store/claudeclaw.db` élő állapotából, 2026-08-10 02:40 és 03:00
között. A hívó-keresések: `grep -rn` az `src/ scripts/ web/ dist/` fákon,
`.ts .js .py .html` kiterjesztésre, `__tests__` és `.test.` kizárva. A
scope-ellenőrzés élő `oauth2.googleapis.com/tokeninfo` hívás a frissített
access tokennel. A `sqlite3` CLI nincs telepítve a gépen, minden lekérdezés
`python3 -m sqlite3`.
