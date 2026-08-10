# Operatív változások naplója

Ez a fájl azt rögzíti, amit **nem a kód** változtat: élő adat, ütemezés,
szolgáltatás-újraindítás, külső repó. A kód-változásokat a commit-üzenetek
írják le, azokat itt nem ismételjük.

**Miért kell.** 2026-08-10-én Istvan rákérdezett, hogy minden változtatásom
dokumentált-e a repóban. A kód igen, 36 committal. Az operatív lépések viszont
három különböző helyen éltek: az adatbázis eseménynaplójában, kártya-
kommentekben, és egy verziókövetés nélküli config-fájl leírás-mezőjében. Egyik
sem hazugság, de együtt nem alkotnak történetet, és a legfontosabb kapcsolónak
(fut-e a motor) egyáltalán nem volt nyoma. Ez a fájl a hiányzó egy hely.

**Szabály.** Minden bejegyzés tartalmazza: mikor, mit, MIÉRT, mi a bizonyíték,
és hogyan lehet visszacsinálni. Bizonyíték nélküli bejegyzés nem bejegyzés.

---

## 2026-08-10

### 03:15 — a haladás-motor ütemezése LEÁLLÍTVA
- **Mit:** `personal-case-wake` → `enabled: false`.
- **Miért:** a motor generikus, önigazoló DoD-vel automatikusan lezárta az
  ügyeket. A 19 lezárt személyes ügyből 17 a motor műve, mind a 72 lezárási
  döntés szó szerint azonos indoklással.
- **Bizonyíték:** DB-másolaton hat ciklus: 1-3. semmi, a 4.-ben 45 ügy lezárul.
- **Visszaút:** `task-config.json.bak-preP0-20260810-0315`.

### 03:53 — 26 tévesen lezárt ügy VISSZAÁLLÍTVA
- **Mit:** 17 személyes + 9 céges ügy vissza az eseménynaplóból, a
  `previous_status` alapján. Személyes COMPLETED 19 → 2, céges 9 → 0.
- **Miért:** a fenti lezárások semmisek voltak; a bennük foglalt ügyek
  (gyerektartás, vízszámla, fogkezelés, UK ETA) nem voltak elintézve.
- **Hogyan:** `scripts/cos-restore-engine-closed-cases.ts`, a case store-on át
  (nem SQL-lel), tehát a visszaállítás maga is auditálható eseményeket írt.
- **Bizonyíték:** 26 `Restored from event...` esemény a naplóban.
- **Visszaút:** `store/claudeclaw.db.bak-prerestore-20260810-0400` + a
  visszaállítás minden lépése visszafordítható átmenet.

### 04:05 — 72 ügy FELOLVASZTVA
- **Mit:** `progression_enabled = 1` **és** `next_progression_at = most` 36
  személyes + 36 céges ügyön.
- **Miért:** a 2026-08-09-i incidens után a státusz helyreállt, a haladás-
  kapcsoló nem; 27 ügy egy napig élőnek látszott, miközben semmi nem nézte.
- **Bizonyíték:** az első verzióm CSAK a kapcsolót állította, 72-t jelentett, és
  a következő heartbeat 24-et vett fel — a `next_progression_at` NULL maradt.
  Javítva, majd élesben ellenőrizve: 90 ügy egy cikluson.
- **Visszaút:** `scripts/cos-unfreeze-progression.ts` fordítottja, illetve a
  fenti adatbázis-mentés.

### 04:05 — a haladás-motor ütemezése VISSZAKAPCSOLVA
- **Mit:** `personal-case-wake` → `enabled: true`.
- **Miért:** a DoD-javítás kész és mérve.
- **Bizonyíték (a visszakapcsolás DoD-je):** az élő állapot másolatán mind a 96
  ügy, 6 ciklus, **0 lezárás** — ugyanaz a másolat a javítás előtti kódon a 4.
  ciklusban 45-öt zárt le. Élesben azóta 7653 futás, 0 lezárás.
- **Visszaút:** `task-config.json.bak-prearm-20260810-0405`.

### 04:21 és 05:10 — `dist` ÚJRAÉPÍTVE + a dashboard ÚJRAINDÍTVA
- **Mit:** `npx tsc` + `systemctl --user restart marveen-dashboard.service`.
- **Miért:** a dashboard a `dist`-et szolgálja ki. A céges kimenő ajtó és a
  szálazás-javítás a forrásban élt, a végpont közben 404-et adott.
