// §10.1–10.3: the deadline ontology, and the index that projects it.
//
// WHAT THE AUDIT FOUND. Deadline data is spread over eleven column names in
// fourteen tables, in three different storage conventions (epoch INTEGER, ISO
// TEXT, and a relative "+N days" horizon computed in SQL), with five indexes
// covering four unrelated concepts and no view that answers "what is due".
// §11.2 E's deadline-first question ordering could only be half-built for
// exactly that reason: there was nothing to order BY.
//
// THE ONE RULE THAT SHAPES THIS FILE, from §10.2: the index is a **derived read
// model**, not a fourth source of truth. Nothing here writes a deadline. Every
// record it returns is projected, at read time, from the column that already
// owns it — so there is no copy to drift, no backfill to schedule, and no
// migration to get wrong. `deadline-index-ontology.test.ts` asserts the absence
// of a write path rather than trusting this paragraph.
//
// AND THE RULE THAT SHAPES THE ONTOLOGY BELOW, from §10.3: every existing
// deadline concept gets EXACTLY ONE status, and `INTENTIONALLY_DISTINCT` needs
// a stated reason. The point of that clause is not tidiness. It is that "we have
// several deadline fields" and "we have several KINDS of deadline" are different
// situations with different fixes, and only writing down which is which tells
// them apart. Four of the eleven below are genuinely not deadlines at all —
// they are lease and ticket expiries, machine bookkeeping that happens to be a
// timestamp — and folding them into a deadline view would have put the
// progression engine's own retry cadence on a list of things the owner is late
// for.

import type Database from 'better-sqlite3'

/** §10.3's four statuses. */
export type OntologyStatus =
  | 'SUBSUMED'
  | 'ADAPTED_TO_INDEX'
  | 'INTENTIONALLY_DISTINCT'
  | 'DEPRECATED'

/** The normalized kinds. A concept that cannot be given one of these is a
 *  concept that does not belong in the index. */
export type DeadlineType =
  | 'CASE_DUE'
  | 'FOLLOW_UP_DUE'
  | 'WAKE'
  | 'WATCH_DUE'
  | 'PAYMENT_DUE'
  | 'DOCUMENT_DUE'
  | 'TERMINATION_DEADLINE'
  | 'CONTRACT_EXPIRY'
  | 'INITIATIVE_DECISION_DUE'
  | 'ESCALATION_DUE'
  | 'WAIT_EXPECTED_BY'
  | 'WAIT_STALE_REVIEW'

/** §10.3's documentation shape, as data rather than as a YAML file nobody
 *  parses. Being data is what lets the standing check compare it against the
 *  schema and fail when a twelfth column appears. */
export interface DeadlineConcept {
  /** `table.column`, exactly as the schema spells it. */
  field: string
  semanticOwner: string
  sourceOfTruth: string
  readers: string[]
  writers: string[]
  normalizedType: DeadlineType | null
  /** Lower wins when two records describe the same case at the same instant. */
  precedenceIfConflict: number
  status: OntologyStatus
  rationale: string
  /** How it reaches the index. `null` for concepts that stay out. */
  migrationOrAdapter: string | null
  /** Epoch seconds, ISO date TEXT, or neither. */
  storage: 'EPOCH' | 'ISO_DATE_TEXT' | 'RELATIVE'
}

/**
 * The inventory. §10.3 requires it to exist before the build, and requires each
 * entry to carry exactly one status.
 *
 * Precedence is assigned by HOW BINDING the deadline is, not by how soon it
 * falls: a contract termination date is a legal cliff, an invoice due date is a
 * commitment with a penalty, a wake time is a note the system left itself. When
 * two records land on the same case at the same instant, the more binding one is
 * the one a person should see first.
 */
