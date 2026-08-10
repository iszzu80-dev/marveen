# COS v4.2.1 — P1/P2 closure audit

**Dátum:** 2026-08-06 | **Ág:** `develop` (HEAD `acf404c`) | **Módszer:** minden állítás a mi `develop` águnkon, teszttel igazolva (nem a spec állítása alapján).

> Istvan kérése (msg 7808): "mehetnek folyamatosan a p1 p2 dolgok amíg a teljes specifikációt be nem fejezted. Utána ellenőrizd vissza hogy mi nem lett teljes és miért." Ez az a visszaellenőrzés.

Teszt-állapot: **4512 pass / 1 skip / 1 pre-existing fail** a teljes projektben (a fail az `installer-start-and-fallback` bash ERR-trap meta-teszt, környezetfüggő, NEM COS). COS-only: **201 teszt zöld**, `tsc --noEmit` tiszta.

---

## 1. AMI KÉSZ (spec v4.2.1, teljes korrektségi felület)

### P0 (a v4.2.1 hat korrektségi köre) — mind kész, korábbról
P0.1 poison-karantén, P0.2 account-checkpoint (cursor csak terminál batch-nél lép), P0.3 crash-window + kereshető idempotencia-marker, P0.4 template+rendered approval + atomi kvóta-foglalás, P0.5 optimista concurrency + revoke-verziózás, P0.6 statikus 4-tier sensitivity fail-closed.

### P1 (B.1-B.6) — mind kész, EBBEN a körben
| # | Követelmény | Állapot | Bizonyíték |
|---|---|---|---|
| P1.1 | Outbound állapotmodell finomítás | KÉSZ | `executor.ts`: APPLIED_UNVERIFIED / OUTCOME_UNKNOWN / FAILED_RETRYABLE / FAILED_TERMINAL / CANCELLED / RECOVERY_REQUIRED; migráció; `cos-executor` + `cos-outbound-migration` tesztek |
| P1.2 | Gmail self-generated event szűrés | KÉSZ (AC-28) | `gmail-history-guard.ts`: SELF_LABEL_NOOP / DUPLICATE / NEW_BUSINESS; origin-log; `cos-gmail-history-guard` |
| P1.3 | Adapter-contract + marker-persistence | KÉSZ (AC-26) | `marker-persistence.ts`: EXECUTE csak ha a marker bizonyítottan visszaolvasható, különben PREPARE; `cos-marker-persistence` |
| P1.4 | Browser adapter minimum-interfész | KÉSZ | `browser-adapter.ts`: 6-metódusú kontraktus + readback-próba → EXECUTE\|PREPARE; a shopping-adapter execute nélkül → PREPARE (gépi "nincs autonóm vásárlás") |
| P1.5 | Radar devizakezelés | KÉSZ | `radar.ts` + observations FX-oszlopok; HIT az átváltott áron; `cos-radar` FX tesztek |
| P1.6 | Radar értesítés-dedup | KÉSZ (AC-29) | `decideNotify`/`markNotified`; NEW_HIT/NEW_OFFER/PRICE_DROP; változatlan ajánlat nem pingel; `cos-radar` + `cos-tick` |

### P2 (§C adatbiztonsági + üzemeltetési DoD) — kész, EBBEN a körben
- Store-jogosultság (db 0600 / dir 0700) ellenőrzés + kikényszerítés — `store-security.ts`
- Érzékeny tartalom sosem logba/skill-trajectorybe — `redactSensitive`
- Titkosított backup (AES-256-GCM) + restore-teszt (byte-pontos) + 30 napos retention prune — `backup.ts`
- Melléklet checksum-readback (§12/19) — `attachments.ts` (`case_attachments` tábla)
- Retention-policy definiálva (törölt case 365d, melléklet-tartalom 90d, backup 30d) + tartalom-purge tombstone-nal — `retention.ts`
- Auditlog nem módosítható (append-only trigger UPDATE-et ÉS DELETE-et is elutasít) — `cos-audit-immutability`

