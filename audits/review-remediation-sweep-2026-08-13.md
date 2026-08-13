# A 08-12-es teljes review remediációja — három hullám, két repó

**Dátum:** 2026-08-13 · **Ág:** `claude/costops-agp-lean-review-mksxlj`
**Előzmény:** `audits/costops-lean-optimization-full-review-2026-08-12.md` és `marveen-apg-kernel/audits/apg-1.8-wp1-review-2026-08-12.md` (a review maga)
**Kérte:** Istvan — „állj neki a javításoknak", majd „fuss meg egy javító kört, dokumentald és pushold fel"

---

## 0. Mi zárult le

A review **mind az 5 kritikus, mind a 17 HIGH és 21 MEDIUM/LOW** találata javítva van, ~230 új regressziós teszttel, három hullámban:

| Hullám | Commitok | Tartalom |
|---|---|---|
| 1. (kritikus+high, mag) | `a2bd11c`, `3c7fe1b`, `b762478` (private) · `9737adb` (kernel) | számla-folyamat, collectors, vészleállító, kernel ERROR+pack-root |
| 2. (high, élesítés) | `b0064d3`, `1ec9b85` (private) | routing-sweep élesítés, státusz-szótár |
| 3. (medium sweep) | e dokumentum commitjai (private) · `befef8c` (kernel) | 21 medium/low négy csomagban |

Tesztbázis a sweep végén: **marveen-private** 6100+ teszt zöld (a 3 ismert root-sandbox műtermék mellett — chmod/ERR-trap root alatt, a review 0. szakasza dokumentálja), `tsc --noEmit` tiszta. **Kernel** 485 teszt, a 124+9 környezet-csatolt bukás halmaza bájtra azonos a review-előtti baseline-nal; a determinisztikus mag most már 44+ hermetikus teszttel fut bármely gépen.

## 1. A minta, amit a javítások követtek

A review megfigyelése az volt, hogy a hibák a modulok közötti **varratokon** ülnek: fél helyre landolt javítások, két példányban élő logika, kapcsolók olvasó nélkül. A remediáció ezért nem tünetenként foltozott, hanem a varratot szüntette meg:

- **egy fogalom — egy definíció:** az import-státusz partíciót a szótár gazdája (`collectors/types.ts`) definiálja, mind az öt fogyasztó onnan olvassa; az egyenlő-confidence összegzést a `ledger.ts` egyetlen exportált seam-je (`resolveSourceTotal`) adja mind a négy felületnek; a peak-since-top-up logika egy helyen él.
- **a guard oda kerül, ahol az összes út átmegy:** a lezárt-hónap védelem a sync-be, az overlay-kapuzás a `resolveRuntimeModel`-be, a lock a collector-sync törzsébe.
- **a kapcsoló vagy kapcsol, vagy nincs:** `automaticFallback` és `limitedThreshold` bekötve; a halott example-scaffoldok törölve; a maradék három routing-knob sorsa tulajdonosi döntésként dokumentálva.

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

## 3. Tudatosan nyitva hagyva (tulajdonosi döntést igényel)

| Találat | Miért vár döntésre |
|---|---|
| COS-CORE-M3 (budget-scope bázis) | El kell dönteni, melyik bázis kanonikus: `operational_spend` vs. headline `all_sources` — a kettő szándékosan különbözik |
| COS-OPS-M6 (fx-forrás egységesítés) | A Render plan-pricing `fx_usd_huf` vs. `costops-fx.json`: melyik az fx-tény kanonikus otthona; érinti a collector-configok migrációját |
| OPT-M4 (`lastEnabledConfiguration` restore) | UI/termék-döntés: visszakapcsoláskor felajánlott restore a spec §8.1/§9 szerint — a mező írása kész, olvasója erre vár |
| OPT-M6 (P2-B a többi origón) | Megerősítve szándékos: a méret-jel csak kanban-címkéből jön (phase2-p2b spec, „unmarked ⇒ default, do not guess large") — a többi origó kapuzása jel nélkül viselkedés-semleges lenne |
| OPT-H2 maradéka (3 halott routing-knob) | `maxAutomaticFallbacksPerDispatch` bekötése a phase-3 „ceilings, not defaults" hard-limitjét tenné configból emelhetővé; `trustedProvidersOnly`/`maxFallbacksPerProfile` enforcement-pont nélkül — törlés vagy bekötés tulajdonosi döntés |
| KERNEL-M6 (`drive_marveen_work.py` szótáron kívüli evidencia) | A szkript producer-asserted „VERIFIED/PASS" sorai tartalmi kérdés: mit szabad a kernelbe táplálnia — a review rögzíti, a döntés a tulajdonosé |

A review LOW-találatai közül a sweepekben mellékesen több lezárult (pl. a ledger `lastFailStmt` fantom-státusza, a receipt-chain státuszlista); a maradék LOW-k a két review-dokumentumban élnek tovább, prioritásukkal együtt.
