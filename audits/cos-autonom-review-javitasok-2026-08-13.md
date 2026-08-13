# A 2026-08-13-i review javításai — mi változott, és mi maradt

**Kinek szól:** Istvannak, és bárkinek, aki a review-jelentés
(`cos-autonom-code-review-2026-08-13.md`) után azt kérdezi: *na és mi lett belőle?*

**Egy mondatban:** a review 68 találatából lényegében mind javítva, a fa 6078 zöld teszttel és
tiszta típusellenőrzéssel áll — és a javítás közben előjött egy hiba, amit a review maga sem talált
meg, mert két hazugság fedte egymást.

---

## 1. A mérés

| | Kiindulás (a review napján) | Most |
|---|---|---|
| Zöld teszt | 5889 | **6078** (+189 új) |
| Bukó teszt | 4 | **4 — ugyanaz a négy** |
| `tsc --noEmit` | tiszta | tiszta |

A négy bukó teszt változatlanul: két „nem írható könyvtár"-szimuláció (rootként futtatva nem lehet
nem-írhatót előállítani), az installer ERR-trap, és a scheduler-retry. Mind a négy a
változtatások **előtt is ugyanígy bukott** — külön lemérve, nem feltételezve.

**Minden új állítás pirosra van járatva.** Nem elég, hogy zöld: a javítás kikapcsolásával a hozzá
tartozó tesztnek bizonyítottan buknia kell. Ahol ez a jelentés „red-proofolva"-t ír, ott ez tényleg
lefutott.

---

## 2. A hét legfontosabb változás

### C1 — a céges küldőajtó
Az `approveAndDispatchZst` soha nem adta át a case típusát, így a fokozat-ellenőrzés `UNKNOWN`-nal
futott, ami PREPARE, ami nem küldhet. A típus mostantól a ledger-sorból jön, ahogy a privát úton.
**A fontosabb rész a teszt:** az ajtó tesztkészletében addig egyetlen eset sem állított sikeres
küldést — csak elutasításokat. Most van sikeres-küldés teszt, és ez az, ami a jövőben észreveszi, ha
az ajtó megint befagy.

### A1 + A2 + A3 — a tulajdonosi válasz jelentése és élettartama
Egy gyökér, három arc, egy javítás:
- **Jóváhagyás mostantól EGY dolog:** `OWNER_DECISION` + `YES`. Addig bármi, ami nem a „NEM" string
  volt — szabad szöveges megjegyzés, meg nem parsolható payload, bármelyik másik gomb — jóváhagyásnak
  számított.
- **A válasz egyszer fogyasztható és időben korlátos.** A run-főkönyv a jelölő
  (`consumedAnswerEventId`), és csak az aktuális állapot-epizód utáni események jönnek szóba. Egy
  évvel korábbi IGEN nem hagyhat jóvá egy tavalyi kérdésre hivatkozva egy mai kérést.
- **A válaszszókincs kapott jelentést.** `OPTION_INTENTS`: minden gomb, amit a felület kirajzolhat,
  megkapja a maga szándékát (PROCEED / REFUSE / HOLD / ABANDON / INFORM / UNMAPPED). A „Lemondjuk"
  többé nem lépteti a tervet. Amire nincs végrehajtó (`ASK_OTHERS`, `GET_QUOTE`, `SPECIFY`),
  az kimondottan `UNMAPPED` — rögzül, de nem hazudik cselekvést. Egy drift-őrző teszt bukik, ha
  valaki új gombot vesz fel a listára és elfelejti megmondani, mit jelent.

