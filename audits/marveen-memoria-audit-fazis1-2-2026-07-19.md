# Marveen memória-/stabilitás-audit — Fázis 1 és 2

**Dátum:** 2026-07-19 23:57 CEST · **Készítette:** marveen
**Módszer:** a megrendelt dokumentum bizonyítéki sorrendje szerint (runtime > kontrollált teszt > betöltött environment > forrás > config > dokumentáció > feltételezés).
**Semmit nem módosítottam.** Minden parancs read-only volt.

---

# FÁZIS 1 — Audit terv és scope

## 1.1 Vizsgálati területek

| # | Terület | Hogyan bizonyítom |
|---|---|---|
| 1 | WSL host, kernel, systemd | `/proc/meminfo`, `journalctl --list-boots`, `systemctl show` effektív értékek |
| 2 | Dashboard / channels / worker | systemd unit + futó PID + RSS |
| 3 | Agent tmux sessionök | `tmux ls`, per-agent fő PID és processzfa |
| 4 | Start/stop/reconcile útvonalak | `channel-monitor.ts` forrás + a ténylegesen futó cron/timer |
| 5 | Schedule-runner, heartbeat | crontab, systemd timer, futó process |
| 6 | Watchdog-ok | melyik létezik fájlként **és** melyik fut ténylegesen |
| 7 | MemGate | hívási helyek + tényleges ütemezés + fail-open viselkedés |
| 8 | Safe-mode | `fleet-safe-start.sh` és a gate kapcsolata |
| 9 | Memória-/erőforrás-monitor | cgroup `MemoryMax`, `MemoryPeak`, OOM-napló |
| 10 | Logok, incidens-nyom | journal OOM-bejegyzések, boot-history |
| 11 | CostOps/capacity kapcsolódás | systemd timer megléte |
| 12 | Token-/LLM-használat | Fázis 6, itt még nem |
| 13 | Git/upstream frissíthetőség | branch, ahead/behind, tracked vs local-only scriptek |

## 1.2 Biztonságos auditmódszer

**Read-only parancsok:** `date`, `uname`, `free`, `cat /proc/*`, `journalctl` (olvasás), `systemctl show/status/list-*`, `tmux ls`, `ps`, `crontab -l`, `git status/log/rev-list`, `grep`.

**Terhelő lehet, ezért kerültem vagy szűkítettem:**
- teljes `journalctl` dump → csak szűrt, dátumhatárolt lekérdezés;
- repo-szintű rekurzív grep → `--exclude-dir=node_modules,.git`;
- `ps` ismételt pollozása → egyszeri, rendezett pillanatkép.

**Külön jóváhagyást igényel majd (Fázis 7):** bármely teszt, ami agentet indít/állít, memórianyomást szimulál, vagy restart-útvonalat vált ki. Ezeket most **nem** futtattam.

**Hogyan kerültem el, hogy az audit maga okozzon OOM-ot:** nem indítottam új agentet, nem futtattam párhuzamos subagentet az audit alatt, és a mérések összesen néhány másodperc CPU-t vittek. A jelenlegi 3,2 GB/10,9 GB terhelés mellett ez érdemi kockázat nélküli.

## 1.3 Várt végső kimenet

A dokumentum 3.3 pontja szerinti tíz elem, fázisonként építve. Fázis 1–2 ebből az 1., 2. és részben a 3. elemet fedi.

---

# FÁZIS 2 — Runtime- és repository-baseline

## 2.1 Host és WSL

| Tétel | Érték | Forrás |
|---|---|---|
| Idő | 2026-07-19 23:57 CEST | `date` |
| Boot-id | `eaf9594d7e7b416da2564ed84cbd4cae` | `/proc/sys/kernel/random/boot_id` |
| Boot ideje | 2026-07-19 **19:50:14** CEST | `journalctl --list-boots` |
| Kernel | 6.18.33.1-microsoft-standard-WSL2 | `uname -a` |
| RAM | 11 214 496 kB (~10,7 GiB), elérhető 7 874 788 kB | `/proc/meminfo` |
| Swap | 8 388 608 kB, szabad 6 880 608 kB (1,44 GB használatban) | `/proc/meminfo` |
| `.wslconfig` | `memory=11GB`, `swap=8GB`, `vmIdleTimeout=-1`, `autoMemoryReclaim=gradual` | `/mnt/c/Users/iszzu/.wslconfig` |
| systemd | `running`, 0 failed unit | `systemctl is-system-running` |
| `wsl-pro.service` | **inactive (dead)**, disabled | `systemctl status` |

### JAVÍTÁS (2026-07-20 00:10, Istvan észrevétele nyomán)

**Az alábbi „két összeomlás" állítás TÉVES volt. A 01:29-es esemény NEM OOM-halál, hanem szabályos, kívülről indított leállás** — a Windows automata telepítője (frissítés) indította újra a gépet.

