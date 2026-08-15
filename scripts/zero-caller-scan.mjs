// NEM KAPU, MEROESZKOZ. Szandekosan nincs bekotve semmilyen CI-be, es nem is
// szabad bekotni: a szama a MODSZERTOL fugg, nem csak a kodtol. Ugyanezen a
// repon 231 -> 184 -> 81 volt, ket sajat hiba javitasa kozben (a kihagyott
// scripts/ konyvtar, majd a definicios fajl egeszben valo kizarasa, amitol a
// modulon beluli hivas lathatatlan lett -- a runCosTickOnce es az
// authorizeZstSend igy jelent meg arvakent, holott hivja oket a sajat moduljuk).
// Egy szam, ami ketszer valtozott a mereskor,
// nem allitas a kodrol -- es egy kapu, ami a HELYES kodon pirosat mutat, az a
// kapu, amit kikapcsolnak, es onnantol a valodi esetre is halott.
//
// Megepitve, tesztelve, senki nem hivja -- mekkora ez a feluleт valojaban?
//
// Ma harom peldany kerult elo egy napon belul:
//   setProgressionEnabled  -- nulla produkcios hivo (mod-beallitas)
//   mayCompose a ZST uton  -- megvolt a modul, a hivas hianyzott
//   createRadarItem        -- csak tesztek hivjak, olvaso vegpont VAN
//
// Ez a szkript NEM iteletet mond: egy exportalt fuggveny lehet szandekosan
// kesz-de-nem-bekotott. Azt meri meg, MEKKORA ez a halmaz, hogy a "keszen all"
// es a "fut" kozotti kulonbseg lathato legyen.
//
// AMIT NEM LAT (kimondva, mert egy nulla-talalat csak akkor bizonyitek, ha a
// muszer tudott volna nezni):
//   - re-export lancok (`export * from`)
//   - string-kulcsu diszpecser (`handlers[name]`)
//   - .ts-en kivuli hivok
//   - tranzitiv holt kod: egy nulla-hivos fuggveny hivoi "hivottnak" latszanak

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// A repo gyokere a szkript helyebol, nem bedrotozva: ketten dolgozunk ket
// kulon fan, es egy bedrotozott ut a masik gepen csendben rossz konyvtarat
// merne -- pontosan az a hiba, ami miatt a measured.sh letezik.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = REPO + '/src'
// A scripts/ VALODI produkcios felulet: a tizperces CoS ciklus onnan fut
// (`npx tsx`). Az elso valtozat kihagyta, es ettol 231 fuggvenyt jelolt arvanak
// -- egy muszer, ami a felulet felere vak, nem szigoru, hanem hasznalhatatlan.

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

const files = [...walk(ROOT), ...walk(REPO + '/scripts')]
const isTest = (f) => f.includes('__tests__') || f.endsWith('.test.ts')
const prod = files.filter((f) => !isTest(f))
const tests = files.filter(isTest)

const srcOf = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))

// Exportalt fuggvenyek a cos/ modulokbol.
const exports = []
for (const f of prod.filter((p) => p.includes('/cos/'))) {
  for (const m of srcOf.get(f).matchAll(/^export (?:async )?function (\w+)/gm)) {
    exports.push({ name: m[1], file: f })
  }
}

// A definicios fajlt NEM zarjuk ki egeszben, csak a definicios sort. Az elso
// valtozat az egesz fajlt kihagyta, es ettol a MODULON BELULI hivas -- a
// bekotes leggyakoribb helye -- lathatatlan lett: a runCosTickOnce (runtime.ts:90)
// es az authorizeZstSend (zst-send.ts:373) is arvakent jelent meg, holott hivja
// oket sajat maguk modulja. Ket hamis pozitiv ket kezi mintavetelbol.
const countIn = (list, name, defFile) => {
  let n = 0
  for (const f of list) {
    // Hivas vagy import-emlites; a szo-hatar fontos, kulonben a `mayApproveX` is talalat.
    const re = new RegExp(`\\b${name}\\b`, 'g')
    const body = f === defFile
      ? srcOf.get(f).split('\n').filter((l) => !/^export (?:async )?function /.test(l)).join('\n')
      : srcOf.get(f)
    n += (body.match(re) || []).length
  }
  return n
}

const rows = exports.map((e) => ({
  ...e,
  prodRefs: countIn(prod, e.name, e.file),
  testRefs: countIn(tests, e.name, null),
}))

const orphans = rows.filter((r) => r.prodRefs === 0 && r.testRefs > 0)

// ── POZITIV KONTROLL a muszerre ────────────────────────────────────────────
// Egy nulla-lista nem lelet, ha a szkript amugy sem talalna semmit. Ket ismert
// valaszt kotunk le: egyet, aminek VAN produkcios hivoja, es egyet, aminek nincs.
const control = (name, expectOrphan) => {
  const r = rows.find((x) => x.name === name)
  if (!r) return `  KONTROLL HIBA: ${name} nincs a listaban -- a szkript nem latja a fuggvenyt`
  const isOrphan = r.prodRefs === 0
  return isOrphan === expectOrphan
    ? `  kontroll OK: ${name} (prod=${r.prodRefs}, teszt=${r.testRefs}) ${expectOrphan ? 'arva, ahogy vartuk' : 'bekotve, ahogy vartuk'}`
    : `  KONTROLL BUKOTT: ${name} prod=${r.prodRefs}, de ${expectOrphan ? 'arvanak' : 'bekotottnek'} kellene lennie`
}

console.log('POZITIV KONTROLLOK')
console.log(control('mayApprove', false))
console.log(control('createRadarItem', true))
console.log('')
console.log(`vizsgalt exportalt fuggveny a src/cos/-ban : ${rows.length}`)
console.log(`ebbol NULLA produkcios hivo, de VAN tesztje: ${orphans.length}`)
console.log('')
for (const o of orphans.sort((a, b) => b.testRefs - a.testRefs)) {
  console.log(`  ${o.name.padEnd(34)} teszt-emlites=${String(o.testRefs).padStart(3)}   ${o.file.replace(ROOT + '/', '')}`)
}
