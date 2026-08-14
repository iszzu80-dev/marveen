// §1.4.1 — a kalibrációs ablak három szabálya.
//
// Marveen döntése: a kalibráció a FAGYÁSTÓL számol. És a saját korábbi
// figyelmeztetését pontosította hozzá, mert félrevezetőbb volt, mint amennyire
// igaz: az email-triage NEM mérési műtermék, hanem a termelési beviteli út, ami
// a kísérlet alatt is futni fog. Az általa létrehozott ügyek kizárása egy nem
// létező populációt mérne, és a küszöböt egy soha nem futó rendszerre
// méretezné — rosszabb hiba, mint amitől óvott.
//
// A valódi szennyeződés korábbi: 45 ügy 2026-08-06-án, ami migráció és nem
// érkezés, és soha nem ismétlődik meg. A fagyás-utáni ablak ezt kizárja anélkül,
// hogy bárkinek dátumot kellene karbantartania.
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  ensureCalibrationSchema, freezeCalibration, readFreeze, intakeSurfaceFingerprint,
  openCalibrationWindow, observeConfig, closeCalibrationWindow, readWindow,
  calibratedObservationTotal, assertCalibrationStillValid,
  recordStabilityObservation, assertConfigStable,
} from '../cos/calibration-window.js'

const T_FREEZE = 1_700_000_000
const DET = 'e2181cf18b700395d0e68d1aca22430d'
let db: Database.Database

function connectorTable(): void {
  db.exec(`
    CREATE TABLE connector_health (
      connector_id TEXT PRIMARY KEY, kind TEXT NOT NULL, mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OK'
    )
  `)
}
function addConnector(id: string, kind: string, mode = 'READ_ONLY', status = 'OK'): void {
  db.prepare(`INSERT INTO connector_health (connector_id, kind, mode, status) VALUES (?,?,?,?)`)
    .run(id, kind, mode, status)
}

/** Két ellenőrzés, közben lefutott ciklusokkal — ez a fagyasztás előfeltétele. */
function proveStable(det = DET, intake = 'intake-v1'): void {
  recordStabilityObservation(db, {
    observedAt: T_FREEZE - 200, detectorConfigFingerprint: det,
    intakeSurfaceFingerprint: intake, cyclesRan: 10,
  })
  recordStabilityObservation(db, {
    observedAt: T_FREEZE - 100, detectorConfigFingerprint: det,
    intakeSurfaceFingerprint: intake, cyclesRan: 13,
  })
}

function freeze(intake = 'intake-v1'): void {
  proveStable(DET, intake)
  const r = freezeCalibration(db, {
    calibrationCommit: '30e16ef92753', detectorConfigFingerprint: DET,
    intakeSurfaceFingerprint: intake, frozenAt: T_FREEZE,
  })
  expect(r.ok).toBe(true)
}

