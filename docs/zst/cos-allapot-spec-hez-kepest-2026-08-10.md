# CoS állapot a specifikációhoz képest — személyes és céges

**Dátum:** 2026-08-10 05:00 · **Kérte:** Istvan · **Szerző:** Marveen
**Módszer:** minden szám a `store/claudeclaw.db` élő állapotából és a két
futtatható kapuból, ma hajnalban. Ahol állítok valamit, ott megmondom, mi méri.

---

## A rövid válasz

| | személyes | céges |
|---|---|---|
| futtatható kapu | `cos-acceptance.py` | `zst-acceptance.py` |
| állás | **33 PASS / 2 FAIL — PIROS** | **17 PASS / 0 FAIL — ZÖLD** |
| a kapu mennyit fed a 28 spec-szakaszból | 15 | 10 |
| ügyek | 61 (2 lezárt) | 40 (0 lezárt) |
| eseménynapló | 287 | 124 |
| feldolgozott levél | 19 | 48 |
| kimenő napló | 2 sor (1 VERIFIED) | **0 sor** |
| dokumentum-tár | 88 | közös |

A céges kapu zöld, a személyes piros. Ez első ránézésre fordítva van, mint
amire számítanál, és a magyarázat fontosabb, mint a két szám.

---

## 1. Amit a "zöld" NEM jelent

**A céges kapu ma hajnalban készült, én írtam, és a saját munkámat méri.** Egy
kapu, ami két órás, gyengébb bizonyíték, mint egy, ami hetek óta él és túlélt
néhány változtatást. Négy saját hamis zöldet már elkapott — ez jó jel, nem
felmentés:

1. az első futáson a ZO-1 zöld lett, mert a kapu a **saját szövegét** számolta
   hívónak (javítva a közös keresőben, ez a személyes kapu latens hibáját is
   orvosolta);
2. a ZI-4 pirosra ment egy **már eldöntött** szabályon (tartalom dönt vs.
   postafiók) — a kritérium mért rosszat, nem az adat;
3. a ZI-2 a **gyengébb kulcs** felé követelt szimmetriát;
4. a ZO-1 zöldre váltott abban a pillanatban, ahogy a route bekerült a
   forrásba, **miközben a végpont 404-et adott**, mert a dashboard a
   lefordított csomagot szolgálja ki.

**És a lefedettség: a személyes kapu 15, a céges 10 szakaszt érint a 28-ból.**
Vagyis a "zöld" azt jelenti: zöld azon, amit mérünk. Nem azt, hogy a spec kész.

---

## 2. Személyes CoS — mi áll pirosan, és miért kicsi

**IN-2 (§8):** 19 feldolgozott üzenetből 1 hordoz NULL szálazonosítót. Egyetlen
sor. A gyökér nem az adat: az `/api/cos/intake` ajtón a `threadId` opcionális.
Kártya: `fba7e4c4`.

Ehhez tartozik egy ma talált összefüggés: SQLite-ban egy UNIQUE constrainten
belül minden NULL különbözőnek számít, tehát az
`UNIQUE(gmail_account_id, thread_id, message_id)` **megszűnik deduplikálni**
pont azon a soron, ahol a szálazonosító hiányzik. A gyenge kulcs és a hiányzó
azonosító ugyanaz a hiba kétszer látva.

**WF-2 (§21, §25/4):** 2 kampány, 0 lezárt többnapos. Ez nem hiba, hanem
hiányzó élettapasztalat: a kritérium azt kéri, hogy legalább egy valódi,
többnapos ajánlatkérő-kampány végigfusson. Ez akkor lesz zöld, amikor egy
tényleg lefut, nem amikor kódot írok rá.

**Ami viszont él és nyoma van:** 61 ügy, 287 esemény, 88 tárolt dokumentum, és
**két valódi kimenő levél** a naplóban, ebből egy visszaolvasással igazolt.

---

## 3. Céges CoS — a kapu zöld, a vállalkozás üres

Ez a legfontosabb sor az egész dokumentumban.

**A 22 céges táblából 6-ban van adat, 16 üres.**

Van benne: `zst_cases` (40), `zst_case_events` (124), `zst_email_processing`
(48), `zst_products` (5), `zst_contracts` (2), `zst_invoices` (1).

