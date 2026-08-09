# CostOps upstream split plan

**Dátum:** 2026-07-05
**Készítette:** Marveen
**Cél:** a lokális CostOps fejlesztés maradjon frissíthető az upstreamből (Szotasz/marveen), és amit érdemes, azt upstream-kompatibilis, kis, review-elhető PR-ekre lehessen bontani. Ez TERV, implementáció nincs.

---

## 1. Jelenlegi branch és commit stack

- **Branch:** `feat/costops-ledger-token-estimates`
- **HEAD:** `b73b051`
- **Upstream base:** `v1.19.0` = `c396514` (origin/main)
- **Safety backupok:** `backup/costops-v1.19.0-integrated` (e7d5502), `backup/costops-dashboard-clean-v1.19.0` (b73b051)

CostOps commitok (upstream base felett), időrendben:

| Commit | Verzió | Tárgy |
|--------|--------|-------|
| `c93060d` | v0.1 | local ledger + token estimates |
| `bb0206f` | v0.2 | provider collector framework |
| `5896a3c` | v0.3 | offline dry-run mode for provider collectors |
| `15d8d7a` | v0.4a | Render plan-based infra cost collector |
| `0768dc5` | v0.4 | provider-preferred operational spend |
| `6789f9c` | v0.5 | API sync spine (Render sync endpoint + freshness/sync-state) |
| `e7d5502` | merge | v1.19.0 beolvasztva (konfliktus: `src/db.ts`, union-feloldás) |
| `b73b051` | UX | user-friendly, API-first dashboard cleanup |

## 2. Érintett fájlok (commit → fájl térkép)

- **Domain / backend (upstream-kompatibilis):** `src/costops/{config,ledger,pricing}.ts`, `src/costops/collectors/{anthropic,render,runner,config,types}.ts`, `src/costops/README.md`
- **DB séma:** `src/db.ts` (v0.1 +64 sor cost-táblák, v0.2 +19 import_runs, v0.5 +3 sync-state)
- **HTTP route:** `src/web/routes/costs.ts` (v0.1 +60, v0.5 +17), `src/web.ts` (+2 mount)
- **Token bekötés:** `src/web/token-usage.ts` (v0.1, meglévő fájl kis módosítása)
- **Dashboard (frontend):** `web/app.js`, `web/index.html`
- **Példa configok (upstream-safe, zero-rate):** `src/costops/collectors/collectors-config.example.json`, `render-pricing.example.json`
- **Tesztek:** `src/__tests__/costops-{api,ledger,pricing,collectors,collectors-dryrun,render,operational,sync}.test.ts`
- **.gitignore:** v0.3-ban +2 sor (store/costops-*.json kizárás)

## 3. Upstream-kompatibilis vs lokális-only

**Upstream-kompatibilis (általánosítható, brand-mentes):**
- Teljes `src/costops/` domain-réteg. Ellenőrizve: NINCS brand/domain (`zstradio/marveen/mikrokonyv/...`) hardcode a forrásban.
- DB séma additív (új táblák + additív oszlopok) -- nem breaking.
- Collector framework provider-agnosztikus; a konkrét kulcsok env-ből / gitignore-olt configból jönnek.
- Render collector read-only, hashed service-ref, sanitized plan-label -- nyers ID sosem tárolt.
- Dashboard UX (belső nevek/verziók már eltávolítva a b73b051-ben).

**Lokális-only / config-only (NEM upstream):**
- `store/costops-config.json`, `store/costops-pricing.json`, `store/costops-render-pricing.json`, `store/costops-collectors.json` -- mind gitignore-olt, valós árakkal/kulcsokkal. Csak a `*.example.json` (zero-rate) megy upstreamre.
- `scripts/inter-agent-evidence-gate.*`, `scripts/stale-instructions-*.sh`, `shared-dev/`, `audits/` -- lokális helperek/artifactok, NEM CostOps, nem upstream.
- Bármely ütemezett-sync timer unit, HA lokálisan specifikus (jelenleg nincs is timer -- lásd PR6).

