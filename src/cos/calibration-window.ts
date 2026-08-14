/**
 * §1.4.1 — a kalibrációs ablak, és a három szabály, ami nélkül a befagyasztás papír.
 *
 * Marveen döntése után: a kalibráció a FAGYÁSTÓL számol. Ez egyszerre old meg
 * hármat — a migrációs csúcs kívül esik, az intake fagyott (tehát a nevező nem
 * mozdulhat a kísérlet alatt), és a triage által létrehozott ügyek bent
 * maradnak, ahol a helyük van.
 *
 * Az utolsó tagmondat a lényeges, és Marveen a saját korábbi figyelmeztetését
 * pontosította vele. Igaz, hogy a mai ügyeket a saját email-triage heartbeatje
 * hozta létre, de az email-triage NEM mérési műtermék: az a termelési beviteli
 * út, ami a kísérlet alatt is futni fog. Az általa létrehozott ügyek kizárása
 * egy nem létező populációt mérne, és a küszöböt egy soha nem futó rendszerre
 * méretezné. A figyelmeztetés ott érvényes, ahol felmerült — az ORGANIKUS
 * ÉRKEZÉSI RÁTA becslésénél. A kalibráció nem azt becsüli, hanem a jogosult
 * megfigyelések volumenét abban a rendszerben, ahogy ténylegesen működni fog.
 *
 * A valódi szennyeződés más, és korábbi: 45 ügy 2026-08-06-án, ami migráció és
 * nem érkezés, és soha nem fog megismétlődni. Bármely ablak, ami átér rajta,
 * felfelé torzít — pont olyan mennyiséggel, ami meggyőzőnek látszik.
 *
 * A három szabály, mind kapuként:
 *
 *   1. csak olyan ablak számít, ami TELJES egészében a fagyás után kezdődik és
 *      végződik;
 *   2. ha a hash egy ablak KÖZBEN változik, azt az ablakot EGÉSZBEN el kell
 *      dobni, nem levágni — egy félig fagyott ablak nem fagyott ablak, és a
 *      levágott rész pont azt a szakaszt tartaná meg, amelyikről nem tudjuk,
 *      milyen konfiguráción futott;
 *   3. mivel az intake a fagyasztott készülék RÉSZE, a kalibráció ennek a
 *      konfigurációnak a volumenét méri: ha később bővül a bevitel, a kalibrált
 *      küszöb LEJÁR.
 *
 * A harmadikat előre kell kimondani, különben a küszöb tovább él, mint a
 * rendszer, amire mérték, és senki nem veszi észre.
 */
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface CalibrationFreeze {
  /** A commit, amin a fagyás történt — emberi horgony, nem a kapu. */
  calibrationCommit: string
  /** A KÓD tartalom-hashe (detektor + intake modulok). */
  detectorConfigFingerprint: string
  /**
   * Az intake FELÜLET hashe.
   *
   * Külön mező, mert a kettő különböző módon romlik el. A forrás-hash a kódot
   * fedi; egy új konnektor viszont ADAT, nem kód — bekerülhet anélkül, hogy egy
   * `.ts` fájl megváltozna, és pontosan azt a bővülést jelenti, amitől a
   * kalibrált küszöb lejár.
   */
  intakeSurfaceFingerprint: string
  frozenAt: number
}

/**
 * A beviteli felület hashe a regisztrált konnektorokból.
 *
 * `connector_id | kind | mode` — és SZÁNDÉKOSAN nem a `status`. Egy ma DOWN
 * konnektor nem másik beviteli felület, csak egy rosszul lévő ugyanaz; ha a
 * státusz benne lenne, minden átmeneti hiba lejárttá tenné a kalibrációt, és
 * egy kapu, ami naponta zajból tüzel, az a kapu, amit kikapcsolnak.
 *
 * A `mode` viszont benne van: egy READ_ONLY → READ_WRITE váltás valódi
 * felület-bővülés.
 */
