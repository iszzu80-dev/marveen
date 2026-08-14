# APG 1.8 — teljes spec-konformancia felmérés (mind a 8 munkacsomag)

**Dátum:** 2026-08-13 · **Ág:** `claude/costops-agp-lean-review-mksxlj`
**Spec:** `docs/apg/apg-1.8-lean-fejlesztesi-es-celarchitektura-spec-2026-08-09.md` (4470 sor)
**Kódállapot:** `marveen-apg-kernel` @ `3157dd8` + `marveen-private` munkafa, azaz a 08-12/08-13-i remediáció **után**
**Módszer:** három párhuzamos, bizonyíték-alapú átvizsgálás (§7–10 / §11–14 / §15–29+§35), minden állítás fájl:sor hivatkozással; a kritikus leletek empirikusan ellenőrizve.

Ez a dokumentum leváltja a `marveen-apg-kernel/audits/apg-1.8-gap-map.md` (08-09) képét, amely több ponton elavult. Az eredmény alapján készült a `docs/apg/apg-1.9-...md` szerkezeti átalakítás.

---

## 0. Egymondatos állapot

**Nyolc munkacsomagból nulla elfogadva.** A kernel evidencia-gerince (append-only store, migrációk, determinisztikus checkpoint-kiértékelés, receipt-lánc) valódi és jól megépített; a fölé tervezett vezérlő réteg viszont vagy hiányzik, vagy megvan, de **nincs éles hívója**. Ami ma valós Marveen-munka ellen fut, az egy kézzel indított szkript hét átmásolt kártyán.

## 1. A vezérlő minta, ami mindenhol ismétlődik

Nem a kód minősége a probléma. Három visszatérő állapot van, és ezek megkülönböztetése fontosabb minden más megállapításnál:

| Állapot | Mit jelent | Példa |
|---|---|---|
| **Éles úton** | Production kód hívja | `store.append` edge-validáció; kanban-dispatch; a checkpoint-fold |
| **Kód, hívó nélkül** | Production alakú, de senki nem hívja | `attempt_transition` (állapotgép), `executor_registry` (registry), `graph_projection.project_receipt` |
| **Csak teszt** | Egyetlen importálója a saját tesztje | `claim_verification` (532 sor), `token_origin.attribute` |

A legdrágább példa: a `claim_verification.py` egy helyes, jól tesztelt, most frissesség-dimenzióval is ellátott bizonyíték-motor, amelynek **egyetlen importálója a `tests/test_claim_verification.py`**. A UI eközben saját, jóval gyengébb szabállyal ad `VERIFIED_CURRENT`-et.

## 2. Munkacsomagonként

| WP | Terület | Állapot | A meghatározó hiány |
|---|---|---|---|
| **WP1** | Executable Verification Foundation | **~2/44 acceptance-pont** | Gate Profile Resolver egésze; registry nincs a dispatch-úton; Falsification Runner nulla; a §9 húsz negatív kontrolljából nulla |
| **WP2** | Product Identity + Currentness | **~25%** | `product_id` sehol a kernelben; nincs currentness-állapotgép, nincs supersede; a dashboard megkerüli a claim-motort |
| **WP3** | Execution Identity + Provenance | **hiányzik** | Nincs execution principal, nincs producer≠accepter szerep; a busz önbevalló, egy megosztott bearer token |
| **WP4** | Context Router + Fresh Verifier | **részleges, más dolog** | A packet valódi, de **a törzse sosem jut el az ügynökhöz** — csak metaadat tárolódik; nincs verifier, nincs risk-alapú policy |
| **WP5** | Change Runner | **runnerként hiányzik** | `transitions.py` korrekt, de `attempt_transition`-nek nulla éles hívója; egy lineáris gép, nem profilból épített gráf |
| **WP6** | Kanban + Dispatch | **részleges** | A dispatch valódi és receiptelt, a `done_not_accepted` projekció megvan; **de nincs élő betáplálás a kernelbe**, és a `done` egy ellenőrizetlen curl |
| **WP7** | Safe Delivery | **hiányzik** | Nincs delivery candidate, deployment authority, immutable target, rollback receipt; a `deployment`/`runtime` link hard-wired UNKNOWN |
| **WP8** | Product LCM Closed Loop | **hiányzik** | Nincs hurok, nincs termék-review |

Keresztmetsző fejezetek: a **§24.0 kompozicionális mód** (gate-maturity tengely) nem létezik — a mód egyetlen skalár, scope szerint feloldva. A **§21 gate charter**, **§22 gate-telemetria**, **§23 economics lifecycle**: nulla találat mindkét repóban.

## 3. Amit biztonsági szempontból ki kell emelni

**3.1 Az „enforced" mód egyetlen tényleges blokkoló kontrollja böngésző-oldali JavaScript.** A `web/apg.js:1067-1110` az archiválást feltételhez köti; a szerver `POST /api/kanban/:id/archive` végpontján **nincs APG-ellenőrzés**. Egy `curl` a megosztott tokennel megkerüli. A §25 enforced módban fail-closed viselkedést ír elő.

