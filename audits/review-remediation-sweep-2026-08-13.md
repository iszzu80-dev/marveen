# A 08-12-es teljes review remediációja — négy hullám, két repó

**Dátum:** 2026-08-13 (négy hullám) · **Ág:** `claude/costops-agp-lean-review-mksxlj`
**Előzmény:** `audits/costops-lean-optimization-full-review-2026-08-12.md` és `marveen-apg-kernel/audits/apg-1.8-wp1-review-2026-08-12.md` (a review maga)
**Kérte:** Istvan — „állj neki a javításoknak", majd „fuss meg egy javító kört, dokumentald és pushold fel"

---

## 0. Mi zárult le

A review **mind az 5 kritikus, mind a 17 HIGH és 21 MEDIUM/LOW** találata javítva van, és a félretett **hat tulajdonosi döntés is megszületett és végrehajtásra került** — összesen ~270 új regressziós teszttel, négy hullámban:

| Hullám | Commitok | Tartalom |
|---|---|---|
| 1. (kritikus+high, mag) | `a2bd11c`, `3c7fe1b`, `b762478` (private) · `9737adb` (kernel) | számla-folyamat, collectors, vészleállító, kernel ERROR+pack-root |
| 2. (high, élesítés) | `b0064d3`, `1ec9b85` (private) | routing-sweep élesítés, státusz-szótár |
| 3. (medium sweep) | `19533c1`, `e005cce`, `0df1f69` (private) · `befef8c` (kernel) | 21 medium/low négy csomagban |
| 4. (tulajdonosi döntések) | e dokumentum commitjai (private) · `3157dd8` (kernel) | budget-bázis, fx-migráció, knob-törlés, restore, P2-B határ, evidencia-címkék |

Tesztbázis a sweep végén: **marveen-private** 6100+ teszt zöld (a 3 ismert root-sandbox műtermék mellett — chmod/ERR-trap root alatt, a review 0. szakasza dokumentálja), `tsc --noEmit` tiszta. **Kernel** 485 teszt, a 124+9 környezet-csatolt bukás halmaza bájtra azonos a review-előtti baseline-nal; a determinisztikus mag most már 44+ hermetikus teszttel fut bármely gépen.

## 1. A minta, amit a javítások követtek

A review megfigyelése az volt, hogy a hibák a modulok közötti **varratokon** ülnek: fél helyre landolt javítások, két példányban élő logika, kapcsolók olvasó nélkül. A remediáció ezért nem tünetenként foltozott, hanem a varratot szüntette meg:

- **egy fogalom — egy definíció:** az import-státusz partíciót a szótár gazdája (`collectors/types.ts`) definiálja, mind az öt fogyasztó onnan olvassa; az egyenlő-confidence összegzést a `ledger.ts` egyetlen exportált seam-je (`resolveSourceTotal`) adja mind a négy felületnek; a peak-since-top-up logika egy helyen él.
- **a guard oda kerül, ahol az összes út átmegy:** a lezárt-hónap védelem a sync-be, az overlay-kapuzás a `resolveRuntimeModel`-be, a lock a collector-sync törzsébe.
- **a kapcsoló vagy kapcsol, vagy nincs:** `automaticFallback` és `limitedThreshold` bekötve; a halott example-scaffoldok és — a negyedik hullámban — a három olvasó nélküli routing-knob törölve, a plafonok kód-konstansként maradnak.

## 2. Harmadik hullám (medium sweep) — mi változott

### CostOps core (M1, M4, M5, M6, M7, M8)

