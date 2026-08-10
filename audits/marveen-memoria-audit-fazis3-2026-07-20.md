# Marveen memória-/stabilitás-audit — Fázis 3: Watchdog és hibaklasszifikáció

**Dátum:** 2026-07-20 00:15 CEST · **Készítette:** marveen
**Read-only.** Nem módosítottam semmit, és nem futtattam kontrollált hibatesztet.

---

## 3.0 A fázis egymondatos eredménye

A guard-ok többsége **fájlként létezik, de nem fut**. A ténylegesen ütemezett védelem **három cron-bejegyzés**, ebből egy verziókövetetlen; egy „watchdog" néven futó unit valójában **egyszer fut boot-kor és kilép**; és a ténylegesen futó guard-ok közül **egyik sem konzultál a MemGate-tel**.

---

## 3.1 Mi fut ténylegesen — bizonyíték-alapú lista

### A. Ütemezve fut (crontab, verbatim)

```
*/3 * * * * scripts/fleet-resume-guard.sh   >> store/logs/fleet-resume-guard.log
*/5 * * * * scripts/fleet-context-guard.sh  >> store/logs/fleet-context-guard.log
*/5 * * * * scripts/suite-checkout-ff-guard.sh >> store/logs/suite-checkout-ff-guard.log
```
A crontabban **összesen ez a három sor** van. `fleet-memory-gate` találat: **0**.

### B. Egyszer fut boot-kor, majd kilép

`marveen-host-watchdog.service` — telepítve és **enabled**, de:
```
Type=oneshot
ExecMainStartTimestamp = 2026-07-19 19:51:04 CEST
ExecMainExitTimestamp  = 2026-07-19 19:51:05 CEST
Result=success   NRestarts=0
```
**Egy másodpercig futott, boot-kor, és azóta inactive.** Nincs hozzá timer a telepített unitok közt. A neve „watchdog", a viselkedése egyszeri boot-hook. **Nem folyamatos felügyelet.**

### C. Kódból, eseményvezérelten hívódik (nem ütemezett)

- `scripts/channel-watchdog.sh` — hívja `src/web/channel-monitor.ts`
- `scripts/stuck-modal-guard.sh` — hívja `channel-monitor.ts` / `agent-worker.ts`

Ezek **csak akkor futnak, ha a dashboard eljut a hívási pontig**. Ha a dashboard megáll vagy az event-loop blokkol, ezek is némán megszűnnek — nincs független ütemezőjük.

### D. Tranzitívan fut

`scripts/dispatch-guard.sh` — nincs saját cron-sora, de meghívja a `fleet-resume-guard.sh` (3 percenként) és a `stale-instructions-guard.sh`. Tehát **de facto 3 percenként fut**, a resume-guard-on keresztül. Ez a resume-guard-tól örökölt futás: ha az kiesik, ez is.

### E. NEM FUT — fájl van, ütemező nincs

| Script | Unit/timer a repóban | Telepítve? | Hívó? |
|---|---|---|---|
| `disk-space-guard.sh` | `.service` + `.timer` | **nem** (`is-enabled` = not-found) | teszt + a nem telepített unit |
| `channel-keepalive-probe` | `.service` + `.timer` | **nem** | – |
| `channel-watchdog.timer` | van | **nem** (csak kódból hívva) | lásd C |
| `stuck-modal-guard.timer` | van | **nem** (csak kódból hívva) | lásd C |
| `stale-instructions-guard.sh` | – | – | **nincs hívó** |
| `channel-reply-guard.sh` | – | – | **nincs hívó** |
| `verdict-posted-watchdog.sh` | – | – | **nincs hívó** |

A `scripts/systemd/` könyvtárban **12 unit-fájl** van; a `~/.config/systemd/user/`-ben ténylegesen telepítve **9**, és ezek közül a guard-jellegű mindössze a `marveen-host-watchdog.service` (oneshot).

---

## 3.2 Guardonkénti evidence table

### `fleet-context-guard.sh` — **PROVEN, fut**

| Dimenzió | Megállapítás |
|---|---|
| Fut? | **Igen**, crontab `*/5`, saját logfájllal |
| Mi indítja | cron |
| Input | agentenkénti kontextus-telítettség (%) |
| Mit tesz | **WARN ≥85%**: inter-agent üzenet a deliverylead-nek, **nem** indít újra. **CRITICAL ≥92%**: evidence-capture + `POST /api/agents/<agent>/restart` + re-orient brief |
| Indít/állít/restartol? | **Restartol**, a CRITICAL ágon |
| Kit nem bánt | Csak **IDLE** agentet érint (aktív munkát nem szakít meg); `marveen`-t kihagyja |
| Safe-mode / MemGate | **NEM konzultál egyikkel sem** — lásd 3.3 |
| LLM? | **Nem** (0 találat) |
| Dedup / cooldown / state | **Van**: `fleet-context-state.json` + `fleet-context-warn-state.json`; WARN 2h, CRITICAL 1h rate limit |
| Felismert hibakategória | kontextus-telítődés (megbízhatóan, mert számszerű) |
| Storm-kockázat | **Alacsony**: rate-limit + idle-feltétel + per-agent állapot |