export const DEADLINE_ONTOLOGY: readonly DeadlineConcept[] = [
  {
    field: 'case_wait_conditions.expected_by',
    semanticOwner: '§10.4 tipizált várakozás',
    sourceOfTruth: 'case_wait_conditions',
    readers: ['wait-condition.ts', 'case-projection.ts', 'progression-trigger.ts', 'deadline-index.ts'],
    writers: ['wait-condition.ts'],
    normalizedType: 'WAIT_EXPECTED_BY',
    precedenceIfConflict: 45,
    status: 'ADAPTED_TO_INDEX',
    rationale:
      'Mikorra VÁRJUK azt, amire az ügy vár. Ez az első olyan oszlop a rendszerben, ami tényleges '
      + 'felülvizsgálati időpontot jelent: a next_progression_at két jelentést visz (ütemezett '
      + 'ébresztés ÉS a poller ötperces visszanézése), és a gyakorlatban mindig a másodikat. '
      + 'Kevésbé kötelező, mint egy jogi határidő, kötelezőbb, mint egy magunknak hagyott emlékeztető.',
    migrationOrAdapter: 'közvetlen epoch, nincs átalakítás',
    storage: 'EPOCH',
  },
  {
    field: 'case_wait_conditions.stale_review_at',
    semanticOwner: '§10.2 Invariáns C',
    sourceOfTruth: 'case_wait_conditions',
    readers: ['wait-condition.ts', 'case-projection.ts', 'deadline-index.ts'],
    writers: ['wait-condition.ts'],
    normalizedType: 'WAIT_STALE_REVIEW',
    precedenceIfConflict: 60,
    status: 'ADAPTED_TO_INDEX',
    rationale:
      'A HATÁR, ameddig egy megválaszolatlan várakozás csendben ülhet. Nem azt mondja, mikor '
      + 'esedékes valami, hanem hogy mikor kell valakinek RÁNÉZNI, ha semmi nem történt. Ezért van '
      + 'külön az expected_by-tól: az egyik a világról szól, ez a rendszer saját fegyelméről, és '
      + 'egy esemény-vezérelt várakozásnak, aminek nincs határideje, EZ az egyetlen kijárata.',
    migrationOrAdapter: 'közvetlen epoch, nincs átalakítás',
    storage: 'EPOCH',
  },
  {
    field: 'zst_contracts.termination_deadline',
    semanticOwner: 'ZST szerződéskezelés',
    sourceOfTruth: 'zst_contracts',
    readers: ['zst-watch.ts', 'deadline-index.ts'],
    writers: ['zst-contract-extract.ts'],
    normalizedType: 'TERMINATION_DEADLINE',
    precedenceIfConflict: 10,
    status: 'ADAPTED_TO_INDEX',
    rationale: 'Jogi határidő: elmulasztva a szerződés magától meghosszabbodik. A legkötelezőbb fajta.',
    migrationOrAdapter: 'ISO dátum → epoch, szigorú YYYY-MM-DD alakban; ami nem az, kimarad és jelentődik',
    storage: 'ISO_DATE_TEXT',
  },
  {
    field: 'zst_contracts.expiry_date',
    semanticOwner: 'ZST szerződéskezelés',
    sourceOfTruth: 'zst_contracts',
    readers: ['zst-watch.ts', 'deadline-index.ts'],
    writers: ['zst-contract-extract.ts'],
    normalizedType: 'CONTRACT_EXPIRY',
    precedenceIfConflict: 15,
    status: 'ADAPTED_TO_INDEX',
    rationale:
      'A szerződés lejárta — NEM ugyanaz, mint a felmondási határidő. A felmondási határidő az '
      + 'utolsó nap, amikor még nyilatkozni lehet; a lejárat az a nap, amikor a szolgáltatás '
      + 'megszűnik. Egy fogalomba vonva az egyik mindig eltűnne, és a §10.3 pont ezért kér '
      + 'fogalmanként egy státuszt. Ezt a sort a saját teszt-fixture-je bukkantotta ki: az '
      + 'eredeti leltár a `deadline|due|expires` mintára keresett, és az `expiry_date` egyikre '
      + 'sem illett.',
    migrationOrAdapter: 'ISO dátum → epoch',
    storage: 'ISO_DATE_TEXT',
  },
  {
    field: 'zst_invoices.due_date',
    semanticOwner: 'ZST pénzügy',
    sourceOfTruth: 'zst_invoices',
    readers: ['zst-watch.ts', 'deadline-index.ts'],
    writers: ['zst-invoice ingest'],
    normalizedType: 'PAYMENT_DUE',
    precedenceIfConflict: 20,
    status: 'ADAPTED_TO_INDEX',
    rationale: 'Fizetési kötelezettség, késedelmi következménnyel.',
    migrationOrAdapter: 'ISO dátum → epoch',
    storage: 'ISO_DATE_TEXT',
  },
  {
    field: 'personal_invoices.due_date',
    semanticOwner: 'privát pénzügy',
    sourceOfTruth: 'personal_invoices',
    readers: ['deadline-index.ts'],
    writers: ['személyes számla-rögzítés'],
    normalizedType: 'PAYMENT_DUE',
    precedenceIfConflict: 20,
    status: 'ADAPTED_TO_INDEX',
    rationale: 'Ugyanaz a fogalom a másik domainen. Külön sor, mert a két tábla soha nem kérdezhető együtt (§20.3).',
    migrationOrAdapter: 'ISO dátum → epoch',
    storage: 'ISO_DATE_TEXT',
  },
  {
    field: 'zst_obligations.follow_up_at',
    semanticOwner: 'ZST kötelezettségek',
    sourceOfTruth: 'zst_obligations',
    readers: ['zst-watch.ts', 'deadline-index.ts'],
    writers: ['zst kötelezettség-kezelés'],
    normalizedType: 'FOLLOW_UP_DUE',
    precedenceIfConflict: 30,
    status: 'ADAPTED_TO_INDEX',
    rationale: 'Hatósági/adminisztratív kötelezettség esedékessége.',
    migrationOrAdapter: null,
    storage: 'EPOCH',
  },
  {
    field: 'personal_cases.due_at',
    semanticOwner: 'privát Case store',
    sourceOfTruth: 'personal_cases',
    readers: ['owner-question.ts', 'scheduler.ts', 'deadline-index.ts'],
    writers: ['case-store.ts'],
    normalizedType: 'CASE_DUE',
    precedenceIfConflict: 40,
    status: 'ADAPTED_TO_INDEX',
    rationale: 'Az ügy saját határideje — amit a kérdés-sor rendezése (§11.2 E) elsőként olvas.',
    migrationOrAdapter: null,
    storage: 'EPOCH',
  },
  {
    field: 'zst_cases.due_at',
    semanticOwner: 'ZST Case store',
    sourceOfTruth: 'zst_cases',
    readers: ['owner-question.ts', 'deadline-index.ts'],
    writers: ['zst-case-store.ts'],
    normalizedType: 'CASE_DUE',
    precedenceIfConflict: 40,
    status: 'ADAPTED_TO_INDEX',
    rationale: 'Ugyanaz a fogalom a céges oldalon.',
    migrationOrAdapter: null,
    storage: 'EPOCH',
  },
  {
    field: 'zst_product_escalations.due_at',
    semanticOwner: 'ZST termék-eszkaláció',
    sourceOfTruth: 'zst_product_escalations',
    readers: ['zst-productlab.ts', 'deadline-index.ts'],
    writers: ['zst-productlab.ts'],
    normalizedType: 'ESCALATION_DUE',
    precedenceIfConflict: 45,
    status: 'ADAPTED_TO_INDEX',
    rationale: 'Eszkaláció válaszhatárideje.',
    migrationOrAdapter: null,
    storage: 'EPOCH',
  },
  {
    field: 'personal_cases.follow_up_at / zst_cases.follow_up_at',
    semanticOwner: 'follow-up söprés',
    sourceOfTruth: 'personal_cases / zst_cases',
    readers: ['followup-autodraft.ts', 'progression-trigger.ts', 'deadline-index.ts'],
    writers: ['case-store.ts', 'followup-autodraft.ts'],
    normalizedType: 'FOLLOW_UP_DUE',
    precedenceIfConflict: 50,
    status: 'ADAPTED_TO_INDEX',
    rationale: 'Mikor kell újra megkérdezni a másik felet. Valódi határidő, de a mi vállalásunk, nem az övék.',
    migrationOrAdapter: null,
    storage: 'EPOCH',
  },
  {
    field: 'radar_items.next_check_at',
    semanticOwner: 'ár-radar',
    sourceOfTruth: 'radar_items',
    readers: ['radar-alert.ts', 'reconcile.ts', 'deadline-index.ts'],
    writers: ['radar-alert.ts'],
    normalizedType: 'WATCH_DUE',
    precedenceIfConflict: 60,
    status: 'ADAPTED_TO_INDEX',
    rationale: 'Figyelési esedékesség. Elmulasztva nem jogvesztő, csak elszalasztott lehetőség.',
    migrationOrAdapter: null,
    storage: 'EPOCH',
  },
  {
    field: 'personal_cases.next_wake_at / zst_cases.next_wake_at',
    semanticOwner: 'ütemező',
    sourceOfTruth: 'personal_cases / zst_cases',
    readers: ['scheduler.ts', 'progression-trigger.ts', 'deadline-index.ts'],
    writers: ['scheduler.ts', 'owner-question.ts'],
    normalizedType: 'WAKE',
    precedenceIfConflict: 70,
    status: 'ADAPTED_TO_INDEX',
    rationale: 'Emlékeztető, amit a rendszer hagyott magának. A leggyengébb kötelem, ezért sorol utolsónak.',
    migrationOrAdapter: null,
    storage: 'EPOCH',
  },
  {
    field: 'zst-watch horizon',
    semanticOwner: 'ZST watch',
    sourceOfTruth: 'nincs — SQL-ben számított relatív ablak',
    readers: ['zst-watch.ts'],
    writers: [],
    normalizedType: null,
    precedenceIfConflict: 0,
    status: 'SUBSUMED',
    rationale:
      'Nem tárolt határidő, hanem egy „+N nap" szűrő a fenti oszlopok felett. Ugyanazokat a '
      + 'sorokat adja vissza, amiket az index — más ablakkal. Nincs mit megőrizni belőle.',
    migrationOrAdapter: 'a hívó adja meg a horizontot az indexnek (`withinSec`)',
    storage: 'RELATIVE',
  },
  {
    field: 'proactive_initiatives.decision_deadline',
    semanticOwner: 'v1.4 Proactive Core',
    sourceOfTruth: 'proactive_initiatives',
    readers: ['deadline-index.ts', 'proactive/sweep.ts'],
    writers: ['proactive/initiative-store.ts'],
    normalizedType: 'INITIATIVE_DECISION_DUE',
    precedenceIfConflict: 42,
    status: 'ADAPTED_TO_INDEX',
    rationale:
      'A kvalifikalt Initiative dontesi hatarideje. Valodi hatarido: el lehet keses vele. Kicsit '
      + 'gyengebb kotelem, mint az ugy sajat due_at-ja, mert az Initiative javaslat marad, amig '
      + 'Case-hez nem kotodik.',
    migrationOrAdapter: null,
    storage: 'EPOCH',
  },
  {
    field: 'proactive_signals.candidate_deadline',
    semanticOwner: 'v1.4 Proactive Core',
    sourceOfTruth: 'proactive_signals',
    readers: ['proactive/qualification.ts'],
    writers: ['proactive/signal-store.ts'],
    normalizedType: null,
    precedenceIfConflict: 0,
    status: 'INTENTIONALLY_DISTINCT',
    rationale:
      'JELOLT hatarido, nem megallapitott. Egy eszlelt jel javaslata, amit a §6 kvalifikacio meg '
      + 'elvethet. Az indexbe vonva minden gyanu ugy nezne ki a listan, mint egy tenyleges '
      + 'kotelem -- es a jel letezese onmagaban a §4.1 szerint semmit nem valt ki.',
    migrationOrAdapter: 'promocio utan a proactive_initiatives.decision_deadline viszi tovabb',
    storage: 'EPOCH',
  },
  {
    field: 'proactive_initiatives.internal_safe_deadline',
    semanticOwner: 'v1.4 Proactive Core',
    sourceOfTruth: 'szarmaztatott: decision_deadline - felkeszulesi ido',
    readers: ['proactive/initiative-store.ts'],
    writers: ['proactive/initiative-store.ts'],
    normalizedType: null,
    precedenceIfConflict: 0,
    status: 'INTENTIONALLY_DISTINCT',
    rationale:
      'Nem hatarido, hanem BELSO onkorlatozas: ameddig az elokeszitesnek keszen kell lennie, hogy '
      + 'a valodi hatarido meg tarthato legyen. Sosem a tulajdonos fele mutatott datum. Az index '
      + 'ezt minden rekordra maga szamolja az INTERNAL_SAFE_LEAD_SEC-bol, tehat ket forrasa lenne.',
    migrationOrAdapter: null,
    storage: 'EPOCH',
  },
  {
    field: 'proactive_sweep_state.next_review_at',
    semanticOwner: 'v1.4 proaktiv sweep',
    sourceOfTruth: 'proactive_sweep_state',
    readers: ['proactive/sweep.ts'],
    writers: ['proactive/sweep.ts'],
    normalizedType: null,
    precedenceIfConflict: 0,
    status: 'INTENTIONALLY_DISTINCT',
    rationale:
      'A sweep sajat kadenciaja, ugyanaz a fajta, mint a next_progression_at: "mikor nezzem meg '
      + 'legkozelebb". Senki nem kesik el vele. A §11.2 D pont miatt letezik -- egy lesoport '
      + 'jelolt nem maradhat azonnal ujra esedekes -- es nem azert, mert barmi hatarideje volna.',
    migrationOrAdapter: null,
    storage: 'EPOCH',
  },
  {
    field: 'proactive_sweep_state.claim_expires_at',
    semanticOwner: 'v1.4 proaktiv sweep',
    sourceOfTruth: 'proactive_sweep_state',
    readers: ['proactive/sweep.ts'],
    writers: ['proactive/sweep.ts'],
    normalizedType: null,
    precedenceIfConflict: 0,
    status: 'INTENTIONALLY_DISTINCT',
    rationale:
      'Lease TTL a §11.2 F claim-idempotenciahoz. Kizarasi mechanizmus, nem kotelem: a lejarata '
      + 'csak annyit jelent, hogy masik sweep is elviheti a jeloltet.',
    migrationOrAdapter: null,
    storage: 'EPOCH',
  },
  {
    field: 'case_progression_state.next_progression_at',
    semanticOwner: 'progression ütemező',
    sourceOfTruth: 'case_progression_state',
    readers: ['progression-scheduler.ts', 'progression-heartbeat.ts'],
    writers: ['progression-scheduler.ts', 'capability-preflight.ts'],
    normalizedType: null,
    precedenceIfConflict: 0,
    status: 'INTENTIONALLY_DISTINCT',
    rationale:
      'Nem határidő, hanem a motor saját kadenciája: „mikor nézzem meg legközelebb". Senki nem késik '
      + 'el vele. Ha bekerülne az indexbe, a rendszer ötpercenkénti önellenőrzése megjelenne azon a '
      + 'listán, amit a tulajdonos „mire vagyok elmaradva" néven olvas.',
    migrationOrAdapter: null,
    storage: 'EPOCH',
  },
  {
    field: 'case_claims.claim_expires_at / case_progression_state.progression_claim_expires_at',
    semanticOwner: 'claim lease',
    sourceOfTruth: 'case_claims / case_progression_state',
    readers: ['case-store.ts', 'progression-scheduler.ts'],
    writers: ['case-store.ts', 'progression-scheduler.ts'],
    normalizedType: null,
    precedenceIfConflict: 0,
    status: 'INTENTIONALLY_DISTINCT',
    rationale: 'Lease TTL. Kizárási mechanizmus, nem kötelem — a lejárata csak annyit jelent, hogy másik futó is elviheti.',
    migrationOrAdapter: null,
    storage: 'EPOCH',
  },
  {
    field: 'action_authorizations.expires_at',
    semanticOwner: 'dispatch gate',
    sourceOfTruth: 'action_authorizations',
    readers: ['action-authorization.ts'],
    writers: ['action-authorization.ts'],
    normalizedType: null,
    precedenceIfConflict: 0,
    status: 'INTENTIONALLY_DISTINCT',
    rationale: 'Egyszer használatos jegy élettartama. Biztonsági korlát, nem naptári tétel.',
    migrationOrAdapter: null,
    storage: 'EPOCH',
  },
  {
    field: 'campaign_approvals.valid_until',
    semanticOwner: 'jóváhagyási boríték',
    sourceOfTruth: 'campaign_approvals',
    readers: ['approval-envelope', 'reconcile.ts'],
    writers: ['jóváhagyási út'],
    normalizedType: null,
    precedenceIfConflict: 0,
    status: 'INTENTIONALLY_DISTINCT',
    rationale:
      'A jóváhagyás lejárata, nem az ügyé. A Z1 találat pont az volt, hogy ez hiányzott — de az, '
      + 'hogy egy jóváhagyás elévül, a küldés-jogosultságról szól, nem arról, hogy bárki elkésett.',
    migrationOrAdapter: null,
    storage: 'EPOCH',
  },
  {
    field: 'zst_partners.next_follow_up_at',
    semanticOwner: 'ZST partnerkezelés',
    sourceOfTruth: 'zst_partners',
    readers: ['zst partner nézet'],
    writers: ['zst partner nézet'],
    normalizedType: null,
    precedenceIfConflict: 0,
    status: 'INTENTIONALLY_DISTINCT',
    rationale:
      'CRM-kadencia egy PARTNERRE, nem egy ügyre. Ügy-szintű határidőként kezelve minden partner '
      + 'megjelenne a sorban anélkül, hogy bármi konkrét dolgunk lenne vele.',
    migrationOrAdapter: null,
    storage: 'EPOCH',
  },
  {
    field: 'case_documents.due_date / cos_documents.due_date',
    semanticOwner: 'dokumentumtár',
    sourceOfTruth: 'case_documents / cos_documents',
    readers: ['cos-documents.ts'],
    writers: ['cos-documents.ts'],
    normalizedType: 'DOCUMENT_DUE',
    precedenceIfConflict: 35,
    status: 'ADAPTED_TO_INDEX',
    rationale: 'A dokumentumból kiolvasott határidő (számla, felszólítás, hatósági levél).',
    migrationOrAdapter: 'ISO dátum → epoch',
    storage: 'ISO_DATE_TEXT',
  },
  {
    field: 'personal_invoices.overdue_shown',
    semanticOwner: 'privát pénzügy',
    sourceOfTruth: 'personal_invoices',
    readers: ['számla-nézet'],
    writers: ['számla-rögzítés'],
    normalizedType: null,
    precedenceIfConflict: 0,
    status: 'DEPRECATED',
    rationale:
      'Egy megjelenítési tény („ki lett-e írva, hogy lejárt"), TEXT-ben, határidő-nevű oszlopban. '
      + 'A `due_date` és a mostani idő ugyanezt megmondja, levezetve. Amíg a nézet olvassa, marad; '
      + 'új olvasó nem jöhet rá.',
    migrationOrAdapter: null,
    storage: 'ISO_DATE_TEXT',
  },
] as const

