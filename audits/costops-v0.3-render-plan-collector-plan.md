# CostOps v0.3 -- Render plan-based infra cost collector (DESIGN ONLY)

**Datum:** 2026-07-05
**Statusz:** DESIGN / terv. NINCS implementacio, NINCS live Render API hivas, a RENDER_API_KEY nincs hasznalva ehhez a dokumentumhoz. Kesobb kulon GO-ra implementalando.
**Dontes (Istvan, tg2872):** a kovetkezo v0.3 actual-collector a **Render**, es kifejezetten **plan-based infra cost collector** (nem actual billing collector), mert a Render API a service-eket es a planeket adja, nem a tenyleges invoice osszeget.

Az itteni API-szerkezet-leiras a korabbi (deploy-gate) hivasok soran mar latott valasz-alakbol szarmazik; ez a terv NEM hiv Render API-t.

---

## 0. Alapelvek (Istvan tg2872 szerint, kotelezo)

- A collector confidence-je **NE** `provider_api` (actual) legyen. Uj kategoria: **`provider_plan_estimate`**.
- A plan-based becsles a manualis `render-hosting` estimate MELLE megy, **nem irja felul automatikusan** a headline `current_spend`-et.
- A summary/dashboard KULON mutassa: (a) manual render estimate, (b) Render plan-based estimate, (c) variance.
- A plan->price mapping **lokalis configbol** vagy tracked safe pricing-mapbol jojjon, ne nehezen frissitheto hardcode.
- Ne szamoljon olyan koltseget, amit nem lat (bandwidth overage, DB storage overage, logs/metrics, team/workspace seat, one-off credit, tax/VAT, invoice adjustment, cron per-run compute). Ezeket kulon **"not covered / potential undercount"** listaban jelezze.

---

## 1. Milyen adatokat latunk a Render API-bol

**Fo forras: `GET /v1/services?limit=N`** -> tomb, minden elem `{ service: {...} }`. A `service` objektum lenyeges mezoi:
- `id` (pl. `srv-...`) -- stabil azonosito, dedup-alap
- `name` -- humane nev (NEM azonosito; nev-utkozes lehet)
- `type` -- **ez adja a service tipust** (lasd 2. pont)
- `serviceDetails.plan` -- **ez adja a plan/instance-tipust** web/worker/private eseten (pl. `starter`, `standard`, `pro`); static site-nal jellemzoen nincs (`n/a`)
- `serviceDetails.region`, `serviceDetails.numInstances` (skalazas -> plan * instance-count!), `suspended` / `suspenders` (felfuggesztett-e)
- `createdAt` / `updatedAt`

**Kulon endpointok (NEM a /v1/services-ben):**
- **Postgres:** `GET /v1/postgres` -- sajat lista, sajat `plan` mezovel (free/basic/standard/pro...). A DB koltseg NAGY tetel lehet, ezert kell.
- **Key-value / Redis:** `GET /v1/key-value` (ha van ilyen eroforras) -- sajat plan.

Megjegyzes a mai inventoryrol (deploy-gate hivasokbol, nem uj hivas): ~18 service, tulnyomo resze `starter` planon, part `n/a` (static/free). Ez ~$90+/ho nagysagrend, tehat valos, kovetesre erdemes koltseg.

**Kell-e kulon service-detail lekeres?** A `GET /v1/services` valasz mar tartalmazza a `serviceDetails.plan`-t es a `type`-ot, tehat a plan-becsleshez **nem kell** per-service extra hivas. Extra `GET /v1/services/{id}` csak akkor kellene, ha a listavalasz nem adja vissza a `numInstances`-t vagy a plant valamely tipusnal -- ezt az elso implementacios lepes fixture-jen verifikaljuk (offline), es csak ha tenyleg hianyzik.

---

## 2. Kezelendo service-tipusok es dijazasi logika