### D.1-D.4 (konzisztencia) + E (AC-22..29)
- D.1 idempotencia-kulcs átnevezés: `internal_idempotency_key` + `external_idempotency_marker` — KÉSZ
- D.2 általános Shopping adapter (API/MCP/browser) — a kód már ezt tükrözi
- D.3/D.4 ZST külön + freeze-wording — doksi, rendben
- AC-22..29: mind a 8 elfogadási tesztnek van valódi fedése (karantén, fence, kvóta, revoke, marker, sensitivity, self-event, radar-dedup)

---

## 2. AMI NEM LETT TELJES — ÉS MIÉRT

Egyik sem korrektségi rés; mind KÜLSŐ JOGRA (consent/credential) vagy owner-döntésre vár, vagy a spec maga terméktovábbfejlesztésnek minősíti.

| # | Elem | Miért nincs kész | Blokkoló |
|---|---|---|---|
| 1 | **Gmail WRITE / EXECUTE mód** | A MCP igazoltan read-only. A gate MEGVAN (marker-persistence + PREPARE-cap), az autonóm loop NEM köt be kimenő adaptert -> nincs autonóm küldés. EXECUTE csak Istvan write-scope consentje + élő marker-persistence teszt után. | Istvan böngészős write-scope consentje |
| 2 | **Élő Gmail history-delta poller** | A self-event guard (P1.2) kész + tesztelt, de a valódi history-polling loop label-write jogot igényel. Jelenleg a bejövő út a triage HTTP-seamen megy (ez működik, élesben). | ugyanaz a write/label-scope consent |
| 3 | **Kifli / bevásárló adapter** | Nincs integráció (creds + discovery hiányzik). A shopping-adapter execute nélkül -> PREPARE, azaz observe-only. | Kifli credential + discovery döntés |
| 4 | **Calendar write** | Read-only MCP; a naptár-írás consentre vár. | consent |
| 5 | **Dinamikus model-sensitivity routing** | A COS statikus policy-t használ (P0.6, fail-closed). A spec §F szerint ez terméktovábbfejlesztés, NEM korrektségi rés. | tervezési döntés (nem sürgős) |
| 6 | **Teljes monitoring dashboard / skill permission validator / kampány-radar analitika** | Spec §F: kifejezetten "termékbővítés vagy deployment-döntés, NEM korrektségi rés". | későbbi scope |
| 7 | **`docs/cos-slice0-schema.sql` mirror** | NEM alkalmazható: a design-doc kizárólag Slice-0-scope (personal_cases / _events / case_claims). A P1/P2 változásaim mind Slice-1/4 táblákban vannak (outbound_ledger, radar, email_processing, case_attachments), amik a `schema.ts` header saját kijelentése szerint mindig is kódban éltek forrásként. Nincs mit tükrözni. | n/a |
| 8 | **Go-live (dist rebuild + restart)** | A P1/P2 kód developra mergelve, de az élő dashboard a régi dist-et futtatja. A séma-migrációk boot-kor futnak (tesztelve, biztonságosak). Restart owner-gated (kilépteti Istvant + hajnal van). | Istvan GO a restartra |
| 9 | **RECOVERY_REQUIRED alerting** | KÉSZ (ee0e2f6): az `outboundNeedingHuman` most be van kötve a tickbe + runtime bus-alertbe, hogy egy beragadt sor ne maradjon némán. (Utólagos dead-code-zárás.) | - |

---

## 3. Összegzés

A v4.2.1 **teljes korrektségi felülete kész és tesztelt** (P0 + P1 + P2 + AC-22..29). Ami hiányzik, az mind (a) külső consent/credential mögött van kapuzva biztonságosan, vagy (b) a spec által termékbővítésnek minősített, nem-korrektségi elem. **Nincs olyan elem, ami korrektségi hiány miatt maradt volna ki.** A rendszer jelenlegi állapotában sosem küld/vásárol autonóm módon (a küldő adapter nincs bekötve, a shopping/browser adapter execute nélkül PREPARE).

Következő owner-gated lépések (mind Istvan-döntés): (1) go-live restart, hogy a P1/P2 élesedjen; (2) Gmail write-scope consent, hogy az EXECUTE + history-poller aktiválható legyen; (3) Kifli credential/discovery, ha kell a bevásárló-ág.