- **Bizonyíték:** a restart után GET `/api/cos/zst-escalations` → 200, POST
  `zst-outbound/draft` üres törzsre → 400. Új kapu-kritérium (ZO-5) azóta
  méri, hogy az ajtó a KISZOLGÁLT csomagban is benne van.
- **Visszaút:** `dist.bak-prezstdoor-20260810-042111`,
  `dist.bak-prethread-*`.

### 05:04 — ELSŐ valódi céges e-mail a kimenő ajtón
- **Mit:** Dr. Vámosi Zoltánnak, a ZST üzletrész-ügyben, a céges címről.
- **Jóváhagyás:** Istvan, a pontos szövegre és az egy címzettre.
- **Bizonyíték:** `zst_outbound_ledger` egy sor, `APPLIED_UNVERIFIED`,
  external_ref `19fe9a16d13cf48a`; a levél függetlenül visszaolvasva a céges
  postafiókból.
- **Következmény, amit előre nem jeleztem:** nem volt `In-Reply-To` fejléc, így
  új szálat nyitott. Javítva (`1ab330e`), de a saját postafiókunkban a
  szálazás még hiányos — kártya `169fca9b`.

### 08:11 — ugyanaz a levél a PRIVÁT címről, javítva
- **Mit:** Istvan kérésére újraküldve iszzu80@gmail.com-ról, azzal a
  megjegyzéssel, hogy az előző véletlenül a céges címről ment.
- **Bizonyíték:** a Gmail API metadata-lekérdezése szerint a kiküldött levélen
  rajta van az `In-Reply-To` és a teljes `References` lánc — a szálazás-javítás
  első éles igazolása.

### 16:03 — a teljes fejlesztés FELTÖLTVE két PRIVÁT GitHub repóba
- **Mit:** `iszzu80-dev/marveen-private` (1410 commit: cos, costops,
  optimization, apg) és `iszzu80-dev/marveen-apg-kernel` (37 commit).
- **Miért:** a helyi `develop` 436 committal járt az origin előtt, 522-vel a
  fork előtt. A Chief of Staff, a Lean optimalizáció és az APG **sehol** nem
  volt fent.
- **Döntés, amit magamtól hoztam:** nem a meglévő `iszzu80-dev/marveen` forkba,
  mert az PUBLIKUS, a kód és a dokumentáció pedig személyes és céges ügy-
  szerkezetet tartalmaz. A publikus feltöltés visszafordíthatatlan, a privát
  bármikor publikussá tehető.

### 18:08 — 35 dokumentum, köztük az ALAPÍTÓ specifikációk
- **Mit:** a négy Chief of Staff spec (v4 … v4.2.1), mind a kilenc APG spec
  (1.0 … 1.8), a ZST elemzések, a Lean végrehajtási specifikációk.
- **Miért nem voltak fent:** soha nem lettek `git add`-elve. Nem `.gitignore`
  tiltotta őket, ezt ellenőriztem.

### 18:33 — az AI cél-értelmező BEKÖTVE
- **Mit:** `enrichPendingGoals` a heartbeatben, ciklusonként 5 ügy.
- **Miért:** az értelmező kész volt és nem futott, ezért minden cél státusz-
  sablonból jött.
- **Amit menet közben találtam:** az idempotencia-őr a `goal` mezőt nézte, amit
  a determinisztikus motor minden futásnál kitölt — a bekötés önmagában minden
  ügyre azt mondta volna, hogy „már értelmezve". Az őr most a `summary`, amit
  kizárólag az értelmező ír.
- **Állapot:** ÉLESBEN MÉG NEM FUT — nincs Anthropic API-kulcs a futtató
  környezetében. Minden ciklus hangosan jelenti, hogy nem tudott elindulni.

### 18:40 — a 31 ütemezett feladat konfigja VERZIÓKÖVETVE
- **Mit:** `ops/scheduled-tasks/` a repóban.
- **Miért:** a motor ki- és bekapcsolása ma két olyan fájlszerkesztés volt,
  aminek nem volt története.
- **Nyitott:** ez pillanatkép-másolat, nem szimlink. Az élő helyet
  (`~/.claude/scheduled-tasks/`) továbbra is a scheduler olvassa; a
  szinkronban tartás megoldatlan, és ezt jobb kimondani, mint úgy tenni,
  mintha az egyirányú másolás megoldás lenne.