// Marveen fagyasztás-előtti feltétele. Ez volt az utolsó lépés a láncban, ami
// csak valakinek az emlékezetében élt volna: "reggelig figyelem a két
// ujjlenyomatot". Egy megfigyelés, ami nincs leírva, utólag nem
// megkülönböztethető egy meg nem történttől.
describe('a fagyasztás előfeltétele — a készülék bizonyítottan áll', () => {
  beforeEach(() => { db = new Database(':memory:'); ensureCalibrationSchema(db) })

  it('HEADLINE: egyetlen pillanatkép nem stabilitás', () => {
    recordStabilityObservation(db, {
      observedAt: T_FREEZE - 100, detectorConfigFingerprint: DET,
      intakeSurfaceFingerprint: 'intake-v1', cyclesRan: 10,
    })
    const v = assertConfigStable(db)
    expect(v.stable).toBe(false)
    if (!v.stable) expect(v.reason).toMatch(/pillanatkep/)
  })

  it('HEADLINE: két azonos ujjlenyomat FUTÁS nélkül nem elég', () => {
    // Marveen szavaival: "nem az számít, hogy ma nem nyúltál hozzá, hanem hogy
    // a fagyasztott konfiguráció FUTOTT is már, nem csak be van tolva."
    // Két egyforma hash csak annyit bizonyít, hogy ugyanaz a kód volt a
    // lemezen — nem azt, hogy működött közben.
    for (const [at, cycles] of [[T_FREEZE - 200, 10], [T_FREEZE - 100, 10]]) {
      recordStabilityObservation(db, {
        observedAt: at, detectorConfigFingerprint: DET,
        intakeSurfaceFingerprint: 'intake-v1', cyclesRan: cycles,
      })
    }
    const v = assertConfigStable(db)
    expect(v.stable).toBe(false)
    if (!v.stable) expect(v.reason).toMatch(/nem futott le teljes ciklus/)
  })

  it('két azonos ujjlenyomat + lefutott ciklus = áll', () => {
    proveStable()
    const v = assertConfigStable(db)
    expect(v.stable).toBe(true)
    if (v.stable) expect(v.cyclesBetween).toBe(3)
  })

  it('elmozdult detektor vagy intake nem stabil', () => {
    recordStabilityObservation(db, {
      observedAt: T_FREEZE - 200, detectorConfigFingerprint: DET,
      intakeSurfaceFingerprint: 'intake-v1', cyclesRan: 10,
    })
    recordStabilityObservation(db, {
      observedAt: T_FREEZE - 100, detectorConfigFingerprint: DET,
      intakeSurfaceFingerprint: 'intake-v2', cyclesRan: 13,
    })
    expect(assertConfigStable(db).stable).toBe(false)
  })

  it('HEADLINE: a KÉT LEGUTÓBBI számít, nem az, hogy volt-e valaha stabil pár', () => {
    // Egy régi stabil pár nem mond semmit egy tegnapi landolás után — és a
    // "volt már ilyen" alakú bizonyíték pont akkor a legcsábítóbb, amikor a
    // friss adat nem elég.
    proveStable()
    expect(assertConfigStable(db).stable).toBe(true)
    recordStabilityObservation(db, {
      observedAt: T_FREEZE - 50, detectorConfigFingerprint: 'UJ-DETEKTOR',
      intakeSurfaceFingerprint: 'intake-v1', cyclesRan: 15,
    })
    expect(assertConfigStable(db).stable).toBe(false)
  })

  it('HEADLINE: bizonyíték nélkül nem lehet fagyasztani', () => {
    // "Egy fagyasztás egy mozgó készüléken nem gyengébb mérés. Nem mérés."
    const r = freezeCalibration(db, {
      calibrationCommit: '30e16ef92753', detectorConfigFingerprint: DET,
      intakeSurfaceFingerprint: 'intake-v1', frozenAt: T_FREEZE,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/nem bizonyitottan all/)
    expect(readFreeze(db)).toBeNull()
  })

  it('HEADLINE: az egyiken bizonyítani és a másikat fagyasztani nem megy', () => {
    // Enélkül a stabilitást a régi konfiguráción lehetne bizonyítani, és egy
    // újat befagyasztani. Ez az a lépés, ami sosem szándékosan történik.
    proveStable(DET, 'intake-v1')
    const r = freezeCalibration(db, {
      calibrationCommit: '30e16ef92753', detectorConfigFingerprint: DET,
      intakeSurfaceFingerprint: 'intake-MASIK', frozenAt: T_FREEZE,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/nem az, amin a stabilitas bizonyitva lett/)
  })

  it('a stabilitás-nyomvonal végleges', () => {
    proveStable()
    expect(() => db.prepare(
      `UPDATE calibration_stability_observations SET cycles_ran = 99`,
    ).run()).toThrow(/vegleges/)
    expect(() => db.prepare(`DELETE FROM calibration_stability_observations`).run())
      .toThrow(/vegleges/)
  })

  it('a sikeres fagyasztás megnevezi, mi bizonyította', () => {
    proveStable()
    const r = freezeCalibration(db, {
      calibrationCommit: '30e16ef92753', detectorConfigFingerprint: DET,
      intakeSurfaceFingerprint: 'intake-v1', frozenAt: T_FREEZE,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.provenAt).toBe(T_FREEZE - 100)
  })
})

describe('1. szabály — csak fagyás UTÁNI ablak számít', () => {
  beforeEach(() => { db = new Database(':memory:'); ensureCalibrationSchema(db) })

  it('HEADLINE: a fagyás elé nyúló ablak meg sem nyílik', () => {
    // A migrációs csúcs így esik kívül, dátum-karbantartás nélkül. Bármely
    // ablak, ami átér rajta, felfelé torzít — pont olyan mennyiséggel, ami
    // meggyőzőnek látszik.
    freeze()
    const r = openCalibrationWindow(db, 'w-korai', T_FREEZE - 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/TELJES egeszeben/)
  })

  it('a visszautasítás nyomot hagy, nem csak egy false-t', () => {
    // Egy néma elutasítás nem őrzi meg, hogy valaki egy fagyás elé nyúló
    // ablakot akart megnyitni — és pont ezt érdemes később látni.
    freeze()
    openCalibrationWindow(db, 'w-korai', T_FREEZE - 1)
    expect(readWindow(db, 'w-korai')?.state).toBe('VOID_STARTED_BEFORE_FREEZE')
  })

  it('a fagyás pillanatában nyíló ablak érvényes', () => {
    freeze()
    expect(openCalibrationWindow(db, 'w', T_FREEZE).ok).toBe(true)
  })

  it('fagyás nélkül nem nyílik ablak', () => {
    const r = openCalibrationWindow(db, 'w', T_FREEZE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/nincs befagyasztas/)
  })

  it('a befagyasztás végleges — se felülírni, se törölni, se újra megtenni', () => {
    freeze()
    const again = freezeCalibration(db, {
      calibrationCommit: 'ujabb', detectorConfigFingerprint: 'mas',
      intakeSurfaceFingerprint: 'mas', frozenAt: T_FREEZE + 1,
    })
    expect(again.ok).toBe(false)
    expect(() => db.prepare(`UPDATE calibration_freeze SET frozen_at = 1`).run()).toThrow(/vegleges/)
    expect(() => db.prepare(`DELETE FROM calibration_freeze`).run()).toThrow(/vegleges/)
    expect(readFreeze(db)?.calibrationCommit).toBe('30e16ef92753')
  })
})

describe('2. szabály — egészben eldobni, nem levágni', () => {
  beforeEach(() => { db = new Database(':memory:'); ensureCalibrationSchema(db) })

  it('HEADLINE: ha a hash az ablak közben változik, az EGÉSZ ablak elesik', () => {
    // "Egy félig fagyott ablak nem fagyott ablak." A levágott ablak pont azt a
    // szakaszt tartaná meg, amelyikről nem tudjuk, milyen konfiguráción futott.
    freeze()
    openCalibrationWindow(db, 'w', T_FREEZE)
    observeConfig(db, {
      windowId: 'w', observedAt: T_FREEZE + 100,
      detectorConfigFingerprint: DET, intakeSurfaceFingerprint: 'intake-v1',
    })
    observeConfig(db, {
      windowId: 'w', observedAt: T_FREEZE + 200,
      detectorConfigFingerprint: 'MAS', intakeSurfaceFingerprint: 'intake-v1',
    })
    const w = closeCalibrationWindow(db, 'w', T_FREEZE + 300, 42)
    expect(w.state).toBe('VOID_CONFIG_CHANGED_MIDWINDOW')
    expect(w.detail).toMatch(/EGESZBEN eldobva, nem levagva/)
  })

  it('HEADLINE: az eldobott ablak volumene NULLA, nem "annyi, amennyi a változásig gyűlt"', () => {
    // Ez a levágás elleni tényleges védelem. Ha az eldobott ablak megtartaná a
    // mért 42-t, valaki egyszer összeadná a jókkal — és a szám pont annyira
    // nézne ki használhatónak, hogy senki ne kérdezzen rá.
    freeze()
    openCalibrationWindow(db, 'w-rossz', T_FREEZE)
    observeConfig(db, {
      windowId: 'w-rossz', observedAt: T_FREEZE + 200,
      detectorConfigFingerprint: 'MAS', intakeSurfaceFingerprint: 'intake-v1',
    })
    closeCalibrationWindow(db, 'w-rossz', T_FREEZE + 300, 42)
    expect(readWindow(db, 'w-rossz')?.observationCount).toBeNull()

    openCalibrationWindow(db, 'w-jo', T_FREEZE + 400)
    observeConfig(db, {
      windowId: 'w-jo', observedAt: T_FREEZE + 500,
      detectorConfigFingerprint: DET, intakeSurfaceFingerprint: 'intake-v1',
    })
    closeCalibrationWindow(db, 'w-jo', T_FREEZE + 600, 7)
    expect(calibratedObservationTotal(db)).toBe(7)
  })

  it('a második zár: egy VOID ablakra írt volumen sem kerül az összegbe', () => {
    // Két független zár ugyanazon az ajtón, és szándékosan. Az első a `count =
    // null` a záráskor; a második a `WHERE state = 'VALID'` az összegzésben.
    //
    // Ezt a tesztet azért kellett külön megírni, mert a mutáns-próbán kiderült,
    // hogy a másodikat egyedül semmi nem fogja meg: az első zár miatt a
    // számláló amúgy is null, tehát a `WHERE` eltávolítása nem változtat
    // semmin. Egy védelem, aminek a hiánya nem látszik, addig áll, amíg valaki
    // "feleslegesként" ki nem veszi. Itt egy JÖVŐBELI író szerepét játsszuk el,
    // aki mégis ráír egy számot egy eldobott ablakra.
    freeze()
    openCalibrationWindow(db, 'w-rossz', T_FREEZE)
    observeConfig(db, {
      windowId: 'w-rossz', observedAt: T_FREEZE + 100,
      detectorConfigFingerprint: 'MAS', intakeSurfaceFingerprint: 'intake-v1',
    })
    closeCalibrationWindow(db, 'w-rossz', T_FREEZE + 200, 42)
    db.prepare(`UPDATE calibration_windows SET observation_count = 42 WHERE window_id = 'w-rossz'`).run()
    expect(readWindow(db, 'w-rossz')?.observationCount).toBe(42)
    expect(calibratedObservationTotal(db)).toBe(0)
  })

  it('az intake elmozdulása ugyanúgy eldobja az ablakot, mint a detektoré', () => {
    // Az intake a fagyasztott készülék RÉSZE. Ha csak a detektor számítana, a
    // nevező mozdulhatna, miközben a kísérlet fagyottnak mondja magát.
    freeze()
    openCalibrationWindow(db, 'w', T_FREEZE)
    observeConfig(db, {
      windowId: 'w', observedAt: T_FREEZE + 100,
      detectorConfigFingerprint: DET, intakeSurfaceFingerprint: 'intake-v2',
    })
    expect(closeCalibrationWindow(db, 'w', T_FREEZE + 200, 99).state)
      .toBe('VOID_CONFIG_CHANGED_MIDWINDOW')
  })

  it('a végig változatlan ablak VALID, és a mért volumen megmarad', () => {
    freeze()
    openCalibrationWindow(db, 'w', T_FREEZE)
    for (let i = 1; i <= 3; i++) {
      observeConfig(db, {
        windowId: 'w', observedAt: T_FREEZE + i * 100,
        detectorConfigFingerprint: DET, intakeSurfaceFingerprint: 'intake-v1',
      })
    }
    const w = closeCalibrationWindow(db, 'w', T_FREEZE + 400, 25)
    expect(w.state).toBe('VALID')
    expect(w.observationCount).toBe(25)
  })

  it('a konfiguráció-megfigyelés végleges — nem lehet visszamenőleg elsimítani', () => {
    // Enélkül a 2. szabály egy megjegyzés: a kellemetlen sort ki lehetne törölni,
    // és az ablak zöldre záródna.
    freeze()
    openCalibrationWindow(db, 'w', T_FREEZE)
    observeConfig(db, {
      windowId: 'w', observedAt: T_FREEZE + 100,
      detectorConfigFingerprint: 'MAS', intakeSurfaceFingerprint: 'intake-v1',
    })
    expect(() => db.prepare(
      `UPDATE calibration_config_observations SET detector_config_fingerprint = ?`,
    ).run(DET)).toThrow(/vegleges/)
    expect(() => db.prepare(`DELETE FROM calibration_config_observations`).run()).toThrow(/vegleges/)
  })

  it('a visszatérési érték nem kínál megtartható részablakot', () => {
    // Szerkezeti védelem: nincs `usableUntil`, nincs `validPrefix`. Egy
    // részablak formájú mező előbb-utóbb megtalálná a maga hívóját.
    freeze()
    openCalibrationWindow(db, 'w', T_FREEZE)
    observeConfig(db, {
      windowId: 'w', observedAt: T_FREEZE + 100,
      detectorConfigFingerprint: 'MAS', intakeSurfaceFingerprint: 'intake-v1',
    })
    const w = closeCalibrationWindow(db, 'w', T_FREEZE + 200, 42)
    for (const forbidden of ['usableUntil', 'validPrefix', 'validUntil', 'truncatedAt']) {
      expect(Object.keys(w)).not.toContain(forbidden)
    }
  })
})

describe('3. szabály — a kalibrált küszöb lejár, ha a bevitel bővül', () => {
  beforeEach(() => { db = new Database(':memory:'); ensureCalibrationSchema(db) })

  it('HEADLINE: egy új konnektor lejárttá teszi a kalibrációt', () => {
    // "A küszöb tovább él, mint a rendszer, amire mérték, és senki nem veszi
    // észre" — mert ettől semmi nem hibázik. Ezért kell előre kimondani.
    connectorTable()
    addConnector('gmail', 'email')
    freeze(intakeSurfaceFingerprint(db))
    expect(assertCalibrationStillValid(db, {
      detectorConfigFingerprint: DET, intakeSurfaceFingerprint: intakeSurfaceFingerprint(db),
    })).toEqual({ ok: true })

    addConnector('slack', 'chat')
    const v = assertCalibrationStillValid(db, {
      detectorConfigFingerprint: DET, intakeSurfaceFingerprint: intakeSurfaceFingerprint(db),
    })
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.expired).toBe(true)
      expect(v.reason).toMatch(/LEJART/)
    }
  })

  it('egy szélesebb mód is bővülés — READ_ONLY → READ_WRITE lejárat', () => {
    connectorTable()
    addConnector('gmail', 'email', 'READ_ONLY')
    freeze(intakeSurfaceFingerprint(db))
    db.prepare(`UPDATE connector_health SET mode = 'READ_WRITE' WHERE connector_id = 'gmail'`).run()
    expect(assertCalibrationStillValid(db, {
      detectorConfigFingerprint: DET, intakeSurfaceFingerprint: intakeSurfaceFingerprint(db),
    }).ok).toBe(false)
  })

  it('HEADLINE: egy DOWN konnektor NEM járatja le a kalibrációt', () => {
    // Ellenpróba, és fontosabb, mint amilyennek látszik. Ha a státusz benne
    // lenne a hashben, minden átmeneti hiba lejárttá tenné a kalibrációt — és
    // egy kapu, ami naponta zajból tüzel, az a kapu, amit kikapcsolnak.
    connectorTable()
    addConnector('gmail', 'email', 'READ_ONLY', 'OK')
    freeze(intakeSurfaceFingerprint(db))
    db.prepare(`UPDATE connector_health SET status = 'DOWN' WHERE connector_id = 'gmail'`).run()
    expect(assertCalibrationStillValid(db, {
      detectorConfigFingerprint: DET, intakeSurfaceFingerprint: intakeSurfaceFingerprint(db),
    })).toEqual({ ok: true })
  })

  it('a detektor változása is lejárat, nem csak az intake-é', () => {
    freeze()
    const v = assertCalibrationStillValid(db, {
      detectorConfigFingerprint: 'MAS', intakeSurfaceFingerprint: 'intake-v1',
    })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/mar nem futo rendszerre/)
  })

  it('fagyás nélkül nincs mit lejáratni', () => {
    expect(assertCalibrationStillValid(db, {
      detectorConfigFingerprint: 'barmi', intakeSurfaceFingerprint: 'barmi',
    })).toEqual({ ok: true })
  })

  it('a konnektor-sorrend nem számít, a tartalom igen', () => {
    // Enélkül egy újratöltés hamis lejáratot okozna.
    connectorTable()
    addConnector('b', 'kind-b'); addConnector('a', 'kind-a')
    const first = intakeSurfaceFingerprint(db)
    db.prepare(`DELETE FROM connector_health`).run()
    addConnector('a', 'kind-a'); addConnector('b', 'kind-b')
    expect(intakeSurfaceFingerprint(db)).toBe(first)
  })
})