export function intakeSurfaceFingerprint(db: Database.Database): string {
  const h = createHash('sha256')
  let rows: Array<{ connector_id: string; kind: string; mode: string }> = []
  try {
    rows = db.prepare(
      `SELECT connector_id, kind, mode FROM connector_health ORDER BY connector_id`,
    ).all() as Array<{ connector_id: string; kind: string; mode: string }>
  } catch {
    // Nincs tábla: üres felület. Nem dobunk, mert a hash célja az ÖSSZEHASONLÍTÁS,
    // és egy üres felület konzisztensen üres marad, amíg tényleg az.
    rows = []
  }
  for (const r of rows) h.update(`${r.connector_id}|${r.kind}|${r.mode}\n`)
  return h.digest('hex').slice(0, 32)
}

export type WindowState =
  | 'OPEN'
  | 'VALID'
  | 'VOID_STARTED_BEFORE_FREEZE'
  | 'VOID_CONFIG_CHANGED_MIDWINDOW'

export interface CalibrationWindow {
  windowId: string
  openedAt: number
  closedAt: number | null
  state: WindowState
  /** A címkézési menet által mért volumen. Csak VALID ablakban számít. */
  observationCount: number | null
  detail: string
}

export function ensureCalibrationSchema(db: Database.Database): void {
  // A fagyás EGYETLEN sor, és végleges. Egy fagyás, amit át lehet írni, nem
  // fagyás — és a felülírás pont akkor lenne csábító, amikor a mérés nem úgy
  // alakul, ahogy szerettük volna.
  db.exec(`
    CREATE TABLE IF NOT EXISTS calibration_freeze (
      id                          INTEGER PRIMARY KEY CHECK (id = 1),
      calibration_commit          TEXT NOT NULL,
      detector_config_fingerprint TEXT NOT NULL,
      intake_surface_fingerprint  TEXT NOT NULL,
      frozen_at                   INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_calibration_freeze_no_update
    BEFORE UPDATE ON calibration_freeze
    BEGIN SELECT RAISE(ABORT, 'a befagyasztas vegleges'); END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_calibration_freeze_no_delete
    BEFORE DELETE ON calibration_freeze
    BEGIN SELECT RAISE(ABORT, 'a befagyasztas vegleges'); END
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS calibration_windows (
      window_id         TEXT PRIMARY KEY,
      opened_at         INTEGER NOT NULL,
      closed_at         INTEGER,
      state             TEXT NOT NULL,
      observation_count INTEGER,
      detail            TEXT NOT NULL DEFAULT '',
      CHECK (state IN ('OPEN','VALID','VOID_STARTED_BEFORE_FREEZE','VOID_CONFIG_CHANGED_MIDWINDOW'))
    )
  `)
  // A konfiguráció-megfigyelések nyoma. APPEND-ONLY: ebből derül ki, hogy az
  // ablak közben elmozdult-e a készülék, és ha a sorokat át lehetne írni, a
  // 2. szabály egy megjegyzés lenne.
  db.exec(`
    CREATE TABLE IF NOT EXISTS calibration_config_observations (
      window_id                   TEXT NOT NULL,
      observed_at                 INTEGER NOT NULL,
      detector_config_fingerprint TEXT NOT NULL,
      intake_surface_fingerprint  TEXT NOT NULL,
      PRIMARY KEY (window_id, observed_at)
    )
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_calibration_obs_no_update
    BEFORE UPDATE ON calibration_config_observations
    BEGIN SELECT RAISE(ABORT, 'a konfiguracio-megfigyeles vegleges'); END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_calibration_obs_no_delete
    BEFORE DELETE ON calibration_config_observations
    BEGIN SELECT RAISE(ABORT, 'a konfiguracio-megfigyeles vegleges'); END
  `)
  // A fagyás ELŐTTI stabilitás-nyomvonal.
  //
  // Ez volt az utolsó memóriában tartott lépés az egész láncban: „reggelig
  // figyelem a két ujjlenyomatot". Egy megfigyelés, ami csak valakinek az
  // emlékezetében él, utólag nem különböztethető meg egy meg nem történttől —
  // és pont a fagyasztás az a pont, ahol a legkevésbé engedhetjük meg.
  db.exec(`
    CREATE TABLE IF NOT EXISTS calibration_stability_observations (
      observed_at                 INTEGER PRIMARY KEY,
      detector_config_fingerprint TEXT NOT NULL,
      intake_surface_fingerprint  TEXT NOT NULL,
      case_cycles_ran             INTEGER NOT NULL,
      triage_runs_ran             INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_calibration_stability_no_update
    BEFORE UPDATE ON calibration_stability_observations
    BEGIN SELECT RAISE(ABORT, 'a stabilitas-megfigyeles vegleges'); END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_calibration_stability_no_delete
    BEFORE DELETE ON calibration_stability_observations
    BEGIN SELECT RAISE(ABORT, 'a stabilitas-megfigyeles vegleges'); END
  `)
}