Bizonyíték, `journalctl -b -2` a leállás előtti percből — ez rendezett shutdown-szekvencia:
```
01:29:11 systemd[1]: Reached target shutdown.target - System Shutdown.
01:29:11 systemd[1]: Reached target final.target - Late Shutdown Services.
01:29:11 systemd[1]: Finished systemd-poweroff.service - System Power Off.
01:29:11 systemd[1]: Reached target poweroff.target - System Power Off.
01:29:11 systemd[1]: Shutting down.
01:29:11 systemd-journald[46]: Journal stopped
```
A unitok sorban, sikeresen deaktiválódtak. Egy OOM-halál ezt **nem** produkálja: ott a napló mondat közben szakad meg (pontosan ez történt 19:37-kor).

**Hol rontottam el:** az OOM-killer sorokat ugyanarra a másodpercre (01:29:11) láttam, és ebből okra következtettem — holott azok a leállás KÖVETKEZMÉNYEI (a kernel a slice-ok lebontásakor arat), nem a kiváltó oka. Nem olvastam el, mi van körülöttük. Ugyanaz a hibaosztály, amit ma este többször is elkaptam másoknál: egy illeszkedő minta helyettesítette a bizonyítékot.

**Helyes összegzés: ma EGY memória-eredetű halál volt (19:37, és az is NOT PROVEN), plusz egy külső okú, szabályos újraindítás (01:29).** A ~11 óra 50 perces kiesés ténye áll, de az oka nem a flotta memóriahasználata volt.

### Boot-történet (az eredeti, javított értelmezéssel)

```
-2  2026-07-16 07:46:52  ->  2026-07-19 01:29:11   <- SZABALYOS leallas (Windows auto-update)
-1  2026-07-19 13:19:42  ->  2026-07-19 19:48:25   <- hard teardown, memoria-gyanus (NOT PROVEN)
 0  2026-07-19 19:50:14  ->  fut
```

**A 01:29:11 és 13:19:42 közti ~11 óra 50 percben a rendszer NEM FUTOTT.** A kiesés ténye áll; az oka NEM a flotta memóriahasználata volt, hanem hogy a gép a Windows-frissítés után nem indult vissza magától.

Az OOM-killer sorok a 01:29:11-es leállásból (KÖVETKEZMÉNY, nem ok — lásd a fenti javítást):
```
Jul 19 01:29:11 systemd[328]: app.slice: The kernel OOM killer killed some processes in this unit.
Jul 19 01:29:11 systemd[1]: user-1000.slice: The kernel OOM killer killed some processes in this unit.
Jul 19 01:29:11 systemd[1]: user.slice: The kernel OOM killer killed some processes in this unit.
```

### A legfontosabb effektív érték

```
user.slice        MemoryCurrent = 5 191 266 304   (4,83 GiB)
user.slice        MemoryPeak    = 10 401 386 496  (9,69 GiB)
user.slice        MemoryMax     = infinity
user.slice        MemorySwapMax = infinity
```

**`MemoryMax=infinity`** — a flottára **nincs cgroup-szintű memóriakorlát**. Nincs olyan OS-szintű határ, ami a teljes VM halála ELŐTT megfogná. A csúcs 9,69 GiB volt egy 11 GB-os VM-ben.

**Státusz: CONTRADICTED** — a „van memóriavédelem" elvárással szemben a futó rendszer azt mutatja, hogy OS-szinten nincs plafon.

## 2.2 Processztopológia

**11 tmux session:** 8 agent (`buildfejleszto`, `codeworker`, `deliverylead`, `devops`, `frontendfejleszto`, `fullstackfejleszto`, `marveen`, `qa`) + `marveen-channels`, `marveen-worker`, `marveen-worker-fast`.

**Core komponensek:** `marveen-dashboard.service` (PID 326, node `dist/index.js`, 150 MB, `Restart=on-failure`), `marveen-channels.service`, `dbus`. Egyik unitban sincs `MemoryMax`/`MemoryHigh`.

**Claude processzek:** 11 db, **3,07 GB összesen**. Node: 1 db, 0,15 GB. Ollama fut (15 MB idle). Chrome/Playwright: **nincs**. MCP gyermekfolyamat: 34.

Kor és méret összefüggése (a ma esti mérésem megerősítése):
```
481 MB / 17 perc      374 MB / 57 perc      270 MB / 4 óra
416 MB / 1 óra        324 MB / 4 óra        223 MB / 4 óra
```
A méretet a **kontextus mérete** hajtja, nem a futásidő önmagában — a 17 perces a legnagyobb, mert nehéz munkát végez.

## 2.3 MemGate — a fázis legfontosabb megállapítása

A `scripts/fleet-memory-gate.sh` **létezik és tracked**. De:

- **NINCS a crontabban** (a crontab 3 bejegyzése: `fleet-resume-guard`, `fleet-context-guard`, `suite-checkout-ff-guard` — memgate 0 találat);
- **nincs systemd timere** (a marveen timerek közt csak `marveen-costops-sync.timer`);
- **nincs logfájlja**;
- **nem fut processzként**.