- **M1** — a dec9ae64-es több-számlás összegzés egyetlen seam-je: `ledger.ts` exportálja a `resolveSourceTotal`-t (feloldás+összegzés), a `reconciliation.ts`, `forecast-capture.ts` és `export.ts` másolatai megszűntek; egy két-számlás hónap most minden felületen ugyanazt az összeget adja, és a reconciliation fejléce újra igazat állít.
- **M4** — a `'invoice'` nem lett legalizált kategóriaként (az proveniencia, nem költség-kategória): a számla/email/manual sorok a forrás regisztrált `source_type`-jából vezetik le a valódi kategóriát (`usage` → run-rate forecast, minden más → `subscription`, teljes összeg — a választás sosem fabrikálhat a számlázotton túli költést); az API validált `charge_category` felülírást kapott; a legacy `'invoice'` sorok re-ingestkor gyógyulnak.
- **M5** — az email-ingest confidence-értéke a `CostConfidence` unionra validált; az elírás per-entry hibaként jön vissza, nem néma lefokozásként.
- **M6** — a `no_data` a pending-szűrés *után* számolódik: csak-pending hónap nem jelent többé fabrikált 0-t, és a hó/hó delta sem hazudik esést.
- **M7** — a `costops-config.json` és az fx-config írása atomi (`atomicWriteFileSync`): félbeszakadt írás nem törli le az összes budget/fix költség definíciót.
- **M8** — az ajánlás accept/dismiss csak `open` státuszból léphet; minden más 409 — az emberi döntés nem billenthető vissza némán. A store megkapta első dedikált tesztfájlját (12 teszt).

### CostOps ops/collectors (M1, M2, M3, M4, M5, M7, M8)

- **M1** — a „peak" az utolsó megfigyelt feltöltés (RISE) óta mért csúcs (`peakSinceLastTopUp`, a `deriveMtdSpend` drop/rise fegyelmével): $50-es múlt után $5-ös feltöltésből $4 = 20%, nem 92%.
- **M2** — a heti ablakos limit-snapshotok 10 napos staleness-horizontot kaptak (7 nap ablak + 3 nap türelem, a `capacity.ts` konvencióját skálázva): elavult olvasat `usage_pct: null` + `stale: true`, riasztás nem tüzel belőle.
- **M3** — az `alerts-capture` a store `reconcileAndPersist`-jét hívja (egyetlen tranzakció); a duplikált sor-mappelés és a második `listAlerts` export megszűnt.
- **M4** — a DeepSeek/Codex sync a közös per-provider import-lock alatt fut: versenyző második sync `locked`-dal tér vissza, fetch és írás nélkül; a kézi `upsertLine`/`recordRun` másolatok a runner megosztott helpereibe olvadtak.
- **M5** — az alert-monitor csak 200-as, elvárt alakú válaszra tekinti magát lefedettnek (különben a korábbi state marad — nincs dupla push visszatéréskor); a `blocked` súlyosság bekerült a push-szűrőbe; a state-írás atomi (`os.replace`); a halott `covered_prefixes` törölve. A szkript invariánsait source-scan teszt pinneli.
- **M7** — a `GITHUB_BILLING_USER` sync-időben olvasódik és hiánya pontos, cselekvőképes blockert ad URL-építés előtt.
- **M8** — a Render sync egyetlen fetch-ből származtatja a sorokat ÉS a detail-t (nem térhetnek szét), és lockolt futás alatt egyáltalán nem hív API-t.

### Lean optimization (M1, M2, M3-audit, M5, M7, M8)

