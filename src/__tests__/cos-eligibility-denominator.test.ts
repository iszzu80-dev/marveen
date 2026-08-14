// A regisztrációba emelt mondat, állandó ellenőrzésként:
//
//     "A nevező kizárólag a címkézési menetből származhat, soha a detektor
//      kimenetéből."
//
// Ez a mondat egy valódi hibát javított. A `replay-eval.ts` így számolt:
//
//     const eligibleObservationCount = comparison.proactiveCases
//
// vagyis a "mennyi értéket adott hozzá a detektor" NEVEZŐJE maga a detektor
// kimenete volt. Egy detektor, ami kevesebbet vesz észre, ugyanolyan jól
// teljesített volna azzal, hogy egy kisebb világból vesz észre kevesebbet.
//
// A javítás egyszeri; ez a fájl arról szól, hogy holnap se lehessen visszatenni.
// Nem egy dokumentumsor őrzi, hanem két réteg: egy forrás-szintű pásztázás, ami
// megnevezi a visszaesést, és egy viselkedési teszt, ami akkor is elbukik, ha a
// visszaesés más néven jön vissza.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { ensureReplaySchema, beginRun, recordOutput, sealRun } from '../cos/replay-run.js'
import { ensureAdjudicationSchema, type OriginLabel, recordJudgment } from '../cos/adjudication.js'
import {
  ensureEligibilitySchema, labelEligibleObservation, completeEligibilityPass,
  eligibleObservationCount, eligibilityTally, buildSessionFromRuns, evaluateValueGate,
  type PacketMapper,
} from '../cos/replay-eval.js'

const REPO = process.cwd()
const T0 = 1_700_000_000

/** Minden PRODUKCIÓS TypeScript forrás, repo-relatív úton, hogy egy bukás
 *  megnevezze az elkövetőt olyan alakban, amit egy ember meg tud nyitni. */
function productionSources(roots: string[] = ['src', 'scripts']): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue
        walk(rel)
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(rel)
      }
    }
  }
  for (const r of roots) walk(r)
  return out.sort()
}

/** Sorok, kommentek nélkül. A kommentek itt szándékosan ki vannak véve: ennek a
 *  fájlnak a fejléce és a `replay-eval.ts` magyarázata is IDÉZI a régi hibás
 *  sort, és egy pásztázás, ami a saját magyarázatán bukik el, arra tanítja az
 *  embert, hogy némítsa. */
function codeLines(path: string): Array<{ n: number; text: string }> {
  const raw = readFileSync(join(REPO, path), 'utf8')
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  return stripped.split('\n')
    .map((text, i) => ({ n: i + 1, text: text.replace(/\/\/.*$/, '') }))
    .filter(l => l.text.trim().length > 0)
}

/** A detektor kimenetének nevei — ezek egyike sem táplálhatja a nevezőt. */
const DETECTOR_OUTPUT = /\b(proactiveCases|proactiveOnly|controlCases|controlOnly|compareArms|comparison)\b/
/** A nevező nevei, bármelyik oldalon. */
const DENOMINATOR = /\b(eligibleObservationCount|eligible_observation_count|eligibleObservations|minEligibleObservations)\b/

