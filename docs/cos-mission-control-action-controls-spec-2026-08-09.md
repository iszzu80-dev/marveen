# Mission Control — ügy-továbbléptető vezérlők (akciógombok)

**Tulajdonosi döntés:** Istvan, 2026-08-09 (TG 8311, 8313) — elfogadva, fejlesztésre mehet
**Spec:** marveen
**Előzmény:** a CoS progression réteg 2026-08-09 óta él. A motor jelenleg 10 ügyben kér döntést
(`REQUEST_DECISION`), 1 ügyben információt (`ASK_INFORMATION`), 2 ügyben helyreállítást
(`RECOVERY_REQUIRED`), 18 ügy külső válaszra vár (`WAIT_EXTERNAL`). A válaszút ma kizárólag a chat:
a kérdés és a válasz két külön világban él.

---

## 1. Cél

A Mission Control kártyáján lehessen egy ügyet továbblendíteni: megerősítéssel, igen/nem
választással, vagy egy rövid szöveges válasszal. A cél nem egy általános űrlapmotor, hanem hogy
a motor által MÁR feltett kérdésre a boardon lehessen válaszolni.

## 2. Alapelv — a gomb eseményt ír, nem állapotot

A vezérlő **nem** módosítja a `personal_cases` / `zst_cases` sorát és **nem** ír
`case_progression_state`-et. Egyetlen dolgot tesz: beír egy sort a megfelelő
`*_case_events` táblába, és a következő progresszió-ciklus dolgozza fel.

Indok: a motor marad az egyetlen állapotíró, a napló ép marad, a futás visszajátszható. Két írófél
két igazságot jelent fél éven belül.

Esemény-formátum (a meglévő séma mezőivel, nincs sémabővítés):

```
event_type      OWNER_DECISION | OWNER_INFORMATION | OWNER_CONFIRMATION
actor           "istvan"
source_system   "mission_control"
source_reference <progression_run_id, amelyik a kérdést feltette>
reason          a gomb felirata / a választott opció
payload         JSON: {"choice":"YES|NO|DONE", "text":"<szabad szöveg, ha van>",
                       "idempotency_key":"<uuid>", "external_effect_ack": true|false}
correlation_id  <case_id>:<progression_run_id>
```

**A `source_reference` kötelező.** Ez köti a választ ahhoz a konkrét kérdéshez, amire adták. Ha a
motor közben új kérdést tett fel, a régi kérdésre adott válasz elavult — lásd 6.3.

## 3. A vezérlő a motor kimenetéből származik, nem fix lista

A felület ne ismerjen ügy-típusokat. A megjelenítendő vezérlőt a `case_progression_runs` utolsó
sorának `decision` mezője és a `next_best_action_json` határozza meg:

| motor kimenete | vezérlő | esemény |
|---|---|---|
| `REQUEST_DECISION` | igen / nem választógomb + opcionális megjegyzés | `OWNER_DECISION` |
| `ASK_INFORMATION` | szövegmező, benne a motor tényleges kérdésével + Küldés | `OWNER_INFORMATION` |
| `RECOVERY_REQUIRED` | egygombos „Rendben, mehet tovább” + opcionális megjegyzés | `OWNER_CONFIRMATION` |
| `WAIT_EXTERNAL` | egygombos „Megjött a válasz” + rövid szöveg | `OWNER_INFORMATION` |
| `CONTINUE_AUTONOMOUSLY` | **nincs vezérlő** — nem vár rád semmit | — |

Új döntéstípus megjelenésekor a felülethez nem kell hozzányúlni: ismeretlen `decision` esetén
nincs gomb (fail-safe), nem pedig találgatott vezérlő.

## 4. Gomb-életciklus (tulajdonosi kérés)

1. **Aktív** — a motor kérdést tett fel, a válasz még nem érkezett be.
2. **Elszürkült** — megnyomás után azonnal, visszavonhatatlanul letiltva ugyanarra a futásra.
   Felirata jelezze, hogy rögzítve van és feldolgozás alatt áll (pl. „Rögzítve — feldolgozás alatt”).
3. **Eltűnik** — amint a következő progresszió-futás feldolgozta az eseményt és a döntés
   megváltozott. Az eltűnés a motor állapotából következik, nem a felület időzítőjéből.

**Azonnali visszajelzés:** a gomb elküldése után az API futtasson EGY progresszió-ciklust az adott
ügyre, és a válaszban adja vissza az új állapotot. Ez nem sérti a 2. pont elvét — az esemény
továbbra is a bemenet, a motor továbbra is az író —, csak a feldolgozást hozza előre, hogy ne kelljen
öt percet várni a visszajelzésre.

## 5. Külső hatás — megerősítő ablak

Ha egy vezérlő olyan lépést engedélyez, aminek **kifelé ható következménye** van (levél, üzenet,
foglalás, bármi, ami elhagyja a gépet), akkor:

