# v1.4 — kanonikus adjudikációs csomag és a vakítás-mérés

**Mi ez:** a §26 implementációs sorrend **29.** pontja (`canonical adjudication packet builder with
proactive/reactive schema parity`), a §1.4.3 szerint. Az auditban **M0** volt: az
`adjudicat|origin_guess|baseline_run|control_run` grep az egész `src/` + `scripts/` felett egyetlen
találatot adott, egy kommentet egy másik incidensről.

| | Előtte | Utána |
|---|---|---|
| Zöld teszt | 6578 | **6600** (+22) |
| Bukó teszt | 0 | **0** |
| `tsc --noEmit` | tiszta | tiszta |

Négy állítás pirosra járatva.

---

## 1. A modul két különálló feladata — és miért hiba összemosni őket

A §1.4 value gate azt kérdezi egy embertől, hogy a proaktív oldal olyat hozott-e létre, amit a
reaktív baseline nem. Ez az ítélet **értéktelen, ha a bíráló meg tudja mondani, melyik csomagot
melyik oldal írta** — és a §1.4.3 kimondja, hogy az origin label elrejtése **nem azonos** azzal, hogy
a vakítás működik:

> *A vakítás nem tekinthető bizonyítottnak pusztán attól, hogy az origin label el van rejtve; mérni
> kell, hogy a packet formája alapján az eredet visszakövetkeztethető-e.*

Ebből két külön feladat következik:

1. **Kanonizálás** — mindkét ág egy sémára képezve, olyan mező nélkül, amit csak az egyik oldal tud
   kitölteni. Egy csomag, ami `plannerTrace`-t visz, minden lényeges értelemben `PROACTIVE`-nak van
   címkézve, akármit mond az origin oszlop.
2. **Mérés** — a bíráló **tippeljen** az eredetre, a felfedés előtt, és a tippet előre regisztrált
   szabállyal kell szembeállítani a véletlennel.

A kettő összemosása az egész kockázat.

---

## 2. A kanonikus típusnak nincs origin mezője — nem rejtett, hanem nincs

A `AdjudicationPacket` típuson nincs `origin`, nincs `runId`, nincs `initiativeId`, nincs detektor-
vagy planner-mező. **Nem olvasáskor elrejtve — egyáltalán nincs rajta.**

Ez azért fontos, mert a §1.4.3 szabálya nem az, hogy „ne jelenítsük meg a proaktív-specifikus
mezőket", hanem az, hogy **ne is legyenek rajta, ha a reaktív oldalnak nincs ekvivalense.** Egy mező,
ami rajta van az objektumon, abban a pillanatban a képernyőre kerül, amikor valaki felvesz egy debug
dumpot.

A `parityViolations` a **nyers** objektumot ellenőrzi, a kanonizálás előtt, tehát egy véletlen spread
(`{...initiative}`) a bejáratnál bukik el, nem egy adjudikátor böngészőjében derül ki.

### A sorrend is eredet-jelzés

A §1.4.3 név szerint tiltja a `source-specific ordering`-et. Ha az egyik ág a bizonyíték-hivatkozásokat
legújabb-elöl adja, a másik legrégebbi-elöl, akkor **a sorrend maga az origin label**, más betűkkel
leírva. A kanonizálás ezért rendezi a `evidenceRefs`-et és a `timelinessRelevantTimestamps`-et.

Egy adjudikátornak nem kell értenie, mi az a `plannerTrace` ahhoz, hogy észrevegye: a csomagok felén
van egy mező, amit a másik felén soha nem lát. **Ez pontosan az az eredet-következtetés a csomag
formájából, amit a §1.4.3 tilt.**

---

## 3. A felfedés egészre megy, nem csomagonként

A `unblind` megtagadja a felfedést, amíg **bármelyik** csomagra hiányzik az ítélet. Ok: egy csomag
felfedése megmondja a bírálónak, hogy állt a dobás, és onnantól minden további ítélete tájékozott —
a minta fele lenne vak, és egészként jelentődne.

Egy felfedett session utáni ítélet-rögzítést a modul visszautasít. A rögzített ítélet triggerrel
végleges: sem módosítani, sem törölni nem lehet. Egy ítélet, amit a mérés eredményének ismeretében
lehet átírni, nem bizonyíték.