### `fleet-resume-guard.sh` — **PROVEN, fut, de UNTRACKED**

| Dimenzió | Megállapítás |
|---|---|
| Fut? | **Igen**, crontab `*/3` |
| Verziókövetés | **NINCS** — `.git/info/exclude`-ban, szándékosan local-only |
| Input | agent tmux pane állapota + kanban kártyák |
| Mit tesz | Az újraindítás után **IDLE-ben ragadt** agenteket meglöki, hogy folytassák a félbehagyott munkát |
| Indít/állít/restartol? | **Nem** indít és nem állít le agentet — csak `send-keys`-szel üzen |
| Safe-mode / MemGate | **Nem hivatkozik egyikre sem** |
| LLM? | **Nem** (0 találat) |
| Dedup / cooldown / state | **Van**: `fleet-resume-state.json`, **per-kártya nudge-számláló** és cap |
| Felismert hibakategória | „respawn után idle marad" (a 2026-07-06-i eset: restart után mind a 20 agent tétlen) |
| Storm-kockázat | **Alacsony** — nem indít processzt; a per-kártya cap fogja meg az ismétlést |

### `marveen-host-watchdog.service` — **CONTRADICTED a nevéhez képest**

Egyszeri boot-hook (`Type=oneshot`, 1 másodperc). Nem figyel semmit futás közben. Aki a nevéből folyamatos host-felügyeletre következtet, téved.

### `channel-watchdog.sh`, `stuck-modal-guard.sh` — **PARTIAL**

Léteznek és a kód hívja őket, de **nincs független ütemezőjük**. A telepített unitok közt a timerük nincs ott. Egyetlen közös meghibásodási pont: a dashboard. Ha az blokkol vagy leáll, ezek is elnémulnak — épp akkor, amikor a legnagyobb szükség lenne rájuk.

### `stale-instructions-guard.sh`, `channel-reply-guard.sh`, `verdict-posted-watchdog.sh`, `disk-space-guard.sh` — **NOT APPLICABLE (jelenleg halott kód)**

Nincs ütemezőjük és nincs hívójuk. Léteznek, tesztelve is lehetnek, de a futó rendszerben **nincs hatásuk**.

---

## 3.3 A fázis legfontosabb integrációs rése

**A MemGate egyetlen hívási helye:** `channel-monitor.ts:1627`, a reconcile-ciklusban, a `down` (desired-but-not-running) agentek felett.

Ebből következik: a `fleet-context-guard` CRITICAL ága a `POST /api/agents/<agent>/restart` végponton **megkerüli a MemGate-et**.

Vagyis: az a guard, amelyik kontextus-nyomás alatt agenteket indít újra, **nem tud a memóriahelyzetről**. A rendszer egyetlen memória-kapuja pedig nem fedi le az ő útvonalát.

Ez önmagában nem katasztrófa — egy restart *csökkenti* az adott agent memóriáját (friss kontextus). De azt jelenti, hogy a két mechanizmus **nem tud egymásról**, és nincs olyan pont, ahol a rendszer eldöntené: „most memórianyomás van, ne indíts újra semmit".

**Státusz: PARTIAL** (a MemGate létezik és működik a maga útvonalán) **+ NOT PROVEN** (hogy a teljes restart-felület le van fedve — a bizonyíték szerint nincs).

---

## 3.4 Storm-kockázat összegezve

| Forrás | Kockázat | Miért |
|---|---|---|
| `fleet-context-guard` | alacsony | rate-limit + idle-feltétel + állapotfájl |
| `fleet-resume-guard` | alacsony | nem indít processzt, per-kártya cap |
| reconcile (`channel-monitor`) | **közepes** | ez a valódi burst-forrás; a MemGate itt véd, de **fail-open** |
| kombinált | **nem mérve** | Fázis 7 kontrollált teszt kérdése |

A MemGate fail-open természete (`channel-monitor.ts:1596-1597`: bármely hiba/timeout **engedi** az indítást) azt jelenti, hogy egy elromlott gate nem fagyasztja be a flottát — de nem is véd. Ez tudatos tervezői döntés, nem hiba; a kockázat viszont valós.

---

## 3.5 Nyitott kérdés Istvan 3. pontjához (Fázis 4-be visszük)

Istvan kérdése: mi okozta a korábban dokumentált **19 non-core agent parkolást** és a **86% → 32%** memóriacsökkenést?

Fázis 3 bizonyítéka alapján **nem a `fleet-memory-gate.sh`** — annak a saját forráskommentje mondja ki, hogy „**NEVER kills or restarts anything**". Egy admission gate nem tud parkolni.

A ma esti 22-ről 8 agentre csökkentést **én végeztem kézzel**, `POST /api/agents/<nev>/stop` hívásokkal. Erős a gyanú, hogy a korábbi eset is manuális vagy egyszeri script-futás volt, nem automatizmus. **NOT PROVEN** — Fázis 4-ben a `store/logs/` és a dashboard execution-log alapján visszakereshető.

---

**Fázis 3 vége. A dokumentum előírása szerint megállok, és nem kezdem el a Fázis 4-et.**