| Render `type`                | Dijazas jellege                      | MVP kezeles |
|------------------------------|--------------------------------------|-------------|
| `web_service`                | flat havi plan (starter/standard/...) | plan->ar |
| `private_service`            | flat havi plan                        | plan->ar |
| `background_worker`          | flat havi plan                        | plan->ar |
| `cron_job`                   | per-run compute (NEM tisztan flat)    | plan->ar KOZELITES + undercount-jelzes |
| `static_site`               | ingyenes + bandwidth overage          | 0 Ft + undercount-jelzes (bandwidth nem latszik) |
| `postgres` (kulon endpoint)  | flat havi plan + storage overage      | plan->ar, storage-overage undercount |
| `key_value`/`redis` (ha van) | flat havi plan                        | plan->ar |

**Skalazas:** ha `numInstances > 1`, a havi ar = plan_ar * numInstances (kulonben alulszamol). Ha a mezo hianyzik -> 1-nek vesszuk + undercount-jelzes.

**Suspended/free/preview:**
- `suspended=true` -> 0 Ft (nem szamlaz), de listazzuk `suspended` markerrel (ne tunjon el).
- `free` plan / `static_site` -> 0 Ft flat, de a bandwidth/overage az undercount-listaba.
- **preview environment** (PR-preview) -> ha megjelenik a listaban, MVP-ben kihagyjuk (nem allando koltseg) es jelezzuk hogy kihagytuk.

---

## 3. Deduplikacio

- Elsodleges kulcs a **service `id`** (nem a `name` -- a nev utkozhet/valtozhat).
- Havi bontas: `dedup_key = provider|render|<service_id>|<YYYY-MM>|provider_plan_estimate` (per service, per honap) -- ha per-service line-okat tarolunk.
- Aggregalt valtozatnal: `dedup_key = provider|render|render-plan|<YYYY-MM>|provider_plan_estimate` (egy osszevont sor/honap).
- Idempotens upsert a dedup_key-en (mint a v0.3 collector runner mar csinalja) -> ujrafuttatas nem duplikal.

---

## 4. Kulon source_id per service VAGY aggregalt? (MVP dontes)

**MVP javaslat: AGGREGALT egy `render-plan` sor / honap**, a per-service bontas a report/metadata mezoben (dashboard drill-downhoz), NEM kulon cost_line_items-kent.

Indok:
- A cel az osszehasonlitas a **manualis `render-hosting` egyetlen estimate soraval** (manual vs plan-based vs variance) -- ez 1:1 osszevetes, aggregalt szinten tiszta.
- A per-service kulon line-ok (18+ sor/honap) feleslegesen hizlaljak a ledgert az MVP-hez.
- A per-service breakdown megmarad lathatonak a summary egy `render_plan.services[]` tomjeben (name-mentes/ id-alapu, plan, becsult ar), a dashboard drill-downhoz.

**v-next (kesobb):** per-service cost_line_items sajat source_id-val, ha kell service-szintu trend/riasztas.

---

## 5. Plan -> monthly HUF mapping (config javaslat)

Uj, gitignore-olt lokalis config: **`store/costops-render-pricing.json`** (a valodi arak lokalisan, mint a costops-pricing.json), + egy tracked safe **`.example`** 0-arakkal.

```json
{
  "version": 1,
  "currency": "USD",
  "fx_usd_huf": 0,
  "plans": {
    "web_service":       { "free": 0, "starter": 7, "standard": 25, "pro": 85, "pro_plus": 175, "pro_max": 225 },
    "private_service":   { "starter": 7, "standard": 25, "pro": 85 },
    "background_worker": { "starter": 7, "standard": 25, "pro": 85 },
    "cron_job":          { "starter": 1 },
    "postgres":          { "free": 0, "basic_256mb": 6, "basic_1gb": 19, "pro_4gb": 45 },
    "key_value":         { "starter": 10, "standard": 32 }
  },
  "_doc": "Render plan -> USD/ho. NEM hardcode a kodban. A tenyleges arak valtozhatnak -> itt frissitendo. USD, majd fx_usd_huf-fal HUF. static_site/suspended = 0. Overage/seat/tax NEM szerepel (lasd not-covered)."
}
```