/** Deterministic preparation lead per kind (§10.2: "safe deadline computable
 *  deterministically where the rule is known").
 *
 *  These are not guesses dressed as constants: each is the honest answer to "how
 *  long does the LAST step take?". A contract termination needs a letter written,
 *  checked and posted; a payment needs a transfer that clears; a wake needs
 *  nothing at all, which is why it has no lead. */
export const INTERNAL_SAFE_LEAD_SEC: Record<DeadlineType, number> = {
  TERMINATION_DEADLINE: 7 * 86400,
  CONTRACT_EXPIRY: 14 * 86400,
  INITIATIVE_DECISION_DUE: 86400,
  PAYMENT_DUE: 3 * 86400,
  DOCUMENT_DUE: 2 * 86400,
  ESCALATION_DUE: 86400,
  CASE_DUE: 86400,
  FOLLOW_UP_DUE: 0,
  WATCH_DUE: 0,
  WAKE: 0,
  // A wait's own deadline needs no lead: nothing has to be PREPARED for the
  // moment a reply was expected -- the engine simply has to look. The stale
  // review is the same, and deliberately so: giving either a lead would make
  // the case surface early and then again on time, which is how a real signal
  // gets trained out of somebody.
  WAIT_EXPECTED_BY: 0,
  WAIT_STALE_REVIEW: 0,
}