// ── Fagyás ELŐTTI stabilitás ────────────────────────────────────────────

/**
 * Marveen fagyasztás-előtti feltétele, nyomvonalként.
 *
 * A saját szavaival: *„Nem az számít, hogy ma nem nyúltál hozzá, hanem hogy a
 * fagyasztott konfiguráció FUTOTT is már, nem csak be van tolva."*
 *
 * Ezért van a `cyclesRan`. Két azonos ujjlenyomat önmagában csak annyit
 * bizonyít, hogy két időpontban ugyanaz a kód volt a lemezen — azt nem, hogy a
 * készülék működött közben. Egy fagyasztás egy soha nem futott konfiguráción
 * ugyanaz a hiba, mint egy mozgón, csak nehezebb észrevenni.
 */
export interface StabilityObservation {
  observedAt: number
  detectorConfigFingerprint: string
  intakeSurfaceFingerprint: string
  /**
   * Két monoton számláló, nem egy összeg.
   *
   * Marveen feltétele szó szerint „legalább egy teljes **triage- és** ügyciklus".
   * Egy összegzett számlálóval hat triage-futás és nulla ügyciklus is átmenne —
   * ami pontosan ugyanaz a hiba egy szinttel lejjebb: a rendszer mozog, de nem
   * az a része, amiről bizonyítani akarunk valamit.
   */
  caseCyclesRan: number
  triageRunsRan: number
}

export type StabilityVerdict =
  | {
    stable: true; sinceAt: number; provenAt: number
    caseCyclesBetween: number; triageRunsBetween: number
  }
  | { stable: false; reason: string }

/** Append-only. Egy elsimítható nyomvonal nem bizonyíték. */
export function recordStabilityObservation(
  db: Database.Database, obs: StabilityObservation,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO calibration_stability_observations
       (observed_at, detector_config_fingerprint, intake_surface_fingerprint,
        case_cycles_ran, triage_runs_ran)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    obs.observedAt, obs.detectorConfigFingerprint,
    obs.intakeSurfaceFingerprint, obs.caseCyclesRan, obs.triageRunsRan,
  )
}

/**
 * Áll-e a készülék — a KÉT LEGUTÓBBI megfigyelés alapján.
 *
 * Szándékosan a két legutóbbi, nem „volt-e valaha két egyforma". Egy régi stabil
 * pár nem mond semmit egy tegnapi landolás után, és a „volt már ilyen" alakú
 * bizonyíték pont akkor a legcsábítóbb, amikor a friss adat nem elég.
 */