describe('a nevező kizárólag a címkézési menetből származhat', () => {
  it('HEADLINE: egyetlen produkciós sor sem tápláltatja a nevezőt a detektor kimenetéből', () => {
    // A visszaesés alakja: `eligibleObservationCount: comparison.proactiveCases`.
    // Bármi, ami egy sorban nevezi meg a nevezőt ÉS az ág kimenetét, gyanús —
    // és ennek a kapunak a gyanú az elég, mert a helyes kód sosem kényszerül rá.
    const offenders: string[] = []
    for (const file of productionSources()) {
      for (const line of codeLines(file)) {
        if (DENOMINATOR.test(line.text) && DETECTOR_OUTPUT.test(line.text)) {
          offenders.push(`${file}:${line.n}: ${line.text.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('a nevezőt előállító két függvény csak a címkézési táblákat kérdezi', () => {
    // A másik irány: a nevező akkor is elromolhat, ha a hívó helyén tiszta a sor,
    // de a lekérdezés alatta az ág-táblákhoz nyúl.
    const src = readFileSync(join(REPO, 'src/cos/replay-eval.ts'), 'utf8')
    const bodies = ['export function eligibilityTally', 'export function eligibleObservationCount']
      .map(sig => {
        const start = src.indexOf(sig)
        expect(start, `${sig} nem található`).toBeGreaterThan(-1)
        const end = src.indexOf('\n}', start)
        return src.slice(start, end)
      })
    const all: string[] = []
    for (const body of bodies) {
      const tables = [...body.matchAll(/\bFROM\s+(\w+)/gi)].map(m => m[1])
      // Egy delegáló függvénynek nincs saját lekérdezése, és ez rendben van —
      // amit nem szabad, az egy NEM engedélyezett tábla, bárhol a kettő között.
      for (const t of tables) {
        expect(['eligible_observations', 'eligibility_passes']).toContain(t)
      }
      all.push(...tables)
    }
    // ...de a kettőből legalább az egyiknek valóban kérdeznie kell, különben ez
    // a kapu egy üres halmazon zöldell.
    expect(all.length).toBeGreaterThan(0)
  })

  it('a címkéket csak a címkézési modul írhatja', () => {
    // Ha egy másik modul beszúrhat a táblába, a nevező onnantól két forrásból
    // jön, és a második forrást senki nem nézi.
    const writers = productionSources().filter(f =>
      /INSERT\s+INTO\s+eligible_observations/i.test(readFileSync(join(REPO, f), 'utf8')))
    expect(writers).toEqual(['src/cos/replay-eval.ts'])
  })
})

describe('viselkedésben is: a nevező nem mozdul a detektorral', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    ensureReplaySchema(db); ensureEligibilitySchema(db)
  })

  function labelTen(): void {
    for (let i = 0; i < 10; i++) {
      const r = labelEligibleObservation(db, {
        corpusFingerprint: 'corpus-a', domain: 'personal', caseId: `c${i}`,
        shape: 'DEADLINE_PASSED_UNSEEN', observedAt: T0 - 20, evidenceAt: T0 - 100,
        labelledBy: 'istvan', labelledAt: T0 - 10,
        rationale: 'a hatarido eltelt es a tulajdonos nem tudott rola',
      })
      expect(r.ok).toBe(true)
    }
    completeEligibilityPass(db, {
      corpusFingerprint: 'corpus-a', labelledBy: 'istvan', completedAt: T0 - 5,
    })
  }

  function runArm(runId: string, cases: number, at: number): void {
    const r = beginRun(db, {
      runId, arm: 'PROACTIVE_SHADOW', corpusFingerprint: 'corpus-a', config: { cycles: 1 },
    }, at)
    if (!r.ok) throw new Error(r.reason)
    for (let i = 0; i < cases; i++) {
      recordOutput(db, {
        runId, domain: 'personal', caseId: `c${i}`, cycle: 1,
        decision: 'CONTINUE_AUTONOMOUSLY', reason: '',
      })
    }
    sealRun(db, runId, at + 10)
  }

  it('HEADLINE: egy szűkszavú és egy bőbeszédű detektor UGYANAZT a nevezőt kapja', () => {
    // Ez az a teszt, ami akkor is elbukik, ha a régi számítás más néven jön
    // vissza. A régi kód mellett a nevező 3 lenne az egyik, 40 a másik esetben,
    // tehát a "mennyit vett észre a világból" arány mindkét detektorra jól
    // nézne ki — a szűkszavú azzal, hogy kisebb világot állított magának.
    labelTen()
    runArm('sh-keves', 3, T0)
    expect(eligibleObservationCount(db, 'corpus-a')).toBe(10)
    runArm('sh-sok', 40, T0 + 1000)
    expect(eligibleObservationCount(db, 'corpus-a')).toBe(10)
  })

  it('nulla kimenetű detektor mellett is megvan a nevező', () => {
    // A határeset, ahol a régi számítás nullával osztott volna, és a nulla
    // nevező minden arányt „hibátlanná" tesz.
    labelTen()
    runArm('sh-ures', 0, T0)
    expect(eligibilityTally(db, 'corpus-a')?.eligible).toBe(10)
  })

  // A KAPUNÁL, nem csak a számláló-függvényben.
  //
  // Ez a blokk azért van külön, mert a fenti forrás-pásztázás NEVEKRE néz, és a
  // régi hiba visszajöhet más néven — pontosan ez történt, amikor ezt a fájlt
  // mutánssal próbáltam: `const labelled = comparison.proactiveCases` zöld
  // maradt, mert a soron nem szerepelt a nevező neve. Egy kapu, ami csak a
  // tegnapi elírást fogja meg, nem kapu.
  describe('és a kapu által jelentett nevező is a címkézésé', () => {
    const MAPPER: PacketMapper = (out) => ({
      caseContextSummary: `Ugy ${out.caseId} a ${out.domain} domainen.`,
      evidenceRefs: [`case:${out.caseId}`],
      finding: `A motor dontese: ${out.decision}.`,
      materiality: 'HIGH' as const,
      timelinessRelevantTimestamps: [{ label: 'cycle', at: T0 + out.cycle * 600 }],
      proposedNextAction: 'Kovetkezo lepes elokeszitese.',
      rationale: out.reason || 'nincs kulon indoklas',
    })

    /** Egy teljes ülés `proactive` darab proaktív üggyel, tíz címkézett
     *  megfigyelés mellett. A címkézés MINDIG előbb — csak ebben a sorrendben
     *  mutatható ki, hogy a címkéző nem látta a detektor kimenetét. */
    function session(sessionId: string, proactive: number, at: number): void {
      const ctl = `ctl-${sessionId}`, sh = `sh-${sessionId}`
      const c0 = beginRun(db, {
        runId: ctl, arm: 'REACTIVE_CONTROL', corpusFingerprint: 'corpus-a', config: { cycles: 1 },
      }, at)
      if (!c0.ok) throw new Error(c0.reason)
      recordOutput(db, {
        runId: ctl, domain: 'personal', caseId: 'c0', cycle: 1,
        decision: 'CONTINUE_AUTONOMOUSLY', reason: '',
      })
      sealRun(db, ctl, at + 10)
      runArmNamed(sh, proactive, at + 20)
      const b = buildSessionFromRuns(db, {
        sessionId, controlRunId: ctl, proactiveRunId: sh,
        rubricVersion: 'rubric-1', shuffleSeed: 'seed-1', mapper: MAPPER,
      }, at + 40)
      if (!b.ok) throw new Error(b.reasons.join('; '))
      const rows = db.prepare(
        `SELECT packet_id, origin_label FROM adjudication_packets WHERE session_id = ? ORDER BY ordinal`,
      ).all(sessionId) as Array<{ packet_id: string; origin_label: OriginLabel }>
      rows.forEach((row, i) => recordJudgment(db, {
        packetId: row.packet_id, adjudicatorId: 'a1', judgment: 'ok', timely: true, material: true,
        originGuess: row.origin_label, originGuessConfidence: 'LOW',
        judgedAt: at + 100 + i, rubricVersion: 'rubric-1',
      }))
    }

    function runArmNamed(runId: string, cases: number, at: number): void {
      const r = beginRun(db, {
        runId, arm: 'PROACTIVE_SHADOW', corpusFingerprint: 'corpus-a', config: { cycles: 1 },
      }, at)
      if (!r.ok) throw new Error(r.reason)
      for (let i = 0; i < cases; i++) {
        recordOutput(db, {
          runId, domain: 'personal', caseId: `c${i}`, cycle: 1,
          decision: 'CONTINUE_AUTONOMOUSLY', reason: '',
        })
      }
      sealRun(db, runId, at + 10)
    }

    beforeEach(() => { ensureAdjudicationSchema(db) })

    it('HEADLINE: a kapu nevezője a címkézett tíz — akkor is, ha az ág negyvenet vitt', () => {
      // A régi kód mellett ez 40 lenne, és az „észrevett a világból" arány
      // ugyanaz maradna akkor is, ha a detektor kevesebbet vesz észre — mert a
      // világot is ő szabta ki magának.
      labelTen()
      session('s-sok', 40, T0)
      expect(evaluateValueGate(db, 's-sok').eligibleObservationCount).toBe(10)
    })

    it('és a címkézett tíz akkor is, ha az ág hármat vitt', () => {
      labelTen()
      session('s-keves', 3, T0)
      expect(evaluateValueGate(db, 's-keves').eligibleObservationCount).toBe(10)
    })
  })
})