Üres: könyvelési csomagok, banki tranzakciók, egyeztetési tételek,
kötelezettségek, beszállítók, licencek, beszerzési radar és ajánlatai,
partnerek, lehetőségek, termék-mérföldkövek, termék-eszkalációk, **kimenő
napló**, kampányok, kampány-jóváhagyások, claim-ek.

Vagyis: **a gépezet megvan, az üzleti tartalom nincs.** A motor, a beérkezés, a
két kinyerő (számla, szerződés), a figyelő és a kimenő ajtó mind él és mérhető.
Amit egy céges Chief of Staff naponta csinálna — banki egyeztetés, beszállítók,
licencek, határidők, beszerzés — annak nincs adata, mert nincs
per-dokumentumtípus kinyerő logika. Ez ismert és vállalt volt, de a mérete
látszik: ez a céges oldal érdemi hátraléka, nem a kapu két-három kritériuma.

---

## 4. Amit ma éjjel visszavontam magamtól

Az `f832abf3` kártyát (céges kimenő ajtó) lezártam. **Vissza kellett nyitnom.**

A saját tervem, írásban, ezt mondja az F3 fázisról: *"DoD: ZO-1 zöld, és a
`zst_outbound_ledger` egy valódi, jóváhagyott küldés nyomát hordozza. Amíg a
ledger üres, ez a fázis nem kész."*

A ledger most is 0 sor. Az ajtó elérhető, tesztelt, a kapu zöld — de senki nem
ment át rajta. A ZO-1 azt méri, hogy van-e éles hívó, nem azt, hogy használták-e.

És ez ugyanaz a hiba-osztály, amit ma éjjel a motoron javítottam: a motor
generikus DoD-vel zárta le az ügyeket; én egy konkrét, általam leírt DoD-t
hagytam figyelmen kívül, és lezártam egy gyengébb feltételre. A kártya
visszakerült `in_progress`-be.

**Hátra van:** egy valódi, általad jóváhagyott céges levél átmegy az ajtón, és
a ledger sort kap. Ez élő céges email, tehát a te döntésed. Javaslat: a
Vámosi-szál, ahol amúgy is nálunk van a labda (az igazolványokat kérték).

---

## 5. Kártya-mérleg

48 lezárt, 16 tervezett, 3 várakozó, 2 folyamatban. Ma éjjel 8 lezárva:

| kártya | mi volt |
|---|---|
| `0a7574db` | P0: a motor generikus, önigazoló DoD-vel lezárta az ügyeket |
| `936559d1` | P0: a rekonszilláció vak volt a céges oldalra |
| `8eb5a1e9` | a stagnálás-számlálót senki nem olvasta |
| `13648f40` | 27 befagyott céges ügy — a premisszája megfordult |
| `6bb289cc` | nem volt céges acceptance-kapu |
| `567853a1` | a céges dedup-kulcs — a premisszája szintén megfordult |
| `d7e5df01` | érzékenységi réteg inert — tulajdonosi döntés: egy jóváhagyás elég |
| `f832abf3` | céges kimenő ajtó — **visszanyitva, lásd 4. pont** |

---

## 6. A következő három dolog, sorrendben

1. **`fba7e4c4`** — a szálazonosító legyen kötelező az intake ajtón, utána a
   személyes kulcs is szigorítható. Ez zárja az IN-2-t. Kicsi, determinisztikus.
2. **`f832abf3`** — egy valódi céges levél az ajtón. A te döntésed, mikor és
   kinek.
3. **A céges üzleti kinyerők** — a 16 üres tábla. Ez a nagy tétel, és tudatosan
   a végén van: addig minden alatta lévő réteg mérhető és stabil.

---

## Módszer

Kapuk: `python3 scripts/cos-acceptance.py`, `python3 scripts/zst-acceptance.py`
— determinisztikusak, pirosnál exit 1. Adatok: közvetlen SQLite lekérdezés az
élő `store/claudeclaw.db`-ből, 2026-08-10 04:45 és 05:00 között. A
spec-lefedettség a két kapuban szereplő `§`-hivatkozások halmaza a
`docs/marveen-personal-chief-of-staff-v4.2.md` 28 fő szakaszához mérve.