export function assertConfigStable(db: Database.Database): StabilityVerdict {
  let rows: Array<{ observed_at: number; d: string; i: string; c: number; t: number }> = []
  try {
    rows = db.prepare(
      `SELECT observed_at, detector_config_fingerprint AS d,
              intake_surface_fingerprint AS i,
              case_cycles_ran AS c, triage_runs_ran AS t
         FROM calibration_stability_observations
        ORDER BY observed_at DESC LIMIT 2`,
    ).all() as typeof rows
  } catch { rows = [] }
  if (rows.length < 2) {
    return {
      stable: false,
      reason: 'kevesebb mint ket ellenorzes van — egy pillanatkep nem stabilitas',
    }
  }
  const [later, earlier] = rows
  if (later.d !== earlier.d) {
    return { stable: false, reason: 'a detektor-konfiguracio elmozdult a ket ellenorzes kozott' }
  }
  if (later.i !== earlier.i) {
    return { stable: false, reason: 'a beviteli felulet elmozdult a ket ellenorzes kozott' }
  }
  if (later.c <= earlier.c) {
    return {
      stable: false,
      reason:
        'a ket ellenorzes kozott nem futott le UGYCIKLUS — a konfiguracio be van tolva, '
        + 'de nem mutatta meg, hogy mukodik',
    }
  }
  if (later.t <= earlier.t) {
    return {
      stable: false,
      reason:
        'a ket ellenorzes kozott nem futott le TRIAGE-ciklus — a beviteli ut nem mutatta meg, '
        + 'hogy mukodik, es a nevezo eppen rola szol',
    }
  }
  return {
    stable: true, sinceAt: earlier.observed_at, provenAt: later.observed_at,
    caseCyclesBetween: later.c - earlier.c, triageRunsBetween: later.t - earlier.t,
  }
}

export type FreezeResult = { ok: true; provenAt: number } | { ok: false; reason: string }

/**
 * Befagyaszt. Egyszer, és csak álló készüléken.
 *
 * A stabilitás-feltétel itt KAPU, nem ajánlás. Marveen döntése marad, hogy
 * MIKOR mondja ki; ez csak azt zárja ki, hogy egy mozgó vagy soha nem futott
 * konfiguráción mondja ki — ami pontosan az, amit ő maga nem akar. Egy
 * fagyasztás egy mozgó készüléken nem gyengébb mérés: nem mérés.
 *
 * A bizonyított és a befagyasztott ujjlenyomatnak EGYEZNIE kell. Enélkül a
 * stabilitást az egyik konfiguráción lehetne bizonyítani, és egy másikat
 * befagyasztani — és pont ez az a lépés, ami sosem szándékosan történik.
 */
export function freezeCalibration(
  db: Database.Database, freeze: CalibrationFreeze,
): FreezeResult {
  const stability = assertConfigStable(db)
  if (!stability.stable) {
    return { ok: false, reason: `a keszulek nem bizonyitottan all: ${stability.reason}` }
  }
  const proven = db.prepare(
    `SELECT detector_config_fingerprint AS d, intake_surface_fingerprint AS i
       FROM calibration_stability_observations ORDER BY observed_at DESC LIMIT 1`,
  ).get() as { d: string; i: string }
  if (proven.d !== freeze.detectorConfigFingerprint
    || proven.i !== freeze.intakeSurfaceFingerprint) {
    return {
      ok: false,
      reason:
        'a befagyasztott ujjlenyomat nem az, amin a stabilitas bizonyitva lett — '
        + 'egy masik konfiguracio fagyasztasa a bizonyitekot ervenytelenne teszi',
    }
  }
  try {
    db.prepare(
      `INSERT INTO calibration_freeze
         (id, calibration_commit, detector_config_fingerprint, intake_surface_fingerprint, frozen_at)
       VALUES (1, ?, ?, ?, ?)`,
    ).run(
      freeze.calibrationCommit, freeze.detectorConfigFingerprint,
      freeze.intakeSurfaceFingerprint, freeze.frozenAt,
    )
  } catch {
    return { ok: false, reason: 'mar van befagyasztas — a befagyasztas vegleges' }
  }
  return { ok: true, provenAt: stability.provenAt }
}

export function readFreeze(db: Database.Database): CalibrationFreeze | null {
  try {
    const r = db.prepare(`SELECT * FROM calibration_freeze WHERE id = 1`).get() as {
      calibration_commit: string; detector_config_fingerprint: string
      intake_surface_fingerprint: string; frozen_at: number
    } | undefined
    if (!r) return null
    return {
      calibrationCommit: r.calibration_commit,
      detectorConfigFingerprint: r.detector_config_fingerprint,
      intakeSurfaceFingerprint: r.intake_surface_fingerprint,
      frozenAt: r.frozen_at,
    }
  } catch { return null }
}

