# COS — a 2026-08-12-i review javításai és az éles frissítés menete

**Ág:** `claude/cos-review-fixes-qe1z7m` (a `develop` @ `2d3c662` tetejéről)
**Testvér-ágak:** `claude/apg-review-fixes-qe1z7m` (ugyanez a repó), `marveen-apg-kernel` → `claude/apg-kernel-review-fixes-qe1z7m`
**Forrás:** `audits/teljes-code-review-cos-costops-opt-apg-2026-08-12.md`, T-1 … T-5

---

## ⚠️ 0. Amit az éles frissítésnél KÖTELEZŐ megcsinálni

**Egyetlen kézi lépés van, és enélkül a Telegram-válasz-út leáll.**

A `store/.cos-telegram-bot.json` fájlba fel kell venni az `owner_id` mezőt:

```json
{
  "token": "...",
  "channel_id": "telegram:cos",
  "chat_id": "...",
  "owner_id": "8942301795",
  "routes": []
}
```

Az érték az a Telegram user-azonosító, ami eddig a `scripts/cos-channel-poll.ts:26` sorban állt konstansként: **`8942301795`**.

**Ha kimarad:** a poller minden bejövő üzenetet visszautasít, és ezt minden ciklusban kiírja:

```
CosInbox: {"read":0,"failed":true,"error":"no owner_id in the CoS bot config — owner answers cannot be authorised"}
```

Ez **szándékosan** ebbe az irányba bukik. A másik irány az lenne, hogy jogosultsági ellenőrzés nélkül bárkitől elfogad válaszokat — a bot pedig bárki számára elérhető, aki megtalálja, és egy tulajdonosi válasz ügyeket zár le és `OWNER_DECISION` eseményt ír.

Számokban: `owner_id` nélkül **nem vész el adat** (a beérkező üzenetek `rejected`-ként számlálódnak, a Telegram-kurzor viszont továbblép, tehát az adott üzenetek nem jönnek vissza) — de a válasz-út nem működik, amíg be nem kerül.

---

## 1. A frissítés menete

```bash
cd ~/marveen                      # az éles checkout
git fetch origin
git merge origin/claude/cos-review-fixes-qe1z7m

# A KÖTELEZŐ lépés (0. szakasz)
$EDITOR store/.cos-telegram-bot.json     # owner_id felvétele

npx tsc --noEmit                  # elvárás: néma
npx vitest run src/__tests__/cos-*.test.ts   # elvárás: 966 zöld / 111 fájl
```

**Séma-migráció nincs.** Egyetlen `CREATE TABLE` és `ALTER TABLE` sem került be; a `cos_channel_held` tábla (a `resolution` oszloppal együtt) már a `develop`-on létezik. A `store/claudeclaw.db` érintetlen.

### Ellenőrzés egy éles ciklus után (~10 perc)

```bash
npx tsx scripts/cos-cycle.ts | python3 -m json.tool
```

Amit nézni kell a kimeneten:

| Mező | Elvárás | Ha nem stimmel |
|---|---|---|
| `inbox.error` | **nincs jelen** | ha `no owner_id…`, akkor a 0. szakasz kimaradt |
| `channel.heldOpen` | idővel csökken, nem nő monoton | ha nő: a visszakérdezés nem megy ki — nézd a `channel.failures`-t |
| `channel.heldAnswered` | ≥ 0, és `heldOpen` > 0 esetén > 0 | 0-nál a küldés bukik |
| `reader.byProvider` | **céges ügyeknél megjelenhet a `deepseek`** | lásd 2.1 — ez a várt viselkedés-változás |
| `reader.sensitivityBlocked` | **csökkennie kell** | ha nem: nézd a tárolt `refusal_reason`-öket |

### Visszaállítás

`git revert` a merge commitra. Nincs adatmigráció, nincs mit visszabontani. Az `owner_id` a configban maradhat — a régi kód nem olvassa, tehát ártalmatlan.

---

## 2. Mi változott, és miért

### 2.1 T-1 (P1) — a céges ügyek nem adathiányból lesznek „szigorúan titkosak"

**Ami volt.** A `contextSensitivity` minden kontextus-elemet a **személyes** szótár szerint olvasott. A céges ügyek `ZST_INTERNAL`, `ZST_FINANCIAL` stb. címkét hordoznak, amit az a szótár nem ismer, tehát fail-closed módon `HIGHLY_SENSITIVE` lett belőle. Visszamérve, mind a nyolc céges osztályon:

```
zst_cases.sensitivity=PUBLIC             -> PUBLIC             | deepseek mehet: IGEN
zst_cases.sensitivity=ZST_INTERNAL       -> HIGHLY_SENSITIVE   | deepseek mehet: NEM
zst_cases.sensitivity=ZST_CONFIDENTIAL   -> HIGHLY_SENSITIVE   | deepseek mehet: NEM
zst_cases.sensitivity=ZST_FINANCIAL      -> HIGHLY_SENSITIVE   | deepseek mehet: NEM
...                                         (nyolcból hét)
```

Három következménye volt: fölösleges költség, hamis indoklás a tárolt `refusal_reason`-ben („HIGHLY_SENSITIVE content…" olyan tartalomról, ami nem az), és egy egyetlen ponton múló céges leállás, ha a kontraktált kulcsok kiesnek.

**Ami lett.** `src/cos/provider-data-policy.ts` → `egressTierFor(domain, declared, content)`. Mindkét sweep (`reader-cycle`, `goal-enrichment`) ezt hívja.

A leképzés **nem vélemény, hanem levezetés**: minden céges osztály ahhoz a személyes tierhez van rendelve, amelyiknek a *model-profil allowlistája* megegyezik az övével. Mindkét tábla eddig is létezett, mindkettő tulajdonosi politika:

| céges osztály | engedélyezett profilok | → egress tier |
|---|---|---|
| `PUBLIC` | mind | `PUBLIC` |
| `ZST_INTERNAL` | premium, build_strong, analysis_efficient | `PERSONAL` |
| `ZST_CONFIDENTIAL` | premium, build_strong | `SENSITIVE_PERSONAL` |
| `ZST_FINANCIAL` / `LEGAL` / `PERSONAL_DATA` / `HIGHLY_SENSITIVE` / `UNKNOWN` | premium | `HIGHLY_SENSITIVE` |

Erre standing check van (`cos-egress-tier.test.ts`): **újraszármaztatja** a táblát a két allowlistából, tehát ha bármelyik változik, a teszt bukik, nem a leképzés kezd mást jelenteni.

**Szigorúbb is lett annál, amit lecserél.** A `goal-enrichment` privát másolata csak a *deklarált* céges osztályt vette figyelembe; a közös verzió a **céges tartalom-osztályozót** is futtatja, tehát egy IBAN a „belső" szálban felviszi a szintet.

**Miért ez a legfontosabb tanulság.** Ezt a hibát a `goal-enrichment`-ben megtalálták és megjavították — abban a modulban, ami a `routeFor`-t **szó szerint átmásolta** a Readerből. Az útválasztás átjött, a megoldás nem. A második standing check emiatt van: elbukik, ha bármelyik sweep újra saját leképzést növeszt.

> **Viselkedés-változás éles rendszeren:** a `ZST_INTERNAL` céges ügyek mostantól az **olcsó** útra mehetnek, és a korábban `SENSITIVITY_BLOCKED` céges ügyek egy része **fel fog olvasódni**. Ez a szándék. Ha ezt nem akarod, a `ZST_TO_EGRESS_TIER` táblát kell szigorítani — de akkor a `zst-sensitivity.ts` allowlistát is, különben a standing check bukik.

### 2.2 T-2 (P1) — a „visszakérdezésnek tűnt" ág nem dobja el a szavakat

**Ami volt.** `scripts/cos-channel-poll.ts`: a `looksLikeAQuestionBack(u.text)` ág csak számlált és `continue`-zott. A kurzor a ciklus alján lép, és a Telegram egy magasabb offset kérése után **nem szolgálja ki újra** az üzenetet. A mondat elveszett.

Három sorral lejjebb a többértelműségi ág pontosan az ellenkezőjét csinálja, ezzel a kommenttel:

> „HOLD THE WORDS, not just the count. The cursor moves below and Telegram will not serve this update again."

Ugyanaz az érv, ugyanaz a ciklus.

**Mennyire gyakori.** A felismerő szigorúan fail-closed, és emiatt tág. Visszamérve valós válaszokon:

```
megmarad | Igen, mehet.
ELDOBVA  | Hogy őszinte legyek, inkább 12 milliót kérek.
ELDOBVA  | Mennyi az annyi, fizessük ki.
ELDOBVA  | Milyen jó, hogy szóltál — elfogadom az ajánlatot.
ELDOBVA  | Ki kell fizetni a szamlat.
ELDOBVA  | Rendben, de kerdezd meg az ugyvedet is?
```

Hétből hat.

**Ami lett.** Ez az ág is `holdOwnerMessage`-el ment, `reason: 'visszakerdesnek tunt, ezert nem lett dontesnek olvasva'`.

**Amit szándékosan NEM változtattam:** a felismerő szigorúsága. A fail-closed döntés helyes — ez az ág egy valódi incidensből született (Istvan „Ez melyik számla?" kérdését a poller válaszként rögzítette és lezárta vele az ügyet), és egy hamis `OWNER_DECISION` az append-only ügynyilvántartáson rosszabb, mint egy elmaradt válasz. **A hiba nem a visszautasítás volt, hanem az elhelyezés.**

### 2.3 T-3 (P2) — a félretett üzeneteknek lett olvasójuk, és Istvan visszajelzést kap

**Ami volt.** A `cos_channel_held` táblát semmi nem olvasta, a `resolved_at`-ot semmi nem írta, és a tulajdonos **nem kapott választ**. Az ő oldaláról ez megkülönböztethetetlen attól, mintha az üzenet elveszett volna: válaszol, nem történik semmi, csend. Egy félretett üzenet válasz nélkül ugyanaz a csend, csak jobb audit-nyommal.

**Ami lett.** `scripts/cos-channel-send.ts` üríti a sort: idézi a mondatot, megnevezi az okot, és felsorolja a nyitott kérdéseket — mert a **reply-to** az egyetlen jelzés, amihez a `matchAnswerTarget`-nek nem kell találgatnia.

Példa:

```
❓ Ezt nem tudtam ügyhöz kötni:
„Igen, fizessuk ki"

Ok: tobb nyitott kerdes, es az uzenet egyiket sem nevezte meg

Nyitott kérdések — válaszolj közvetlenül arra az üzenetre (reply):
• Wizz Air szamla (PRI-2026-014)
• NAV postafiok (PRI-2026-011)
```

**Küldés előbb, jelölés utána** — egy kézbesítési hiba nyitva hagyja a sort a következő sweepnek, ami pontosan az, amiért a tábla létezik.

Két új számláló a ciklus-riportban: `heldAnswered`, `heldOpen` — **nullánál is kiírva**, mert „nem volt mit félretenni" és „gyűlnek a megválaszolatlan félretett üzenetek" nem nézhet ki egyformán.

### 2.4 T-4 (P3) — a tulajdonos azonosítója configba került

Lásd a 0. szakaszt. A `CosBotConfig` új mezője `ownerId`, a configban `owner_id`. **Számot is elfogad**: a Telegram minden payloadban számként adja az azonosítót, és egy parser, ami csendben figyelmen kívül hagyja a `123`-at mert `"123"`-at akart, a lehető legzavaróbb módon bukna — a poller onnantól senkit nem engedne be.

### 2.5 T-5 (P3) — a válasz rögzítése domainre is illeszt

A `recordOwnerAnswer` a nyitott kérdést és a lezárását eddig **domain nélkül** kereste, miközben az eseményt a domain saját táblájába írta. Rossz domainnel: a kérdés lezárult, esemény nem született — a válasz eltűnt, a kérdés „megválaszoltnak" látszott.

Ma nem tudott elsülni, mert az egyetlen hívó a `matchAnswerTarget` sorából veszi a domaint. De egy őr, ami minden jövőbeli hívó gondosságától függ, nem őr.

---

## 3. Amit ez az ág NEM old meg

| # | Találás | Állapot |
|---|---|---|
| **Ö-1 második fele** | a Reader `final_decision`-je nem hat a motor döntésére | **nyitva, szándékosan** — §13.1 arbitrációs kérdés és tulajdonosi döntés. Az első fele (láthatóság a Mission Controlban) megvan |
| **N-4** | `approval_version` a `campaign_version` másolata (`approval-core.ts:354`) | **nyitva** |
| **N-5** | a `setMode` csatorna-kapcsolónak nincs produkciós hívója (`connector-health.ts:96`) | **nyitva** |
| kereszt | három uid-függő `chmod`-alapú negatív teszt root alatt pirosat ad | **nyitva** — a repóban már ott a helyes minta (`dispatch-session-resolution.test.ts:137`) |

Az `unmatched` ág (amikor semmi nyitott kérdés nincs) **szándékosan** nem tart vissza üzenetet: az első két bejövő üzenet egy új boton tipikusan `/start` és `Hi`, és azokkal teleírni a táblát zajt csinálna abból, ami épp a zaj kiszűrésére való.

---

## 4. Mérés

| Kapu | Eredmény |
|---|---|
| `npx tsc --noEmit` | **zöld** |
| `npx vitest run src/__tests__/cos-*.test.ts` | **966 zöld / 111 fájl** (előtte 936 / 109) |
| Új teszt-fájlok | `cos-egress-tier.test.ts` (8), `cos-held-message-loop.test.ts` (11) |
| Séma-változás | **nincs** |
| Kötelező kézi lépés | **1** — `owner_id` a bot configba |
