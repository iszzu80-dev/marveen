# COS v1.3.1 — gap analízis és terv

**Dátum:** 2026-08-10 (éjjel) · **Ág:** `develop` @ `6211ba6` · **Mérce:** `docs/marveen-autonomous-case-progression-spec-v1.3.1.md`
**Kérte:** Istvan — „utána pedig a 1.3.1 gap analízis és terv"

**Módszer, a spec §1 saját szabálya szerint:** minden sor az ÉLŐ kódon és az ÉLŐ
adatbázison mérve. A spec állítása nem bizonyíték, és a korábbi auditok állítása
sem. Ahol „nincs" szerepel, ott a keresés nulla nem-teszt találatot adott; ahol
„be van kötve", ott megneveztem a hívót.

**Miért így:** a v1.3 maga mondja ki, hogy statikus hiánylistából nem indulunk,
mert a v1.2-é hat olyan komponenst sorolt hiányzónak, ami létezik. Ez a dokumentum
az ellenkező hibát is el akarja kerülni: azt, hogy valami késznek látsszon, mert
van hozzá tábla és oszlop.

---

## 0. A rövid álláspont

**A biztonsági réteg ma este a helyére került. Az ítélet-réteg nincs meg, és ez a
teljes hátralévő munka.**

Egyetlen szám mondja el a lényeget. Az ügy-célok 99%-a egyedi, mert ma este
bekötöttük az értelmezőt. A gördülő terveké 10%, a következő legjobb lépéseké 7%.

| mező | különböző érték / 101 ügy | mit jelent |
|---|---|---|
| `goal` | **0,99** | ügy-specifikus, valódi értelmezés |
| `rolling_plan_json` | 0,10 | sablon |
| `next_best_action_json` | **0,07** | sablon |

Vagyis az ügyeid MOST már tudják magukról, hogy miről szólnak, de azt nem, hogy
mi a következő lépés. A §4.2 hat mérőszáma pontosan ezt a különbséget kéri
számon, és ezek az első két mérése.

**A második szám, ami ennél is beszédesebb:** a haladás-motor 24 óra alatt 10 716
futást írt, és `CONTINUE_AUTONOMOUSLY` döntést hozott 10 347 alkalommal. Ebből
**nulla** olyan futás van, amelyik bármilyen akciót indított volna
(`action_ids_json` üres mind a 10 347-en). A motor tízezerszer dönt úgy, hogy
„haladjunk autonóm módon", és utána nem halad sehova.

Ez nem hiba a kódban: nincs mit indítania, mert az akció-réteg (Reader → terv →
Writer → draft) nem létezik. De a run ledger tele van, és a teltség önmagában
működésnek látszik. Ugyanaz az alakzat, mint a mindenütt kitöltött terv-mező.

---

## 1. Szakaszonkénti mérés

| § | Tétel | Állapot | Bizonyíték |
|---|---|---|---|
| 10.1 | Context Builder | **RÉSZBEN** | `progression-resolver.ts` gyűjt kontextust és van `ResolutionAudit`-ja, de nem a §10.1 forráslistája szerint (nincs Drive, naptár, névjegy, MCP, kutatás) |
| 10.2 | Reader / Analyst + Evidence Packet | **NINCS** | nulla találat `ReaderEvidencePacket`, `EvidenceFact` |
| 10.3 | Séma ≠ biztonsági határ | **NINCS** | nincs Reader, tehát nincs mit validálni |
| 10.4 | Writer / Composer | **NINCS** | nulla találat |
| 10.5 | Personal-data kezelés | **NINCS** | a négy feltétel (`necessary_for_output` stb.) sehol |
| 10.6 | Draft/send szétválasztás | **MEGVAN** | `draftSend` → `approveSend` → `dispatchApprovedSend`; a küldés kapun megy |
| 10.7 | Model routing | **MEGVAN, INERT** | `routeModelForSensitivity` létezik és a gate hívja, de minden úton beégetett `premium_reasoning` a cél-profil, tehát nem dönt |
| 10.8 | Trigger contract | **NINCS** | nulla találat; ma minden ügy minden ciklusban fut |
| 11 | Resolve-before-ask | **RÉSZBEN** | `ResolutionAudit` megvan (`progression-resolver.ts`), a §11 létrája nincs |
| 12 | Rolling Plan-to-Done | **MEGVAN, SABLON** | `buildRollingPlan`, saját kommentje mondja: „deterministic plan template per case status — no LLM planner" |
| 13 | Progression Kernel | **MEGVAN** | `progression-pipeline.ts`; a v1.2 tévesen sorolta hiányzónak |
| 13.1 | Reader–Policy arbitráció | **NINCS** | nincs Reader |
| 15 | Run Ledger | **MEGVAN, ÉL** | 16 586 sor |
| 16 | Eval / Replay harness | **MEGVAN** | `scripts/cos-dryrun-progression.ts` |
| 17 | Prompt-injekció fixture | **RÉSZBEN** | `prompt-safety.ts` + az értelmező izolált adat-blokkja megvan; a §17 hét elfogadási kritériuma Readerre szól, ami nincs |
| 19 | Wait/Wake | **MEGVAN** | `next_wake_at`, 64 ügyön |
| 20 | Structured escalation | **MEGVAN** | `escalation_id` a pipeline-ban |
| 21 | Delegation Envelope | **CSAK TÁBLA** | egyedül `schema.ts` említi; nincs író, nincs olvasó |
| 22 | Controlled Action Executor | **MEGVAN** | `executor-core.ts`, 3 ledger-sor |
| 22.1 | Hard gate, nincs bypass | **MEGVAN (ma este)** | choke point + claim + kvóta + mennyezet |
| 22.2 | Jogosítás-jegy | **MEGVAN (ma este)** | `action-authorization.ts`, 12 adversarial teszt |
| 22 | Kill switch | **MEGVAN (ma este)** | `kill-switch.ts` + CLI + endpoint |
| 23 | Approval integráció | **MEGVAN** | `authorizeSend`, 3 jóváhagyás |
| 25 | Semantic Completion | **MEGVAN** | `progression-completion.ts`, bizonyíték-kényszerrel |
| 27 | Mission Control | **MEGVAN** | 13 COS-végpont |