- A kod CSAK a config-kulcsokat olvassa; ismeretlen plan -> `unpriced` (0 + undercount-jelzes), nem talal ki arat.
- HUF = USD_ar * fx_usd_huf (kerekites 2 tizedes), mint az anthropic mappernel.
- A pontos arlistat az implementacio elott a Render arazasi oldalarol frissitjuk (a fenti szamok kozelito placeholderek a tervhez).

---

## 6. Nem-fedett koltsegek jelzese (undercount)

A summary render_plan blokkja tartalmazzon egy **`not_covered[]`** listat, fix, ismert tetelekkel:
- bandwidth overage (web + static)
- database storage overage a plan-kereten felul
- logs / metrics / observability add-on
- team / workspace seat dij
- one-off credits / kedvezmenyek
- tax / VAT
- invoice adjustment / manualis korrekcio
- cron_job per-run compute (a flat kozelites felett)
- preview environmentek (MVP-ben kihagyva)

+ egy `undercount_flags[]` a KONKRET esetekre amit a futas talalt (pl. "3 static_site: bandwidth nem szamitva", "cron_job: per-run kozelites", "numInstances hianyzott 1 service-nel -> 1-gyel szamolva"). Ez teszi a becslest oszinteve: "ez egy also becsles".

---

## 7. Confidence kategoria javaslat

Uj: **`provider_plan_estimate`**.
- A `CONF_PRIORITY`-ben a manual(1) es estimate(2) FOLE, de a local_usage(3)/billing_export(4)/provider_api(5)/actual_invoice(6) ALA: javasolt **prioritas 2.5** (azaz estimate folott, de nem actual).
- **KRITIKUS Istvan-eloiras miatt:** a plan-estimate **NE folyjon bele a headline `current_spend`-be es NE irja felul a manual render estimate-et.** Ket biztonsagos opcio:
  - **(A) Ajanlott:** a plan-estimate egy KULON, advisory reconcile-blokkban jelenik meg (`render_plan`), a `current_spend` valtozatlan marad (a manual estimate szamit bele, ahogy eddig). A dashboard mutatja: manual vs plan vs variance.
  - (B) Alternativa: azonos `render-hosting` source-on ket confidence-line (manual + provider_plan_estimate), reconcile[]-ben variance -- DE ekkor a resolve-per-source logikat ugy kell modositani hogy a provider_plan_estimate NE supersedalja a manualt a headline-ban (kulonben megserti az eloirast). Ez tobb kockazat -> az (A)-t ajanlom MVP-re.

---

## 8. DB / summary / dashboard valtozas

**DB:** nem kell uj tabla. A `cost_line_items` mar tamogatja a tetszoleges `confidence`-t (TEXT, nincs CHECK) es a dedup_key upsertet. Az `import_runs`-ba a Render collector `ok`/`error` sort ir (mint az Anthropic), a `provider='render'`, `collector_name='render-plan-report'`. (A dry-run mod mar keszen all a v0.3-bol -> a Render collector is dry-run-olhato elso korben.)

**Summary (`getCostSummary`):** uj `render_plan` blokk:
```
render_plan: {
  currency, fx_used,
  plan_estimate_total_huf,
  manual_estimate_huf,          // a costops-config.json render-hosting sorabol
  variance_huf,                 // plan - manual
  services: [ { id, type, plan, instances, monthly_huf } ],  // name NELKUL
  not_covered: [...], undercount_flags: [...],
  confidence: "provider_plan_estimate",
  data_freshness_at
}
```
A `current_spend` es a meglevo mezok VALTOZATLANOK (advisory blokk).

**Dashboard (Koltsegek tab):** uj szekcio "Render infra (plan-alapu becsles)" -- manual vs plan-based osszeg, variance, a service-bontas tablazat, es egy "Nem fedett koltsegek" figyelmezteto lista.

---

## 9. Tesztterv (offline fixture, no live call)