És a rubrika: ha a rögzítés rubrika-verziója eltér a sessionétől, elutasítás. A V4-F13 név szerint
FAIL-ként sorolja a *„rubric changes case by case"*-t.

---

## 4. A teszt fail-closed — mindkét irányba

Három kimenet, és **csak egy** közülük PASS:

| Kimenet | Mikor |
|---|---|
| `BLINDING_EVIDENCE_INSUFFICIENT` | kevesebb ítélet, mint az előre regisztrált minimum |
| `VALUE_GATE_ADJUDICATION_CAPABILITY_GAP` | az eredet szignifikánsan 50% fölött kitalálható |
| `VALID` | megvan a minta **és** a teszt nem talál chance fölötti következtetést |

**A minta-ellenőrzés megy előbb**, és ez nem sorrendi ízlés. Egy szignifikáns p-érték kilenc csomagon
nem a vakítás elromlásának bizonyítéka, hanem kilenc csomagé. A capability gap jelentése ott **hamis
riasztás lenne, egy statisztikai teszt tekintélyével.**

---

## 5. A power-számítás — és amit kihozott

Egyoldali exact binomiális teszt, `p0=0.5`, `alpha=0.05`, `p1=0.7`, cél-power `0.80`. A számítás log
térben megy: néhány száz fős mintánál a közvetlen szorzat alulcsordul, egy alulcsordult p-érték pedig
**szignifikáns eredménynek látszik.**

A modul kiszámolja, és a teszt rögzíti:

| n | 37 | 38 | 39 | 40 | 41 | 42 | 43 |
|---|---|---|---|---|---|---|---|
| power | **0.807** | 0.775 | 0.740 | **0.807** | 0.776 | 0.836 | 0.808 |

**A power nem monoton n-ben.** A kritikus érték egész darabszámokban ugrik, miközben n folytonosan
nő, tehát egy **nagyobb** minta lehet **kevésbé** erős, mint egy kisebb.

Ez azt jelenti, hogy a „37, felfelé kerekítve a biztonság kedvéért" nem egészen pontos történet:
a 38 és a 39 egyaránt **rosszabb**, mint a 37. Amitől a 40 védhető, az nem az, hogy nagyobb — hanem
az, hogy **előre regisztrált**: a tesztet azon az n-en értékeljük, amit a mérési ablak megnyitása
előtt befagyasztottunk, nem azon, ahová a gyűjtés éppen eljutott. A V4-F14 pontosan ezt nevezi meg
FAIL-ként: *„a minta-minimum megváltoztatása azután, hogy az eredmények ismertek".*

A regisztráció digestje beleíródik minden eredménybe, hogy egy későbbi olvasó meg tudja állapítani:
az a szabály ítélte-e meg, amit befagyasztottak.

---

## 6. Amit ez NEM old meg

- **A 30. pont** (`origin-guess telemetria + statisztikai vakítás-hatékonyság mérés`) mostantól
  **megépült** ebben a modulban — de a *mért adat* természetesen éles adjudikációból jön.
- **A 31. pont** változatlanul nyitva: nevesített, **független ember** adjudikátor kell, nem LLM és
  nem a Proactive Core kimenetét előállító rendszer. Ez szervezeti döntés, nem kód. A modul annyit
  tud, hogy az `adjudicator_id`-t rögzíti — hogy az az azonosító emberhez tartozik-e, azt kód nem
  tudja eldönteni.
- **A `blinding_validation_min_packets`** most már **levezethető**, nem kézzel beírt szám — a V4-F13
  ezt („arbitrary hand-entered value without documented power derivation") FAIL-ként sorolja.

---

## 7. Mi jön ezután

A §26-ból kódolható maradék: 8. (Reader evidence extension), 11. (Initiative → Case promóció),
14–16. (proaktív sweep — a határidő-index és a continuation-jelzés már megvan hozzá), 17–18.
(stall/anomália), 20. (előkészítés-tervező), 22. (`PreparedInitiative`), 32. (replay/eval
instrumentáció a független reaktív kontroll összehasonlítással — a 26. és a 29. után ez már
összeköthető).

Változatlanul **nem** kezdhető el itt: 3–5. (éles adat) és 31. (nevesített ember).