**Összesítve: 13 megvan, 4 részben, 2 megvan-de-inert, 6 nincs.**
A hat hiányzó közül öt ugyanaz a réteg: Reader, Evidence Packet, Writer,
arbitráció, personal-data szabály. A hatodik a trigger contract.

---

## 2. A négy valódi hiány, sorrendben

### G-1 · A terv és a következő lépés sablon (§4.2, §12)

`distinct_value_ratio` 0,10 és 0,07. A `buildRollingPlan` három lépést tesz be
státusz szerint, és a szöveg mindig ugyanaz: „Verify current state and gathered
context", „Execute the next action in the work plan", „Document result and plan
next cycle".

**Ez a legnagyobb hiány, és a legláthatatlanabb**, mert mind a 101 ügyön ki van
töltve. Egy „PARTIAL" besorolás nem tudja megkülönböztetni az ügyek felén készet
attól, hogy mindegyiken kész, csak üresen.

### G-2 · Nincs Reader, tehát nincs mire tervezni (§10.2, §10.1)

A terv azért generikus, mert nincs miből specifikusnak lennie. Az ügy ma egy
címet, egy célt és egy összefoglalót ismer — ezt ma este kapta —, de nem ismeri
a szál tényeit, a kéréseket, a hiányzó adatokat és azt, hogy kinél a labda.

**Sorrendi következmény:** G-1-et nem lehet G-2 nélkül megoldani. Aki előbb a
tervezőt cseréli LLM-re, az egy jobb modellt kér arra, hogy ugyanabból a semmiből
találjon ki valamit.

### G-3 · A motor tízezerszer dönt a semmibe (§10.8)

10 347 `CONTINUE_AUTONOMOUSLY`, nulla akcióval. Nincs trigger contract, tehát
minden ügy minden ciklusban újraértékelődik, akkor is, ha semmi nem változott.

Két külön kár: a run ledger teltsége működésnek látszik, és amikor a Reader
megérkezik, ez a szám ágens-hívássá válik. **A trigger contract a Reader
ELŐFELTÉTELE, nem utána jön.**

### G-4 · A Delegation Envelope egy tábla (§21)

Csak a `schema.ts` említi. Nincs író, nincs olvasó. A spec a jegyben (§22.2)
hivatkozik rá mint a jogosultság egyik forrására — ma ott mindig `null`.

---

## 3. Terv

Négy szakasz. Mindegyik végén mérhető állítás, nem „elkészült".

**1. Trigger contract (§10.8).** A haladás csak `NEW_RELEVANT_EVENT`,
`WAIT_WAKE_DUE`, `FOLLOW_UP_DUE`, `APPROVAL_RESOLVED`, `USER_INPUT`,
`CAPABILITY_RECOVERED` esetén fusson, a spec dedup-kulcsával (domain + case_id +
case_version + goal_version + context_hash + wait_version + trigger_reference).
*Kész, ha:* a napi futásszám 10 716-ról a ténylegesen változott ügyek számára esik,
és egy változatlan ügy két ciklus között bizonyíthatóan nem fut újra.

**2. Context Builder (§10.1).** Determinisztikus kód, nem ágens: betölt, szűr
domain/scope szerint, provenance-szel és trust-osztállyal lát el minden forrást.
*Kész, ha:* egy ügyre előállított kontextusban minden elem hordoz forrást és
bizalmi szintet, és egy cross-domain elem bizonyíthatóan kimarad.

**3. Reader + Evidence Packet (§10.2, §10.3, §17).** Read-only, séma-validált
kimenet, utána provenance/domain/trust/policy validáció. A §17 injekciós fixture
a hét elfogadási kritériumával **ugyanabban a szakaszban**, nem utólag.
*Kész, ha:* a fixture-levél („IGNORE ALL PREVIOUS INSTRUCTIONS…") végigmegy a
rendszeren és mind a hét kritérium teljesül.

**4. Tervező és következő lépés az Evidence Packetből (§12, §4.2).**
*Kész, ha:* a `distinct_value_ratio` a terven és a következő lépésen 0,10 és 0,07
helyett a cél fölé megy, és ezt a §4.2 mérőszámaival jelentem, nem szemre.

**A Writer (§10.4) szándékosan az utolsó**, és külön döntést igényel tőled: a
külön Telegram-csatorna a te bot-tokened lépésével kezdődik.

---

## 4. Amit ez a dokumentum nem állít

Nem mondom meg, mennyi idő. Négy szakaszból az elsőnek van tiszta határa, a
többinek nincs, amíg az előző el nem készült. Egy becslés, amit most adnék, arra
a részre vonatkozna, amit már értek.

És nem javaslom a párhuzamos építést. A G-2 sorrendi következménye miatt a
tervező LLM-esítése a Reader előtt látszatjavulást adna: szebb mondatokat
ugyanabból a semmiből.