### E1 + E2 — a kimenő állapotgép versenyei
Türelmi ablak a SENDING-recovery elé (egy úton lévő küldést nem lehet „elhagyottnak" olvasni), és
minden állapotátmenet feltételhez kötött (`WHERE status = ?`), a 0 változás pedig konfliktus, nem
csend. A dupla-kattintás elleni claim egyedi runId-t kapott, tehát végre tényleg szerializál.

### Z1 — a céges jóváhagyás lejárata
Egy jóváhagyás addig örökre és korlátlanul érvényes volt — élő teszttel igazolva, hogy egy évvel
később ugyanaz a payload újra kiment. Mostantól a privát oldal TTL/plafon alapértékein megy át.

### A5 + A7 — a motor jogosultságai
A letiltott-progresszió ág többé nem engedi az ENGINE-t lezárni egy ügyet, amit nem ő vezérel (ez a
2026-08-09-i „72 hamis lezárás" újra beengedése lett volna), és a vészleállító végre megállítja a
progression-motort is, nem csak a küldést.

### A4 — a jóváhagyás identitása
A `resolved_by` többé nem a request bodyból jön: az auth-kapu által ismert principálhoz kötődik.

### P1 + P2 — a radar egyetlen célja
A `markNotified` a riasztás **után** fut (addig egy crash véglegesen elnyelte a találatot), és az
eMAG-adapter dob a hálózati hibán ahelyett, hogy „0 találat"-ként adná vissza — az utóbbi hálózati
hibánként egy hamis újra-riasztást okozott ugyanarról a változatlan ajánlatról.

---

## 3. Amit a javítás közben találtunk (a review sem látta)

Az **A18** javítása — „a `progressionRan` mondja meg az igazat" — azonnal kibuktatott egy hibát,
amiről addig senki nem tudott:

A Mission Control owner-action a ciklus után visszaolvasta az új állapotot, és a
`next_best_action_json`-t a `case_progression_runs` táblától kérte. Az az oszlop a
`case_progression_state`-en él. A lekérdezés tehát **minden owner-action-nél dobott** — a `try`-on
belül, ahol a `catch` „motorhiba"-ként könyvelte el. A hardcode-olt `progressionRan: true` pedig
elfedte. Vagyis az azonnali visszajelzés, amiért ez a vezérlő létezik, **soha egyszer sem működött**,
és semmi nem szólt, mert a két hazugság fedte egymást.

Ez a legjobb érv amellett, hogy miért érdemes az „úgyis mindig igaz" mezőket igazra cserélni: nem a
mező a nyereség, hanem az, ami mögüle előbújik.

Regressziós teszt rögzíti (`cos-routes-review-2026-08-13.test.ts`).

---

## 4. Két helyen szándékosan mást csináltunk, mint amit a review javasolt

- **A14 (claim a ciklusra).** A meglévő `tryClaimProgression` **esedékességhez** kötött — az a
  dolga, hogy ütemezzen. Az owner-action viszont kézi trigger: az ügy nincs ütemezve, és soha nem is
  lesz. Ha ezt használtuk volna változatlanul, a route majdnem mindig megtagadta volna a ciklust, és
  ezzel csendben visszanyitotta volna a versenyt, amit be akart zárni. Ezért kapott egy
  `requireDue: false` változatot: **ugyanaz a lease, kölcsönös kizárásra, jogosultság-ellenőrzés
  nélkül.**
- **E20 (`approvalVersion` félrevezető név).** Az átnevezés két főkönyvet és az AC-21 audit-lekérdezéseket
  érintené, viselkedési nyereség nélkül. Kommentben rögzítve maradt.

---

## 5. Amit NEM oldottunk meg — kimondva

- **`reconcile.ts` maradék `catch { return null }` blokkjai** (`missingCheckpoint`, `connectorDown`,
  `corporateInPersonal`, `duplicateSendAttempt`, `stalledCampaign`, `repeatedFollowUp`,
  `cursorBatchMismatch`, `zstFrozenCases`, `stagnantCases`, `awaitingOwnerTooLong`). Ugyanaz a
  vakság-osztály, mint az E10, de több közülük **jogosan** tapogat opcionális táblákat, amelyek
  hiánya egy részleges telepítésen nem hiba. Táblánkénti döntés kell hozzá: melyik kötelező. Külön
  találat, nem vak söprés.
- **`revokeAuthorizationsForAction`-nek nincs éles hívója.** A vészleállító globálisan visszavon; a
  per-akció visszavonás (kampány-visszavonáskor, jóváhagyás-visszahúzáskor) bekötetlen. Ez ugyanaz a
  „megépült, nincs bekötve" minta, amit a review a 3. keresztmetszeti pontban nevez meg.
- **A fokozat-létra előléptetése (A10)** továbbra sincs éles íróval: a fokozatemelés kézi
  SQLite-szerkesztés. Biztonságos irányú (a rendszer nem tudja magát előléptetni), de a „graduated
  autonomy" a checken túl nincs megépítve. Tulajdonosi végpont kell hozzá — ez termék-döntés, nem
  hibajavítás.
- **`gmail-history-guard.ts` továbbra sem él** — de most már ezt a fájl fejléce ki is mondja, hogy
  egy audit ne számolja az AC-28-at teljesítettnek egy őr alapján, ami ma semmit nem őriz. Akkor kell
  bekötni, amikor a history-poller landol.

---

## 6. Ami továbbra is igaz a go-live-ról

A review keretezése nem változott: a javítások **előtt** sem volt éles kockázat a magas súlyú
találatok többsége, mert a konfiguráció inert (gmail READ_ONLY, a tick-hurok nem kap kimenő adaptert,
a progression shadow/internal módban jár). A javítások azt változtatják meg, hogy **mi történik majd
azon a napon**, amikor a write-consent, illetve a `progression_mode='live'` bekapcsol.

A három kapu, amit a review javasolt, most így áll:

- **A Gmail READ_WRITE váltás előtt:** C1, Z1, E1, E2, Z3, E7, E8 — **mind kész.**
- **A `progression_mode='live'` előtt:** A1, A2, A3, A5, A7, A4 — **mind kész.**
- **A céges könyvelés pontossága:** Z4 (NBSP-összegek), Z5 (bankszámlaszám-capture), Z7–Z9 —
  **mind kész.**

Ami a go-live előtt továbbra is nyitva marad, az nem hiba, hanem hiányzó funkció: a fokozat-létra
tulajdonosi kezelőfelülete (A10). Amíg az nincs, a fokozat kézzel állítódik, és ezt tudni kell.