export type OpenResult = { ok: true } | { ok: false; reason: string }

/**
 * Szabály 1: az ablak nem kezdődhet a fagyás előtt.
 *
 * A refuzálás a NYITÁSNÁL van, nem a zárásnál. Egy ablak, ami hetekig gyűjt, és
 * csak a végén derül ki róla, hogy sosem számított, pontosan az a fajta
 * pazarlás, ami után a szabályt szeretnénk meghajlítani.
 */
export function openCalibrationWindow(
  db: Database.Database, windowId: string, openedAt: number,
): OpenResult {
  const freeze = readFreeze(db)
  if (!freeze) {
    return { ok: false, reason: 'nincs befagyasztas — kalibracios ablak elotte nem nyithato' }
  }
  if (openedAt < freeze.frozenAt) {
    // Rögzítjük is, VOID állapotban. Egy néma elutasítás nem hagy nyomot arról,
    // hogy valaki egy fagyás elé nyúló ablakot akart megnyitni.
    try {
      db.prepare(
        `INSERT INTO calibration_windows (window_id, opened_at, closed_at, state, detail)
         VALUES (?, ?, NULL, 'VOID_STARTED_BEFORE_FREEZE', ?)`,
      ).run(windowId, openedAt, 'a fagyas elott kezdodott')
    } catch { /* már létezik: a meglévő állapot marad */ }
    return {
      ok: false,
      reason:
        'az ablak a fagyas elott kezdodne — csak olyan ablak szamit, ami TELJES egeszeben '
        + 'a fagyas utan kezdodik es vegzodik (a 2026-08-06-i migracios csucs igy esik kivul)',
    }
  }
  try {
    db.prepare(
      `INSERT INTO calibration_windows (window_id, opened_at, closed_at, state)
       VALUES (?, ?, NULL, 'OPEN')`,
    ).run(windowId, openedAt)
  } catch {
    return { ok: false, reason: 'ez az ablak mar letezik' }
  }
  return { ok: true }
}