/** §10.1's record, in this store's conventions (epoch seconds, not ISO). */
export interface DeadlineRecord {
  deadlineId: string
  domain: 'personal' | 'zst'
  caseId?: string
  /** `table.column#rowid`, so a record can always be traced back. */
  sourceRef: string
  deadlineType: DeadlineType
  externalDeadline: number
  internalSafeDeadline: number
  /** 1 for a stored epoch column; lower for anything parsed. A parsed date is a
   *  date somebody typed. */
  confidence: number
  precedence: number
  label: string
}

/**
 * ISO date TEXT → epoch seconds, or null.
 *
 * Strict `YYYY-MM-DD` and nothing else. The permissive alternative — hand it to
 * `Date.parse` and take what comes — is how `'2026. 09. 01.'` becomes a valid
 * date in some other year, and how an empty string becomes 1970. This morning's
 * `reconcile.ts` fix was the same family: a TEXT column compared as text. A TEXT
 * column PARSED as luck is the next one along.
 */
export function parseIsoDate(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim())
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const t = Date.UTC(y, mo - 1, d) / 1000
  // Round-trip check: Date.UTC happily accepts 2026-02-31 and rolls it into
  // March. A date that does not come back as itself was never that date.
  const back = new Date(t * 1000)
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return t
}

export function internalSafeDeadline(external: number, type: DeadlineType): number {
  return Math.max(0, external - INTERNAL_SAFE_LEAD_SEC[type])
}