**3.2 A scope-override végpont engedi az önlefokozást.** A `PUT /api/apg/scope-overrides` bármely bearer-tokent birtokló hívónak — és minden dispatchelt ügynök megkapja a tokent (`kanban.ts` a `store/.dashboard-token`-ből olvas) — engedi, hogy a saját kártyáját vagy projektjét kivegye enforced módból, egyetlen szabadszöveges indoklással; az `updated_by` ellenőrizetlen. A §24.0.5 ezt kifejezetten tiltja („no manual blanket downgrade").

**3.3 Az emberi jóváhagyás nem emberi.** A `resolveApproval(...,'dashboard',...)` szerveroldalon a felületet nevezi meg, nem a személyt; a generikus approvals-útvonal pedig a kérés törzséből veszi a `resolved_by`-t — pontosan az a minta, amit a §11.4 nevesítve tilt. A kód kommentje maga ismeri el, hogy a védelem „nem tud megállítani egy hazudó klienst".

## 4. Két lelet a saját remediációnkról

**4.1 Az ERROR-javítás kihagyta az élő utat — javítva.** A `9737adb` a `checkpoints.evaluate`-et és mindkét replay-foldot javította, de az `a1_pilot._compute_verdict`-et nem, pedig a `store.py` saját kommentje név szerint említi az „s2/a1 twins"-t. Ez az élő megfigyelési út: ott egy check-szintű ERROR továbbra is PASS futás-verdiktet adott. Javítva a `bcdee14` commitban; a fold-teszt mostantól mind a hármat egy helperen hajtja át.

**4.2 A fixture-pack részleges.** A `APG_METHODOLOGY_PACK_ROOT`-ot a fixture-packre állítva **93 error + 13 fail** marad (a 124+9-ből): a négy profilból kettő hiányzik (`product-surface-launch`, `safe-release`), és az FSM-ből a régi tesztek által várt állapotok. Amit szállítottunk, annyit tudott, amennyit a commit állított — az új hermetikus tesztek futnak —, de a meglévő tesztbázis gépfüggetlenné tételéhez a packet be kell fejezni. **Amíg ez nincs meg, a fenti acceptance-pontok egyike sem ellenőrizhető a szerző gépén kívül.**

## 5. Hol elavult a korábbi gap map (08-09)

- „ERROR MISSING / `NOT_APPLICABLE` nincs átnevezve" → **téves**: a `RESULT_VALUES` a teljes ötértékű szótár, az átnevezés kész.
- „Gate Executor Registry: MISSING" → **most PARTIAL**: létezik a teljes §7.3 kontraktus-alakkal. Az továbbra is igaz, hogy semmi nem dispatchel rajta.
- „WP6 UI projection hiányzik" → **téves**: `src/apg/ui-projection.ts` (1023 sor) valódi, tesztelt projekció, cross-repo enum-kontraktus teszttel.
- „`claim_verification.py`-ben van supersede reláció" → **akkor is, most is téves**: nincs `supersedes`/`superseded_by` sem a mezőkben, sem a migrációban.

Egy további megjegyzés: a cross-repo szótár-kontraktus teszt (`apg-projection-contract.test.ts`) `if (!existsSync(kernel)) return` módon némán átmegy, ha a kernel nincs kicsekkolva — vagyis a „két repó, egy kontraktus" garancia csak azon a gépen érvényesül, ahol mindkettő megvan.

## 6. Sorrend a legjobb hozam/ráfordítás szerint

1. **Registry az élő kiértékelési útra** (M) — három meglévő, inert darab válik élővé; előfeltétele a HF-01-nek és bármely második executornak.
2. **Gate Profile Resolver + obligation-modell + applicability receipt** (L) — enélkül a §7.2 2–8. szabálya, az ADVISORY szint és a §8 „PASS csak ha minden kötelező executor futott" nem kifejezhető.
3. **Három élő úti integritás-lyuk** (S) — az a1 ERROR-fold *(kész)*, a néma overlay-elnyelés (`except: continue`), és a pack-provenance (melyik gate-halmazzal futott a run).
4. **Startability executor** (M) — önálló, nem függ a kalibrációs hegytől, és valódi történelmi hibát zár le.
5. **Acceptance-control séma (`red_condition`)** (S–M) — a §34 miatt minden későbbi WP acceptance ezen áll.
6. **`product_id` + currentness + supersede** (M) — és **a dashboard saját `VERIFIED_CURRENT` szabályát törölni kell**, különben a javítás nem tart.
7. **Élő betáplálás a kernelbe** (M) — enélkül az observe mód nem mér, és a Stage 1 ablaka soha nem gyűlik össze.
8. **Fixture-pack befejezése** (S) — keresztmetsző: enélkül semmi nem ellenőrizhető máshol.

A §9.2 kalibrációs lánc szándékosan nincs ebben a sorrendben: a v1.9 kiemelte a WP1-ből (WP9–WP11, `OBSERVE_ONLY`), mert ~35 acceptance-pontjával egymaga blokkolta a fenti olcsó tételeket.