/** Egy konfiguráció-mérés az ablak alatt. Append-only. */
export function observeConfig(
  db: Database.Database,
  obs: {
    windowId: string; observedAt: number
    detectorConfigFingerprint: string; intakeSurfaceFingerprint: string
  },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO calibration_config_observations
       (window_id, observed_at, detector_config_fingerprint, intake_surface_fingerprint)
     VALUES (?, ?, ?, ?)`,
  ).run(
    obs.windowId, obs.observedAt,
    obs.detectorConfigFingerprint, obs.intakeSurfaceFingerprint,
  )
}

/**
 * Szabály 2: egészben eldobni, nem levágni.
 *
 * Figyeld meg, mit NEM ad vissza ez a függvény: nincs `usableUntil`, nincs
 * `validPrefix`, nincs olyan mező, amiből egy hívó összerakhatna egy megtartható
 * részt. Ez nem hiányosság — a levágott ablak pont azt a szakaszt tartaná meg,
 * amelyikről nem tudjuk, milyen konfiguráción futott, és a részablak formájú
 * visszatérési érték előbb-utóbb megtalálná a maga hívóját.
 */
export function closeCalibrationWindow(
  db: Database.Database,
  windowId: string,
  closedAt: number,
  observationCount: number,
): CalibrationWindow {
  const row = db.prepare(
    `SELECT * FROM calibration_windows WHERE window_id = ?`,
  ).get(windowId) as {
    window_id: string; opened_at: number; closed_at: number | null
    state: WindowState; observation_count: number | null; detail: string
  } | undefined
  if (!row) throw new Error(`nincs ilyen kalibracios ablak: ${windowId}`)
  if (row.state !== 'OPEN') return toWindow(row)

  const freeze = readFreeze(db)
  const drift = freeze
    ? db.prepare(
      `SELECT observed_at, detector_config_fingerprint AS d, intake_surface_fingerprint AS i
         FROM calibration_config_observations
        WHERE window_id = ?
          AND (detector_config_fingerprint != ? OR intake_surface_fingerprint != ?)
        ORDER BY observed_at LIMIT 1`,
    ).get(
      windowId, freeze.detectorConfigFingerprint, freeze.intakeSurfaceFingerprint,
    ) as { observed_at: number; d: string; i: string } | undefined
    : undefined

  let state: WindowState = 'VALID'
  let detail = ''
  let count: number | null = observationCount
  if (drift) {
    state = 'VOID_CONFIG_CHANGED_MIDWINDOW'
    // A számláló NEM a megfigyelt érték, hanem null. Egy eldobott ablakban
    // tárolt "de azért ennyi volt" szám az a szám, amit valaki egyszer
    // összeadna a jókkal.
    count = null
    detail =
      `a keszulek az ablak kozben elmozdult (${new Date(drift.observed_at * 1000).toISOString()}) — `
      + 'az ablak EGESZBEN eldobva, nem levagva'
  }
  db.prepare(
    `UPDATE calibration_windows
        SET closed_at = ?, state = ?, observation_count = ?, detail = ?
      WHERE window_id = ?`,
  ).run(closedAt, state, count, detail, windowId)
  return toWindow({
    window_id: windowId, opened_at: row.opened_at, closed_at: closedAt,
    state, observation_count: count, detail,
  })
}

function toWindow(r: {
  window_id: string; opened_at: number; closed_at: number | null
  state: WindowState; observation_count: number | null; detail: string
}): CalibrationWindow {
  return {
    windowId: r.window_id, openedAt: r.opened_at, closedAt: r.closed_at,
    state: r.state, observationCount: r.observation_count, detail: r.detail,
  }
}

export function readWindow(db: Database.Database, windowId: string): CalibrationWindow | null {
  const r = db.prepare(`SELECT * FROM calibration_windows WHERE window_id = ?`).get(windowId) as
    Parameters<typeof toWindow>[0] | undefined
  return r ? toWindow(r) : null
}

/**
 * A kalibrált volumen: KIZÁRÓLAG a VALID ablakokból.
 *
 * Ez az a pont, ahol a 2. szabály ténylegesen számít. Egy eldobott ablak nem
 * "kevesebbet ér" — nulla.
 */
export function calibratedObservationTotal(db: Database.Database): number {
  const r = db.prepare(
    `SELECT COALESCE(SUM(observation_count), 0) AS n
       FROM calibration_windows WHERE state = 'VALID'`,
  ).get() as { n: number }
  return r.n
}

export type CalibrationValidity =
  | { ok: true }
  | { ok: false; reason: string; expired: boolean }

/**
 * Szabály 3: a lejárati feltétel.
 *
 * Mivel az intake a fagyasztott készülék része, a kalibráció ENNEK a
 * konfigurációnak a volumenét méri. Egy új konnektor vagy egy szélesebb triage
 * után a küszöb egy olyan rendszerre van méretezve, ami már nem fut — és ez a
 * fajta elavulás az, ami magától soha nem derül ki, mert semmi nem hibázik
 * tőle.
 */
export function assertCalibrationStillValid(
  db: Database.Database,
  current: { detectorConfigFingerprint: string; intakeSurfaceFingerprint: string },
): CalibrationValidity {
  const freeze = readFreeze(db)
  if (!freeze) return { ok: true }
  if (freeze.detectorConfigFingerprint !== current.detectorConfigFingerprint) {
    return {
      ok: false, expired: true,
      reason:
        'a detektor-konfiguracio megvaltozott a fagyas ota — a kalibralt kuszob egy mar '
        + 'nem futo rendszerre van meretezve',
    }
  }
  if (freeze.intakeSurfaceFingerprint !== current.intakeSurfaceFingerprint) {
    return {
      ok: false, expired: true,
      reason:
        'a beviteli felulet bovult a fagyas ota (uj konnektor vagy szelesebb mod) — '
        + 'a kalibralt kuszob LEJART, ujra kell kalibralni',
    }
  }
  return { ok: true }
}