interface Projection {
  table: string
  column: string
  type: DeadlineType
  domain: 'personal' | 'zst'
  /** Column holding the case id, when the table has one. */
  caseIdColumn: string | null
  idColumn: string
  labelColumn: string
  parse: boolean
  /** Extra WHERE, e.g. excluding closed rows. */
  where?: string
}

/** The projections, derived from the ontology entries marked ADAPTED_TO_INDEX.
 *  Written out rather than generated from the ontology strings, because a table
 *  and column name that a query depends on should be a thing the compiler and
 *  the reader can both see. The standing check is what keeps the two lists from
 *  drifting. */
const PROJECTIONS: readonly Projection[] = [
  { table: 'personal_cases', column: 'due_at', type: 'CASE_DUE', domain: 'personal', caseIdColumn: 'case_id', idColumn: 'case_id', labelColumn: 'title', parse: false, where: `status NOT IN ('COMPLETED','CANCELLED','ARCHIVED') AND archived_at IS NULL` },
  { table: 'personal_cases', column: 'follow_up_at', type: 'FOLLOW_UP_DUE', domain: 'personal', caseIdColumn: 'case_id', idColumn: 'case_id', labelColumn: 'title', parse: false, where: `status NOT IN ('COMPLETED','CANCELLED','ARCHIVED') AND archived_at IS NULL` },
  { table: 'personal_cases', column: 'next_wake_at', type: 'WAKE', domain: 'personal', caseIdColumn: 'case_id', idColumn: 'case_id', labelColumn: 'title', parse: false, where: `status NOT IN ('COMPLETED','CANCELLED','ARCHIVED') AND archived_at IS NULL` },
  { table: 'zst_cases', column: 'due_at', type: 'CASE_DUE', domain: 'zst', caseIdColumn: 'case_id', idColumn: 'case_id', labelColumn: 'title', parse: false, where: `status NOT IN ('COMPLETED','CANCELLED','ARCHIVED') AND archived_at IS NULL` },
  { table: 'zst_cases', column: 'follow_up_at', type: 'FOLLOW_UP_DUE', domain: 'zst', caseIdColumn: 'case_id', idColumn: 'case_id', labelColumn: 'title', parse: false, where: `status NOT IN ('COMPLETED','CANCELLED','ARCHIVED') AND archived_at IS NULL` },
  { table: 'zst_cases', column: 'next_wake_at', type: 'WAKE', domain: 'zst', caseIdColumn: 'case_id', idColumn: 'case_id', labelColumn: 'title', parse: false, where: `status NOT IN ('COMPLETED','CANCELLED','ARCHIVED') AND archived_at IS NULL` },
  { table: 'case_wait_conditions', column: 'expected_by', type: 'WAIT_EXPECTED_BY', domain: 'personal', caseIdColumn: 'case_id', idColumn: 'wait_id', labelColumn: 'subject', parse: false, where: `resolved_at IS NULL AND domain = 'personal'` },
  { table: 'case_wait_conditions', column: 'expected_by', type: 'WAIT_EXPECTED_BY', domain: 'zst', caseIdColumn: 'case_id', idColumn: 'wait_id', labelColumn: 'subject', parse: false, where: `resolved_at IS NULL AND domain = 'zst'` },
  { table: 'case_wait_conditions', column: 'stale_review_at', type: 'WAIT_STALE_REVIEW', domain: 'personal', caseIdColumn: 'case_id', idColumn: 'wait_id', labelColumn: 'subject', parse: false, where: `resolved_at IS NULL AND domain = 'personal'` },
  { table: 'case_wait_conditions', column: 'stale_review_at', type: 'WAIT_STALE_REVIEW', domain: 'zst', caseIdColumn: 'case_id', idColumn: 'wait_id', labelColumn: 'subject', parse: false, where: `resolved_at IS NULL AND domain = 'zst'` },
  { table: 'radar_items', column: 'next_check_at', type: 'WATCH_DUE', domain: 'personal', caseIdColumn: 'case_id', idColumn: 'radar_id', labelColumn: 'label', parse: false, where: `status = 'ACTIVE'` },
  { table: 'zst_obligations', column: 'follow_up_at', type: 'FOLLOW_UP_DUE', domain: 'zst', caseIdColumn: null, idColumn: 'rowid', labelColumn: 'rowid', parse: false },
  { table: 'zst_contracts', column: 'termination_deadline', type: 'TERMINATION_DEADLINE', domain: 'zst', caseIdColumn: 'case_id', idColumn: 'contract_id', labelColumn: 'title', parse: true },
  { table: 'zst_contracts', column: 'expiry_date', type: 'CONTRACT_EXPIRY', domain: 'zst', caseIdColumn: 'case_id', idColumn: 'contract_id', labelColumn: 'title', parse: true },
  { table: 'zst_invoices', column: 'due_date', type: 'PAYMENT_DUE', domain: 'zst', caseIdColumn: null, idColumn: 'rowid', labelColumn: 'rowid', parse: true },
  { table: 'personal_invoices', column: 'due_date', type: 'PAYMENT_DUE', domain: 'personal', caseIdColumn: null, idColumn: 'rowid', labelColumn: 'rowid', parse: true },
  { table: 'case_documents', column: 'due_date', type: 'DOCUMENT_DUE', domain: 'personal', caseIdColumn: 'case_id', idColumn: 'rowid', labelColumn: 'rowid', parse: true },
  { table: 'zst_product_escalations', column: 'due_at', type: 'ESCALATION_DUE', domain: 'zst', caseIdColumn: null, idColumn: 'rowid', labelColumn: 'rowid', parse: false },
  { table: 'proactive_initiatives', column: 'decision_deadline', type: 'INITIATIVE_DECISION_DUE', domain: 'personal', caseIdColumn: 'case_id', idColumn: 'initiative_id', labelColumn: 'current_gap', parse: false, where: `domain = 'personal' AND state NOT IN ('SUPPRESSED','RESOLVED')` },
  { table: 'proactive_initiatives', column: 'decision_deadline', type: 'INITIATIVE_DECISION_DUE', domain: 'zst', caseIdColumn: 'case_id', idColumn: 'initiative_id', labelColumn: 'current_gap', parse: false, where: `domain = 'zst' AND state NOT IN ('SUPPRESSED','RESOLVED')` },
]

