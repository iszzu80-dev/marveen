#!/usr/bin/env npx tsx
/**
 * Egy stabilitás-megfigyelés rögzítése — a fagyasztás előfeltétele.
 *
 *   npx tsx scripts/cos-calibration-observe.ts [--ledger <path>] [--db <path>]

 * Alapertelmezett ledger: `store/cos-ledger.db` (`CALIBRATION_LEDGER_PATH`).
 *
 * Marveen feltétele: *„nem az számít, hogy ma nem nyúltál hozzá, hanem hogy a
 * fagyasztott konfiguráció FUTOTT is már, nem csak be van tolva."* Ez a script
 * az, ami ezt rögzíteni tudja — enélkül a feltétel csak valakinek az
 * emlékezetében élne, és egy megfigyelés, ami nincs leírva, utólag nem
 * különböztethető meg egy meg nem történttől.
 *
 * ── Miért a LEDGER, és nem az üzemi DB ──────────────────────────────────
 *
 * A fagyasztás és a stabilitás-nyomvonal MÉRÉSI műtermék, nem üzemi állapot, és
 * a value gate is a ledgerből olvassa. Ha mindkét helyen ott lenne, két fagyás
 * létezne, amiből az egyik előbb-utóbb a másikat mondaná érvénytelennek — pont
 * az a „két igazságforrás" hiba, amibe ez a kódbázis már beleszaladt.
 *
 * Az üzemi DB-t CSAK OLVASSA: onnan jön a beviteli felület (`connector_health`)
 * és a két ciklus-számláló.
 *
 * ── A két számláló ──────────────────────────────────────────────────────
 *
 * Külön, nem összegezve. Egy összeg mellett hat triage-futás és nulla ügyciklus
 * is átmenne, ami ugyanaz a hiba egy szinttel lejjebb: a rendszer mozog, de nem
 * az a része, amiről bizonyítani akarunk valamit.
 */
import Database from 'better-sqlite3'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  ensureCalibrationSchema, recordStabilityObservation, assertConfigStable,
  intakeSurfaceFingerprint, CALIBRATION_LEDGER_PATH,
} from '../src/cos/calibration-window.js'
import { detectorConfigFingerprint } from '../src/cos/replay-run.js'

function flag(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}

// Alapertelmezes VAN, es szandekosan: egy kotelezo flag mellett minden hivo
// maga talalja ki az utvonalat, es ket ledger lesz belole — az egyikbe ir az
// obs, a masikbol olvas a kapu, es mindketto magabiztosan valaszol.
const ledgerPath = flag('--ledger') ?? CALIBRATION_LEDGER_PATH
const dbPath = flag('--db') ?? join(process.env.HOME ?? '.', '.claudeclaw', 'claudeclaw.db')

const REPO = process.cwd()
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8')
const list = (dir: string): string[] => {
  const out: string[] = []
  const walk = (d: string): void => {
    if (!existsSync(join(REPO, d))) return
    for (const e of readdirSync(join(REPO, d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`
      if (e.isDirectory()) walk(rel)
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(rel)
    }
  }
  walk(dir)
  return out
}

/** Monoton számláló egy táblából. Hiányzó tábla = 0, mert egy még nem létező
 *  tábla nem hiba — de a NÖVEKEDÉS hiánya igen, és azt a kapu fogja meg. */
function countRows(db: Database.Database, table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  } catch { return 0 }
}

const opDb = new Database(resolve(dbPath), { readonly: true })
const caseCyclesRan = countRows(opDb, 'case_progression_runs')
const intakeBatchesOpened = countRows(opDb, 'email_processing_batches')
const intakeFp = intakeSurfaceFingerprint(opDb)
opDb.close()

const detectorFp = detectorConfigFingerprint(read, list)

const ledger = new Database(resolve(ledgerPath))
ensureCalibrationSchema(ledger)
recordStabilityObservation(ledger, {
  observedAt: Math.floor(Date.now() / 1000),
  detectorConfigFingerprint: detectorFp,
  intakeSurfaceFingerprint: intakeFp,
  caseCyclesRan, intakeBatchesOpened,
})

console.log('stabilitas-megfigyeles rogzitve')
console.log(`  detector_config_fingerprint  ${detectorFp}`)
console.log(`  intake_surface_fingerprint   ${intakeFp}`)
console.log(`  case_progression_runs        ${caseCyclesRan}`)
console.log(`  email_processing_batches     ${intakeBatchesOpened}`)

const v = assertConfigStable(ledger)
ledger.close()
if (v.stable) {
  console.log(`\nA keszulek ALL: ${v.caseCyclesBetween} ugyciklus es `
    + `${v.intakeBatchesBetween} intake-batch a ket ellenorzes kozott.`)
  console.log('Fagyasztas innentol lehetseges — a kimondas nem ezé a scripté.')
} else {
  console.log(`\nMeg nem fagyaszthato: ${v.reason}`)
}
