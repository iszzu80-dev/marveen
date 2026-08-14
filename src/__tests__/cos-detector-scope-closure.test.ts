// A `detector_config_fingerprint` ZÁRTSÁGA — kiszámolva, nem elolvasva.
//
// Ez a fájl egy konkrét tévedés miatt létezik, és a tévedés nem hanyagságból
// született.
//
// Marveen a fagyasztás előtt végignézte, importál-e a hatókörben lévő tizenkét
// fájl bármelyike kifelé. Nullát talált, és ebből azt a — helyesen megfogalmazott
// — következtetést vonta le, hogy *„nem tudsz detektor-viselkedést változtatni
// úgy, hogy ne mozduljon"*.
//
// A tényleges tranzitív zárt halmaz 64 fájl volt. Az `intake.ts` a
// `case-store`-ba, `email-ingest`-be, `sensitivity`-be és `case-link`-be nyúlt;
// a `proactive/sweep.ts` a `fair-interleave`-be — egy DETEKTOR-modul függősége
// a hashen kívül. Pontosan az a lyuk, amit kizárni vélt: egy közös helper
// kívül, amitől a hash hazudik.
//
// Az a `sweep.ts → fair-interleave.ts` él az én kezem munkája: én emeltem ki a
// modult, hogy a Reader-import ne sértse a határt, és utána én sem vettem
// észre, hogy a hashen kívülre tettem a sweep fairness-logikáját. Két ember
// nézte, egyik sem látta. Egy zártsági állítást nem lehet olvasással igazolni —
// ki kell számolni, minden futáson.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, normalize } from 'node:path'
import {
  DETECTOR_BEHAVIOUR_SCOPE, DECLARED_INFRASTRUCTURE,
} from '../cos/detector-scope.js'

const REPO = process.cwd()

/** A hatókör kibontva konkrét fájlokra. */
function scopeFiles(): string[] {
  const out: string[] = []
  for (const root of DETECTOR_BEHAVIOUR_SCOPE) {
    if (root.endsWith('.ts')) { out.push(root); continue }
    const walk = (d: string): void => {
      for (const e of readdirSync(join(REPO, d), { withFileTypes: true })) {
        const rel = `${d}/${e.name}`
        if (e.isDirectory()) walk(rel)
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(rel)
      }
    }
    walk(root)
  }
  return [...new Set(out)].sort()
}

interface Edge { from: string; to: string; names: string[] }

/** Relatív importok egy fájlból, a behozott nevekkel együtt. A kommentek ki
 *  vannak véve: ennek a fájlnak a fejléce IDÉZI a hibás éleket, és egy
 *  ellenőrzés, ami a saját magyarázatán bukik el, arra tanít, hogy némítsák. */
function edgesOf(path: string): Edge[] {
  const raw = readFileSync(join(REPO, path), 'utf8')
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
  const out: Edge[] = []
  const re = /import\s+(type\s+)?([\s\S]*?)\s*from\s*'(\.[^']+)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const clause = m[2] ?? ''
    const names = [...clause.matchAll(/[A-Za-z_$][\w$]*/g)].map(x => x[0])
      .filter(n => n !== 'type' && n !== 'as')
    out.push({
      from: path,
      to: normalize(join(dirname(path), m[3])).replace(/\.js$/, '.ts').replace(/\\/g, '/'),
      names,
    })
  }
  return out
}

describe('a hash hatóköre importra ZÁRT', () => {
  it('HEADLINE: a hatókörből kifelé mutató minden él DEKLARÁLT', () => {
    // Ez az az állítás, amit Marveen szemmel igazolt, és amit szemmel nem lehet.
    // Ami egyik listán sincs, az hiba — nem alapértelmezés.
    const scope = new Set(scopeFiles())
    const undeclared: string[] = []
    for (const f of scope) {
      for (const e of edgesOf(f)) {
        if (scope.has(e.to)) continue
        if (e.to in DECLARED_INFRASTRUCTURE) continue
        undeclared.push(`${e.from} -> ${e.to}`)
      }
    }
    expect(undeclared).toEqual([])
  })

  it('HEADLINE: a "csak egy konstans kell belőle" indoklás korlát, nem ígéret', () => {
    // Egy infrastruktúra-kivétel, ami azon áll, hogy csak egy fejlécet
    // importálunk belőle, pontosan addig igaz, amíg valaki nem importál belőle
    // viselkedést — és akkor a kivétel indoka már nem áll, de a kivétel marad.
    const scope = new Set(scopeFiles())
    const violations: string[] = []
    for (const f of scope) {
      for (const e of edgesOf(f)) {
        const decl = DECLARED_INFRASTRUCTURE[e.to]
        if (!decl?.allowed) continue
        for (const n of e.names) {
          if (!decl.allowed.includes(n)) violations.push(`${e.from} -> ${e.to}: ${n}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('minden deklarált kivételnek van érdemi indoka', () => {
    // Egy indok nélküli kivétel az a kivétel, amit senki nem néz újra.
    for (const [path, decl] of Object.entries(DECLARED_INFRASTRUCTURE)) {
      expect(decl.why.length, `${path} indoklása túl rövid`).toBeGreaterThan(40)
    }
  })

  it('a hatókör és a kivétel-lista minden eleme LÉTEZIK', () => {
    // Egy törölt vagy átnevezett fájl a listán néma: a hash csendben szűkül,
    // és a kivétel csendben tágul.
    for (const root of DETECTOR_BEHAVIOUR_SCOPE) {
      expect(existsSync(join(REPO, root)), `hiányzik a hatókörből: ${root}`).toBe(true)
    }
    for (const path of Object.keys(DECLARED_INFRASTRUCTURE)) {
      expect(existsSync(join(REPO, path)), `hiányzó kivétel: ${path}`).toBe(true)
    }
  })

  it('nincs felesleges kivétel — amit a hatókör nem ér el, az ne legyen deklarálva', () => {
    // A másik irány. Egy kivétel-lista, ami többet enged, mint amennyi kell,
    // a következő valódi élt is elnyeli anélkül, hogy bárki döntött volna róla.
    const scope = new Set(scopeFiles())
    const reached = new Set<string>()
    for (const f of scope) for (const e of edgesOf(f)) if (!scope.has(e.to)) reached.add(e.to)
    const unused = Object.keys(DECLARED_INFRASTRUCTURE).filter(p => !reached.has(p))
    expect(unused).toEqual([])
  })

  it('HEADLINE: a sweep fairness-logikája BENNE van a hashben', () => {
    // Nevesítve, mert ez volt a konkrét lyuk. Egy általános zártsági szabály
    // igaz marad akkor is, ha valaki a modult újra kiemeli — ez a teszt viszont
    // megnevezi, mi veszne el vele.
    expect(scopeFiles()).toContain('src/cos/fair-interleave.ts')
  })
})