export interface DeadlineIndexOptions {
  /** Only deadlines at or before `now + withinSec`. Omit for everything open. */
  withinSec?: number
  /** Include deadlines already in the past. Default true — an index that hides
   *  what is already late answers the wrong question. */
  includeOverdue?: boolean
  limit?: number
}

export interface DeadlineIndexResult {
  records: DeadlineRecord[]
  /** §11.2 C: the bound said out loud. */
  remaining: number
  /** Rows whose stored date could not be parsed. Reported, never dropped in
   *  silence: an unparseable termination date is a deadline nobody is tracking,
   *  which is worse than one that is late. */
  unparseable: Array<{ sourceRef: string; raw: string }>
}

/**
 * Project the deadline index for one domain.
 *
 * DOMAIN-SCOPED and never both at once (§20.3). Ordered by the deadline itself,
 * then by how binding it is — never by read order, which is the §11.2 E rule
 * that motivated this whole file.
 */
export function deadlineIndex(
  db: Database.Database,
  domain: 'personal' | 'zst',
  now: number,
  opts: DeadlineIndexOptions = {},
): DeadlineIndexResult {
  const includeOverdue = opts.includeOverdue ?? true
  const horizon = opts.withinSec != null ? now + opts.withinSec : null
  const records: DeadlineRecord[] = []
  const unparseable: Array<{ sourceRef: string; raw: string }> = []

  for (const p of PROJECTIONS.filter(x => x.domain === domain)) {
    let rows: Array<Record<string, unknown>> = []
    try {
      rows = db.prepare(
        `SELECT ${p.idColumn} AS id, ${p.column} AS v,
                ${p.caseIdColumn ?? 'NULL'} AS case_id, ${p.labelColumn} AS label
           FROM ${p.table}
          WHERE ${p.column} IS NOT NULL${p.where ? ` AND ${p.where}` : ''}`,
      ).all() as Array<Record<string, unknown>>
    } catch {
      // A table this deployment does not have is not a deadline that was missed.
      // Distinguished from a real read failure only by the fact that a partial
      // install is a supported state here and a corrupt one is not — the daily
      // reconcile is where an unreadable table gets reported, not here.
      continue
    }
    for (const r of rows) {
      const sourceRef = `${p.table}.${p.column}#${String(r.id)}`
      let epoch: number | null
      if (p.parse) {
        epoch = parseIsoDate(r.v)
        if (epoch === null) { unparseable.push({ sourceRef, raw: String(r.v) }); continue }
      } else {
        epoch = typeof r.v === 'number' && Number.isSafeInteger(r.v) ? r.v : null
        if (epoch === null) { unparseable.push({ sourceRef, raw: String(r.v) }); continue }
      }
      if (!includeOverdue && epoch < now) continue
      if (horizon !== null && epoch > horizon) continue
      const concept = conceptFor(p)
      records.push({
        deadlineId: sourceRef,
        domain,
        caseId: r.case_id == null ? undefined : String(r.case_id),
        sourceRef,
        deadlineType: p.type,
        externalDeadline: epoch,
        internalSafeDeadline: internalSafeDeadline(epoch, p.type),
        // A parsed date is a date somebody typed; a stored epoch was computed.
        confidence: p.parse ? 0.8 : 1,
        precedence: concept?.precedenceIfConflict ?? 99,
        label: String(r.label ?? ''),
      })
    }
  }

  records.sort((a, b) =>
    a.externalDeadline - b.externalDeadline
    || a.precedence - b.precedence
    || a.deadlineId.localeCompare(b.deadlineId))

  const limit = opts.limit
  if (limit != null && records.length > limit) {
    return { records: records.slice(0, limit), remaining: records.length - limit, unparseable }
  }
  return { records, remaining: 0, unparseable }
}

function conceptFor(p: Projection): DeadlineConcept | undefined {
  return DEADLINE_ONTOLOGY.find(c => c.field.includes(`${p.table}.${p.column}`))
}

/** The most binding deadline on one case, or null. What §11.2 E's ordering and
 *  §17.6's escape hatch both need, and what nothing could answer before. */
export function caseDeadline(
  db: Database.Database, domain: 'personal' | 'zst', caseId: string, now: number,
): DeadlineRecord | null {
  const all = deadlineIndex(db, domain, now).records.filter(r => r.caseId === caseId)
  return all[0] ?? null
}