Mint a v0.3 anthropic/dry-run tesztek -- INJEKTALT httpGetJson stub, fixture valasz, NULLA live hivas:
- **mapper (pure):** fixture `/v1/services` + `/v1/postgres` valasz -> normalizalt render_plan sor(ok). Ellenorzi: web/worker plan->ar helyes; static_site=0; suspended=0; numInstances>1 szoroz; ismeretlen plan -> unpriced + undercount_flag; USD->HUF fx helyes.
- **aggregacio:** sok service -> egy aggregalt total; a per-service breakdown a metadataban; dedup_key stabil; ujrafuttatas idempotens (nincs duplikatum).
- **not-covered/undercount:** static_site + cron_job + hianyzo numInstances -> a megfelelo undercount_flags megjelenik.
- **confidence/no-override:** a plan-estimate NEM valtoztatja a `current_spend`-et; a `render_plan.variance` = plan - manual helyes.
- **secret-safety:** a RENDER_API_KEY (a live fetcherben) sose kerul a normalizalt sorba / import_runs-ba / summary-ba; a sanitizeError redaktal (mint az anthropicnal). A service `name` NE keruljon a ledgerbe/summary-ba (id-alapu, a nev PII-adjacent lehet ugyfel-projekteknel) -- csak id/type/plan.

---

## 10. Kockazatok / alulszamolasi pontok

- **Also becsles termeszetu:** a plan-arak NEM az invoice; a valos szamla magasabb lehet (overage/seat/tax) -> mindig "potential undercount"-kent kommunikaljuk.
- **Plan-arak avulnak:** a Render valtoztathat arat -> a config-frissites elmaradhat. Enyhites: a config `version` + egy `data_freshness`/`priced_at` mezo, es a dashboardon "arak ellenorizve: DATUM".
- **Instance-count / autoscale:** ha nem latjuk a valos instance-szamot, alulszamolunk.
- **Cron per-run:** flat kozelites, a valos compute elterhet.
- **Postgres/redis kulon endpoint:** ha kimarad a lekeres, jelentos tetel esik ki -> a mapper jelezze ha 0 db-t latott (gyanus).
- **Nev vs id:** csak id-t tarolunk (nev-utkozes + PII elkerules).

---

## 11. Implementacios sorrend (kesobb, kulon GO-ra)

1. **Pricing config** (`store/costops-render-pricing.json` + tracked `.example`), a valos Render arak beirasa (Istvan/Marveen a Render arazasi oldalrol).
2. **Pure mapper** (`src/costops/collectors/render.ts`): fixture `/v1/services` (+`/v1/postgres`) -> normalizalt render_plan sor + breakdown + undercount_flags. Offline tesztek eloszor (TDD).
3. **Collector + dry-run:** a meglevo `ProviderCollector` interfacere (`collectRaw` a shape-preview-hez), a runner + dryRunCollector valtozatlanul hasznalhato. Elso eles proba = **dry-run** (a mar kesz dry-run mod!), ami mutatja a shape-et + tervezett sorokat, semmit nem ir.
4. **Summary `render_plan` blokk** (advisory, current_spend valtozatlan) + reconcile variance.
5. **Dashboard szekcio** (manual vs plan vs variance + not-covered lista).
6. **Config wiring:** `store/costops-collectors.json`-ba egy `render` collector `enabled:false`-szal; a RENDER_API_KEY hasznalata CSAK explicit GO utan, elobb dry-run.
7. Vegso: eles collector-futas (aggregalt provider_plan_estimate sor), tovabbra sem a manualt felulirva.

**MVP scope (minimum eletkepes):** 1-6 lepes web_service + static_site + background_worker + postgres tipusokra, aggregalt egy `render-plan` sorral, advisory (no-override) confidence `provider_plan_estimate`, offline fixture-tesztekkel es dry-run-nal. A per-service cost_line_items, cron/redis finomitas, es a bandwidth-overage becsles = v-next.

---

## Guardrails (ennel a tervnel betartva)

Nincs implementacio, nincs Render API hivas, a RENDER_API_KEY nincs hasznalva, nincs Vault-valtozas, nincs scheduled task, nincs restart, nincs push, nincs PR. Ez CSAK terv. Az implementacio kulon Istvan-GO-ra indul, es akkor is dry-run eloszor.