- **M1** — a `resets_at` végig bekötve: a tiszta réteg a saját reset-idején túljutott vagy elavult túllimit-olvasatot `unknown`-ra fokozza (nem pinnel örök `blocked`-ot); a `usageFigure` felszínre hozza a perzisztált oszlopot; a runner a valós provider-adta resetet adja a climb-backnek (a hamis „nem megfigyelhető" komment törölve).
- **M2** — a `limitedThreshold` a sweepből a primary és a jelöltek állapot-levezetéséig ér; a fantom-útvonalra hivatkozó komment javítva.
- **M3 (audit-fele)** — új `optimization_config_audit` append-only tábla a decisions-minta szerint: minden settings-PATCH, emergency-disable és flag-propagáció egy-egy sort ír (verzió from→to, master/modul delta-összefoglaló). A spec „minden configváltozás auditált" követelménye innentől áll.
- **M5** — az `insufficient_evidence` döntés actionable verdikt érkezésekor újranyílik; a lejárt `deferred_until` olvasáskor `new`-ra promotálódik (a legkevésbé invazív seam — minden fogyasztó a listán át olvas); a határozatlan halasztás sosem.
- **M7** — az `ArtifactRef.note` 500 karakterre korlátozott (saját `MAX_NOTE_CHARS` — a szekció-cap aránytalan lenne az 1200-as excerpt-cap mellett), és beleszámít az inline-hányadba: excerpt+note párosítással sem kerülhető meg a méretfegyelem. A checkpoint-validátor a `reference_` prefix révén módosítás nélkül örökli.
- **M8** — a hiányzó `config-examples/capacity-routing-config.example.json` committolva (safe-by-default, `enabled:false`); a sosem hívott example-scaffoldok törölve.

### APG kernel (M1–M5, M7, M9, L2 — `befef8c`)

- **M1–M3** — a registry idempotens-vagy-hibázik (teljes kontraktus-összevetés, callable-identitással — a `compare=False` miatt két eltérő callable egyenlőnek látszott), minden gate-et validál írás előtt (nincs fél-állapot), és `run` nélküli kontraktust nem fogad el (gate nem számíthat végrehajthatónak mögötte).
- **M4** — a `register_builtin_executors` nem nyel el `ValueError`-t: ami dob, az valódi konfliktus, és terjed.
- **M5** — a CONFLICT-út ugyanazt a payload_digest-dedupot kapta, mint az elfogadó út: rögzített konfliktus retry-a no-op, nem crash az immutábilis-sor guard ellen.
- **M7** — a `VERIFIED_CURRENT` frissesség-dimenziót kapott (spec §10.2/§10.3, §26/8, §27.6 stale-receipt trust-attack): 7 napnál idősebb authoritative receipt `STALE`-re oldódik (a hét-státuszos szótár zárt — nem született új státusz); a default konzervatív választás, a spec nem nevez számot, a konstans docstringje ezt rögzíti.
- **M9** — receipt-kiválasztás `created_at DESC, rowid DESC` tiebreakkel (a `transitions.current_state` mintája).
- **L2** — a `STATUS_VALUES` végre tartalmazza az `AMBIGUOUS`-t, amit a modul maga emittál.

## 3. A hat tulajdonosi döntés — meghozva és végrehajtva (negyedik hullám)

A harmadik hullám hat tételt tett félre, mert nem korrektségi, hanem szándék-kérdések voltak. Istvan mind a hatra rábólintott a javasolt irányban; a végrehajtásuk ebben a hullámban zárult le.

**1. Budget-bázis (COS-CORE-M3) — a headline a kanonikus, minden hatókörre.**
A keret-figyelmeztetést az operátor a headline költés-szám mellett olvassa ugyanazon a képernyőn, tehát azzal kell egyeznie; és a „részek összege = egész" invariánsnak állnia kell. A `global` hatókör mostantól ugyanazokat az `all_sources` sorokat összegzi, mint a provider/kategória/forrás; a `BudgetStatus` új `spend_basis` mezője megnevezi a bázist, a `product`/`agent` pedig őszintén `not_resolved`. Ellenőrizve, hogy a két bázis **ma sem** egyenértékű (eltérő feloldó; a manual források kiesnek, ha a providernek van provider-derived forrása; a plan-estimate sorok kezelése is eltér) — a példa-fixtúrán a globális 18 000-ről 40 000-re javult, és a provider-részek pontosan kiadják.

**2. Fx-forrás (COS-OPS-M6) — nem volt nyitott kérdés, csak befejezetlen migráció.**
A `fx-config.ts` már migrál: ha nincs `costops-fx.json`, az örökölt render-pricing értékeiből veti el. A kanonikus otthon tehát ki volt jelölve — az Anthropic, GitHub és DeepSeek collector viszont még a render-pricingből olvasott. Mindhárom átállt a `loadFxRates()`-re, a guard-üzenetek a valódi forrást nevezik meg, a render-pricing fx-mezői pedig „legacy migration seed only" jelölést kaptak. Ezzel a Render-config kitakarítása nem nullázhatja többé három collector árfolyamát.

**3. A három halott routing-kapcsoló (OPT-H2 maradéka) — törölve.**
`trustedProvidersOnly`, `maxFallbacksPerProfile`, `maxAutomaticFallbacksPerDispatch` eltűnt a típusból, a defaultokból, a normalizálóból, az audit-kulcslistából és a committolt example-ből; a plafonok kód-konstansok maradnak (`MAX_AUTO_FALLBACKS_PER_PACKAGE = 1`, `MAX_FALLBACK_CANDIDATES = 2`), és egy komment rögzíti, hogy ez szándékos — ne kerüljenek vissza configként. A normalizáló mezőnkénti whitelist, így a lemezen maradt régi kulcsok migráció nélkül lekopnak; a `writeOptimizationConfig` mostantól normalizálva írja a routing blokkot, hogy egy PATCH ne csempészhesse vissza őket. Az eltérés a spec „javasolt sémájától" az as-buildben dokumentálva (a követelmény-dokumentumot nem írtuk át).

**4. `lastEnabledConfiguration` restore (OPT-M4) — megépítve.**
A master visszakapcsolásakor, ha van tárolt konfiguráció, a panel felajánlja a visszaállítást (preset + modulok + routing), a meglévő confirm-vokabuláriummal, mindkét nyelven. A tárolt konfiguráció **nem kerüli meg** a függőség-validációt: a beolvasáskor normalizálódik (a preset-címke is újraszámolódik), a meglévő preview-úton az operátor látja a korrigált modul-térképet, majd az írás harmadszor is validál.

**5. P2-B origó-határ (OPT-M6) — megerősítve szándékos, dokumentálva.**
A phase-2 as-build új szakasza megnevezi, hol van bekötve az admission gate és a packet-metaadat, miért nincs a másik három origón (nincs explicit méret-jel, és a spec tiltja a becslést — a kapuzás ott viselkedés-semleges lenne, ráadásul feltételezést írna megfigyelésként), és mi kellene a bekötésükhöz.

**6. A kernel drive-szkriptje (KERNEL-M6) — őszinte címkék + at-rest audit.**
A szkript megmarad, de szótáron belüli, vállalható értékeket ír: `commit_chain_status`/`runtime_status`/`verdict` → `UNKNOWN` (ebben a kernelben a CONSISTENT két függetlenül megfigyelt locator egyezését jelenti; a szkriptnek egy átmásolt sha-ja van és semmit sem próbál — az UNKNOWN itt a *kiszámolt* válasz, nem kitérés), `receipt_type` → `POST_OBSERVATION_RECEIPT`, és a `GATED` lista `CITED`-re át, mert a régi név gate-futást állított. A `store.check_integrity` új `column_vocabularies` ellenőrzést kapott, amely a legális halmazokat a gazdamoduljaikból olvassa (nem mint egy második, driftelő másolat), és az `a1_pilot` receipt-típusai mostantól a store halmazának aliasai. Egy AST-szken teszt bukik, ha a kitalált literálok — vagy egy legális, de ki nem érdemelt `OBSERVED`/`PASS`/`CONSISTENT` — visszatérnének.

## 4. Ami ezután is nyitva marad

| Tétel | Mit igényel |
|---|---|
| A kernel hét már beírt, fabrikált sora | Append-only store: a javított szkript újrafuttatása no-op rájuk. Tulajdonosi döntés kell: őszinte újra-ingest új run-címke alatt, vagy dokumentált erratum |
| `execution_receipts` proveniencia-oszlop | Nincs a `claims.source_type`-nak megfelelő mező, így a „producer-asserted" csak a `receipt_type`-ból következtethető; és ma semmilyen kódút nem visz tárolt receiptet a `claim_verification` authority-szabályai elé — sémabővítés kérdése |
| A review maradék LOW-találatai | Több mellékesen lezárult a sweepekben (pl. a ledger `lastFailStmt` fantom-státusza, a receipt-chain státuszlista); a többi a két review-dokumentumban él tovább, prioritással |