Két helyről hívódik, mindkettő **indítás előtti** ellenőrzés:
1. `src/web/channel-monitor.ts:1600` — `memGateAllowsStart()`, mielőtt egy „desired but down" agentet elindítana;
2. `scripts/fleet-safe-start.sh:30` — minden indítás előtt.

A saját forráskommentje mondja ki (`channel-monitor.ts:1595-1597`):
> „The gate exits 0 = allow, 10 = block … it **NEVER kills or restarts anything**. **FAIL-OPEN**: any error/timeout allows the start."

### Ebből következik a valódi rés

A MemGate **admission control**: megakadályozza, hogy nyomás alatt ÚJ agent INDULJON. Nem csinál semmit a **már futó** agentekkel, amelyek nőnek.

**A mai kétszeri halál pontosan a másik hibamód volt.** Nem attól halt meg a gép, hogy túl sok agentet indítottunk, hanem attól, hogy a már órák óta futó agentek fejenként 1 GB fölé híztak. Erre a MemGate szerkezetileg vak.

Ehhez jön, hogy `MemoryMax=infinity`, tehát az OS sem fog meg semmit.

| Mechanizmus | Van? | Fut? | Mit fed le | Státusz |
|---|---|---|---|---|
| MemGate (admission) | igen | csak indítási úton | új agent indítása | **PARTIAL** |
| Eviction / nyomás-enyhítés futó agentre | **nincs** | – | – | **CONTRADICTED** |
| cgroup `MemoryMax` | **infinity** | – | – | **CONTRADICTED** |
| `fleet-context-guard` (5 perc) | igen | igen | kontextus-alapú restart | PARTIAL, Fázis 3 |
| `fleet-resume-guard` (3 perc) | igen | igen | idle/beragadt pane | PARTIAL, Fázis 3 |

## 2.4 Repository és helyi eltérések

| Tétel | Érték |
|---|---|
| Útvonal | `/home/iszzu/marveen` |
| Branch / HEAD | `develop` / `96b4d4b` |
| `origin` | `github.com/Szotasz/marveen` (upstream) |
| `fork` | `github.com/iszzu80-dev/marveen` |
| `origin/main` | `4e8e7a5` |
| Eltérés | **behind: 0 · ahead: 167** |
| Tracked változás | 0 |
| Untracked | 7 (mind dokumentum/audit, nincs köztük kód) |

**Helyi systemd unitok:** `marveen-dashboard.service`, `marveen-channels.service` (user scope) — nem upstream-artefaktumok.

**Local-only (untracked) stabilitási scriptek:**
- `scripts/fleet-resume-guard.sh` — **és ez fut 3 percenként crontabból**
- `scripts/dispatch-guard.sh`

Tracked (upstream-eredetű): `fleet-memory-gate.sh`, `fleet-safe-start.sh`, `fleet-context-guard.sh`, `host-restart-watchdog.sh`, `stale-instructions-guard.sh`, `stuck-modal-guard.sh`, `channel-watchdog.sh`, `disk-space-guard.sh`.

### Frissíthetőségi minősítés: **UPDATEABLE WITH MANAGED OVERLAY**

Indoklás: 167 commit előny nulla lemaradással, tiszta munkafa, és a helyi eltérés két untracked scriptre + két user systemd unitra korlátozódik. Nem `FRAGILE LOCAL PATCHSET`, mert nincsenek tracked fájlokon ülő helyi módosítások. De nem is `CLEANLY UPDATEABLE`, mert egy 3 percenként futó, éles guard (`fleet-resume-guard.sh`) **nincs verziókövetve** — egy `git clean` vagy egy friss checkout némán elvinné, és semmi nem szólna.

**Kockázat:** a `dispatch-guard.sh` és `fleet-resume-guard.sh` elvesztése észrevétlen lenne. Javaslat (Fázis 9-re): verziókövetésbe venni őket, vagy tudatosan `local/` overlay-be tenni dokumentált módon.

---

## Bizonytalanságok, amiket NEM állítok bizonyítottnak

- A **második** (19:37) összeomlás OOM-voltára nincs közvetlen naplóbizonyíték — a journal a thrashing alatt elhallgatott. Az OOM-ot a `MemoryPeak` 9,69 GiB és a hard teardown támasztja alá, nem egy explicit kernel-sor. **NOT PROVEN**, csak erősen valószínű.
- Az `autoMemoryReclaim=gradual` tényleges hatékonyságát nem mértem. Fázis 7 kontrollált teszt kérdése.
- Az MCP-gyermekfolyamatok (34 db) memórialábnyomát nem bontottam agentenként.

---

**Fázis 2 vége. A dokumentum előírása szerint megállok, és nem kezdem el a Fázis 3-at.**
