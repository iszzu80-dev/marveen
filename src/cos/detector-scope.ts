/**
 * §1.4.1 — MI VAN a `detector_config_fingerprint` alatt, és mi nincs.
 *
 * Ez a fájl azért létezik, mert a hatókört egyszer szemmel ellenőriztük, és a
 * szemmel ellenőrzés rossz eredményt adott.
 *
 * Marveen a fagyasztás előtt végignézte, importál-e a hatókörben lévő fájlok
 * bármelyike kifelé, és nullát talált. Ebből azt a következtetést vonta le,
 * hogy a hash zárt: *„nem tudsz detektor-viselkedést változtatni úgy, hogy ne
 * mozduljon."* A megfogalmazás pontos, a megállapítás nem volt az.
 *
 * A tényleges tranzitív zárt halmaz **64 fájl** volt a hashelt tizenkettő
 * mellett. Az `intake.ts` a `case-store`-ba, az `email-ingest`-be, a
 * `sensitivity`-be és a `case-link`-be nyúlt; a `proactive/sweep.ts` a
 * `fair-interleave`-be — utóbbi egy DETEKTOR-modul függősége a hashen kívül.
 * Vagyis pontosan az a lyuk állt fenn, amit Marveen kizárni vélt: **egy közös
 * helper kívül, amitől a hash hazudik.**
 *
 * A tanulság nem az, hogy tévedett. Az, hogy egy zártsági állítást **nem lehet
 * olvasással igazolni** — a `sweep.ts → fair-interleave.ts` élt én magam
 * hoztam létre, amikor a Reader-import miatt kiemeltem a modult, és utána én
 * sem vettem észre. Ezért van ehhez a fájlhoz állandó ellenőrzés, ami a
 * zárást KISZÁMOLJA.
 *
 * ── A két lista ────────────────────────────────────────────────────────
 *
 * `DETECTOR_BEHAVIOUR_SCOPE`  — amit a hash lefed. Ami itt van, az eldönti,
 *                               MELYIK üzenetből lesz ügy, MELYIK ügy számít
 *                               esedékesnek, és mit vesz észre a detektor.
 *
 * `DECLARED_INFRASTRUCTURE`   — amit a hatókör elér, de szándékosan NEM fed le,
 *                               mert nem hoz döntést. Minden tétel INDOKKAL,
 *                               mert egy indok nélküli kivétel az a kivétel,
 *                               amit senki nem néz újra.
 *
 * Ami egyik listán sincs, és a hatókörből elérhető: **hiba**, nem alapértelmezés.
 */

/** A hashelt viselkedési mag. */
export const DETECTOR_BEHAVIOUR_SCOPE: readonly string[] = [
  // A proaktív mag egésze.
  'src/cos/proactive',
  // Határidő-származtatás: ebből lesz „esedékes".
  'src/cos/deadline-index.ts',
  // Beviteli út: ebből lesz ügy egy üzenetből.
  'src/cos/intake.ts',
  'src/cos/triage-bridge.ts',
  // Stage 2G kapu (2026-08-17): e-mail-eredetű ügy triage-nyugta nélkül nem
  // jöhet létre. Ez DÖNTÉS, nem infrastruktúra — ezért a hatókörbe kerül, nem a
  // deklarált kivételek közé, és a viselkedési hash mozdul vele. Épp ez a
  // helyes: a beviteli út viselkedése tényleg megváltozott.
  'src/cos/triage-provenance.ts',
  'src/cos/email-ingest.ts',
  // Hatókör-osztályozás (2026-08-31): a kapu dönti el, hogy egy céges tartalmú
  // ügy MEGJELÖLVE jön-e létre a személyes tárban. Ez DÖNTÉS -- pontosan az a
  // fajta, amit a fejléc szerint a hash lefed ("MELYIK üzenetből lesz ügy") --
  // ezért a hatókörbe kerül, nem a deklarált kivételek közé, és a viselkedési
  // ujjlenyomat mozdul vele. A `case-engine-core -> scope-gate` élet ez a sor
  // teszi zárttá; a zártsági teszt hozta elő, olvasásból nem látszott volna.
  'src/cos/scope-gate.ts',
  // Ügy-életciklus: ez dönti el, mi van nyitva, és mikor záródik.
  'src/cos/case-store.ts',
  'src/cos/case-engine-core.ts',
  'src/cos/case-link.ts',
  'src/cos/progression-completion.ts',
  'src/cos/progression-resolver.ts',
  // Kizárás: ez dönti el, mi NEM lesz ügy.
  'src/cos/sensitivity.ts',
  'src/data-sensitivity-gate.ts',
  // Sweep-igazságosság — egy DETEKTOR-modul függősége. Ez az él volt a
  // legárulkodóbb: a `proactive/sweep.ts` importálja, és a régi tizenkettőben
  // nem szerepelt.
  'src/cos/fair-interleave.ts',
] as const

export interface InfrastructureDeclaration {
  /** Miért nem hoz ez a modul detektor- vagy beviteli döntést. */
  why: string
  /** Ha meg van adva, KIZÁRÓLAG ezek a nevek importálhatók belőle. Egy
   *  „csak egy konstans kell belőle" indoklás enélkül ígéret, nem korlát. */
  allowed?: readonly string[]
}

/** Amit a hatókör elér, és szándékosan nincs hashelve. */
export const DECLARED_INFRASTRUCTURE: Readonly<Record<string, InfrastructureDeclaration>> = {
  'src/db.ts': {
    why:
      'kapcsolat és séma-bootstrap (`getDb`), nem döntési logika. Ha ez hashelve lenne, '
      + 'a teljes costops-fa is bejönne rajta keresztül, és a kalibráció minden '
      + 'számlázási változástól lejárna — egy kapu, ami zajból tüzel, az a kapu, amit kikapcsolnak.',
  },
  'src/cos/schema.ts': {
    why:
      'tábla-DDL és típus/konstans exportok. A hatókör négy modulja TÍPUST és '
      + 'konstans-listát importál belőle, nem viselkedést. Egy DDL-változás, ami tényleg '
      + 'megváltoztatja a detektor döntéseit, kódváltozással is jár a hatókörben — az mozdítja a hasht.',
  },
  'src/model-profiles.ts': {
    why:
      'modell-útválasztás. Azt befolyásolja, MELYIK modell kap egy feladatot, nem azt, '
      + 'hogy melyik üzenetből lesz ügy. A proaktív mag amúgy sem fordulhat modellhez.',
    allowed: ['MODEL_PROFILE_IDS', 'ModelProfileId'],
  },
  'src/cos/adapters/gmail-send.ts': {
    why:
      'KIMENŐ adapter. Az `intake.ts` egyetlen fejléc-konstansért nyúl hozzá; egy küldő '
      + 'adapter nem dönti el, mi jön BE. A hashelése az `executor` egész fáját behozná.',
    allowed: ['IDEMPOTENCY_HEADER'],
  },
} as const