- a gomb megnyomása után **megerősítő ablak** jelenjen meg, ami szövegesen leírja, **pontosan mi fog
  történni** (kinek, mit, milyen tartalommal), és csak külön megerősítésre folytatódjon;
- a rögzített eseményben `external_effect_ack: true` szerepeljen, hogy a napló megőrizze: a
  tulajdonos a következmény ismeretében hagyta jóvá.

**Az első körben a külső hatású vezérlők listája ÜRES.** A mechanizmus épüljön meg, de a motor
jelenleg a GATE 2 szinten áll, ahol nincs végrehajtó a külső akciókhoz. Egy gomb, ami levélküldést
ígér, de nincs mögötte küldő, rosszabb a semminél. A lista akkor töltődik fel, amikor a GATE 3
tulajdonosi döntéssel megnyílik.

## 6. Kötelező viselkedések

### 6.1 Idempotencia
A kliens minden elküldéshez generáljon `idempotency_key`-t. Ugyanazzal a kulccsal érkező második
kérés **ne** írjon második eseményt, és adja vissza az elsőnek az eredményét. Kétszeri koppintás
telefonon nem kivétel, hanem alapeset.

### 6.2 Verzió-ellenőrzés
A kérés tartalmazza a `case_version`-t. Ha az ügy időközben változott, a szerver 409-cel válaszoljon,
a felület pedig töltse újra a kártyát és mutassa az új kérdést — ne írja felül némán.

### 6.3 Elavult kérdésre adott válasz
Ha a `source_reference` már nem az utolsó futás, a válasz elavult: rögzíteni kell (a napló teljes),
de a felület jelezze, hogy időközben új kérdés érkezett.

### 6.4 Mobil és akadálymentesség
Érintőfelület legalább 44×44 px. A döntésre váró ügyeknél a vezérlő a **zárt** csempén is legyen
elérhető, ne kelljen kinyitni. Minden gombnak legyen szöveges címkéje (ne csak ikon), és a
letiltott állapot ne csak színnel legyen jelezve.

## 7. API

```
POST /api/cos/cases/:domain/:caseId/owner-action
body: { eventType, choice?, text?, sourceReference, caseVersion, idempotencyKey,
        externalEffectAck? }
→ 200 { ok, eventId, progressionRan: true, newDecision, newNextBestAction }
→ 409 { error: "case_version_stale", currentVersion, currentDecision }
→ 200 { ok, eventId, duplicate: true }   // idempotency hit
```

Bearer-token védett, mint a többi `/api/*`. A `domain` `personal|zst` — a két névtér sosem
keveredik, a route a domain szerint választ táblát.

## 8. Nem-scope

- Általános űrlapmotor vagy szabadon konfigurálható gombkészlet.
- Bármilyen kifelé ható művelet tényleges végrehajtása (GATE 3+, külön tulajdonosi döntés).
- A `case_progression_state` közvetlen szerkesztése a felületről.
- Tömeges műveletek (több ügy egyszerre) — előbb működjön egy ügyre.

## 9. Elfogadási kritériumok

A hat szokásos kapu (előre kihirdetve, ezeket futtatom és semmi mást):

- **(a)** `tsc --noEmit` zöld, a teszt-suite-tól **külön**.
- **(b)** kihagyott tesztek száma 0 — `ctx.skip()` és a csupasz `return` egyaránt PASSED-nek számít.
- **(c)** minden új teszt bizonyítottan PIROS a javítás előtti kódon, nyers kimenettel.
- **(d)** ellenőrzés az **éles adatbázis másolatán**, nem csak friss üres adatbázison.
- **(e)** a futtató a `package.json` `scripts.test`-jéből (marveen = vitest), nem feltételezésből.
- **(f)** ha van futtatható belépési pont, **futtasd le egyszer** és mutasd a kimenetét.

Plusz e feladatra specifikusan:

- **(g)** képernyőkép 390 px szélességen és asztali méretben, világos és sötét témában, a vezérlővel
  aktív és elszürkült állapotban egyaránt.
- **(h)** bizonyítsd méréssel, hogy a gomb **eseményt** írt és **nem** módosította sem a case sort,
  sem a progression state-et: az esemény beírása előtti és utáni `case_progression_state` sor legyen
  azonos, és az állapot csak a rákövetkező motorfutás után változzon.
- **(i)** idempotencia-teszt: ugyanaz a kulcs kétszer → egy esemény, második válasz `duplicate: true`.
- **(j)** elavult verzió teszt: 409, és a felület újratölt.

## 10. Megjegyzés a sorrendhez

A CompliFlow Increment 1 párhuzamosan fut a fullstackfejlesztőnél, más repóban — nincs ütközés.
Ez a feladat a frontendfejlesztőé, aki a Mission Control progression nézetet is építette
(kártya 969e5c3b).