**Genericizálni kell upstream ELŐTT (apró):**
- `src/costops/ledger.ts:85` code-comment példaszámai (37080/40000) -- cseréld absztrakt példára, hogy ne tűnjön valós árnak.

## 4. Javasolt PR-bontás

Sorrend a függőségek szerint (mindegyik kicsi, review-elhető, önmagában zöld):

### PR1 -- Cost ledger + summary alapok (manual fallback)
- **Commit:** `c93060d` (store-config nélkül).
- **DB séma:** IGEN -- új cost-táblák (sources, ledger, budget). Additív.
- **Dashboard:** IGEN -- az alap Költségek oldal + `/api/costs/summary`.
- **Vault/secret:** NEM.
- **Feature-flag/config:** működik puszta manual configgal; ha nincs config -> üres, nem hibázik.
- **Backwards-compat kockázat:** alacsony (csak új táblák). Migráció legyen `CREATE TABLE IF NOT EXISTS`.
- **Tesztek:** `costops-{ledger,pricing,api}.test.ts`.

### PR2 -- Provider collector framework + dry-run / import_runs
- **Commit:** `bb0206f` + `5896a3c`.
- **DB séma:** IGEN -- import_runs / collector-run-status tábla. Additív.
- **Dashboard:** minimális (sync-status blokk).
- **Vault/secret:** NEM (a kulcs env-ből; a collector default dry-run, valós hívás csak explicit).
- **Feature-flag/config:** IGEN -- collector csak akkor fut, ha `collectors-config.json` jelen; default OFFLINE dry-run.
- **Backwards-compat kockázat:** alacsony.
- **Tesztek:** `costops-collectors.test.ts`, `costops-collectors-dryrun.test.ts`.

### PR3 -- Render plan-derived collector (opt-in provider)
- **Commit:** `15d8d7a`.
- **DB séma:** nem (a v0.5 sync-state külön, PR5-ben vagy itt).
- **Dashboard:** IGEN -- Render kártya (plan estimate).
- **Vault/secret:** NEM (`RENDER_API_KEY` env-ből, csak auth-header, sosem logolt/tárolt).
- **Feature-flag/config:** IGEN -- `render-pricing.json` gitignore-olt; csak zero-rate example megy upstream. Collector opt-in.
- **Backwards-compat kockázat:** alacsony. Fontos üzenet a PR-ben: ez **provider_plan_estimate**, NEM számla; a Render nem ad public billing API-t (verifikálva 2026-07-05).
- **Tesztek:** `costops-render.test.ts`.

### PR4 -- API-first operational spend semantics
- **Commit:** `0768dc5`.
- **DB séma:** NEM.
- **Dashboard:** IGEN (operational KPI).
- **Vault/secret:** NEM.
- **Feature-flag/config:** provider-preferred logika; manual fallback marad, ha nincs provider-adat. Nincs dupla számolás.
- **Backwards-compat kockázat:** közepes -- megváltoztatja a headline spend szemantikáját (manual -> provider-preferred). PR-ben világos changelog + a régi manual érték továbbra is elérhető comparisonként.
- **Tesztek:** `costops-operational.test.ts`.

### PR5 -- Dashboard UX cleanup
- **Commit:** `b73b051` (+ a korábbi commitok frontend-részének konszolidációja, ha külön szeretnéd tartani a frontendet).
- **DB séma:** NEM.
- **Dashboard:** IGEN (csak frontend: `web/app.js`, `web/index.html`).
- **Vault/secret:** NEM.
- **Feature-flag/config:** NEM.
- **Backwards-compat kockázat:** alacsony (tisztán UI). Adatminőség-badge-ek, API-first framing, minden belső név eltávolítva.
- **Tesztek:** DOM-shim smoke (a repo `single-file-proto-domshim`/node-verify mintája szerint); nincs backend teszt.

### PR6 -- Scheduled sync / timer (opt-in, csak ha upstream elfogadja)
- **Commit:** JELENLEG NINCS -- a v0.5 sync **API-triggerelt** (`POST /api/costs/sync`), nincs háttér-`setInterval`. Ez a PR csak akkor jön, ha ütemezett auto-sync kell.
- **DB séma:** NEM (a sync-state már megvan a v0.5-ben).
- **Dashboard:** NEM.
- **Vault/secret:** NEM.
- **Feature-flag/config:** IGEN -- env-gated (`COSTOPS_SYNC_INTERVAL` vagy hasonló), default OFF. Ha túl lokális, marad lokál-only.
- **Backwards-compat kockázat:** alacsony; opt-in.
- **Tesztek:** timer-registráció unit.

### PR0 (opcionális, független) -- Teszt-higiénia: vitest exclude `.claude/**`
- Lásd 6. szakasz. Egysoros, upstream-safe, bármely más PR-től független. Külön GO kell (tracked config).

## 5. Mit NEM szabad upstreamelni (checklist)

- [ ] Valós árak (`store/costops-*.json`) -- gitignore-olt, marad.
- [ ] Lokális store config -- gitignore-olt, marad.
- [ ] Nyers provider/service/account adat -- a kód eleve nem tárol ilyet (hashed ref), de PR-review-ban ellenőrizni.
- [ ] Saját belső domain/brand referencia -- forrás tiszta; `ledger.ts:85` comment példaszámait genericizálni.
- [ ] Lokális helper scriptek (`scripts/inter-agent-evidence-gate.*`, `stale-instructions-*.sh`, `shared-dev/`) -- nem CostOps, nem upstream.
- [ ] Timer unit, ha túl lokális -- PR6 opt-in vagy lokál-only.

## 6. Teszt-higiénia (upstream split előfeltétel)

**Vizsgálat eredménye:** a `vitest run` bescanneli a `.claude/worktrees/agent-a51e44734a770b70e/` mappát, ami egy **AKTÍV** git worktree (`feat/kanban-move-audit` branch, másik agent munkája). Ott **109** teszt/spec fájl van (compiled `dist/__tests__/*.test.js` duplikátumok + 1 Playwright `tests/smoke/dashboard.spec.ts`).

**Gyökérok:** a vitest default `include` glob-ja rekurzívan bemegy a `.claude/worktrees/**`-be. A meglévő `exclude: ['tests/smoke/**']` NEM fogja meg a beágyazott worktree-path-ot (`.claude/worktrees/.../tests/smoke/...`), mert a glob a repo-gyökérhez van horgonyozva. A Playwright `test()` API vitest alatt dob -> 1 failed suite. Ráadásul a 109 duplikátum felfújja a szuitet (a "3250 teszt" ebből jött; a valódi main-repo szám **1653**).

**Bizonyíték:** `npx vitest run --exclude '**/.claude/**'` -> **116 file passed, 0 failed, 1653 passed, 1 skipped**. (A tracked config NEM lett módosítva.)

**Megoldás-értékelés (Istvan preferencia-sorrendje szerint):**
1. Worktree törlés? **NEM** -- aktív worktree, másik agent munkája. Guardrail tiltja.
2. Csak a tesztparancs pontosítása? Lehetne (`--exclude`), de fragilis és nem "0 failed by default".
3. **Tracked config exclude** (`vitest.config.ts`-be `.claude/**`): ez a tiszta, végleges fix.
   - **Egysoros:** `exclude: [...configDefaults.exclude, 'tests/smoke/**', '.claude/**']`
   - **Upstream-kompatibilis:** IGEN. Az upstream repóban nincs bejelentkezett `.claude/worktrees`, így ott no-op; csak a lokál/fleet checkoutot védi. Biztonságos, általános javítás.
   - **GO KELL:** tracked configot érint -> Istvan külön jóváhagyása nélkül nem commitolom.

**Van-e még failed suite?** A `.claude/**` exclude-dal: NINCS (0 failed). Nélküle: 1 (a worktree Playwright specje).

## 7. Javasolt első upstream PR

**PR1 (Cost ledger + summary alapok, manual fallback)** -- ez a fundamentum, a többi erre épül; önmagában értékes és alacsony kockázatú. Előtte fusson le a **PR0** (vitest exclude) hogy a CI zöld legyen.

---

*Nincs implementáció ebben a körben. Nincs push, nincs PR, nincs rebase, nincs provider/DNS/Render módosítás, nincs Vault/secret hozzáférés.*
