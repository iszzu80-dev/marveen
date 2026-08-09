// Personal Chief of Staff (COS) — the Scope Gate (§2).
//
// The spec asks for a verdict on every inbound item BEFORE it is written:
// PERSONAL_CONFIRMED / PERSONAL_PROBABLE / AMBIGUOUS / CORPORATE_EXCLUDED /
// ZST_EXCLUDED / SECURITY_BLOCKED. What got built instead was a routing rule:
// the mailbox the mail arrived in decides which store it goes to. That rule is
// deterministic and cheap and it was the right call at the time — but it is not
// a scope gate, and on 2026-08-09 it put two ZST share-transfer cases into the
// personal store, because Istvan wrote them from his private address.
//
// Istvan's decision (2026-08-09): the Scope Gate is the truth, the mailbox is a
// signal that helps — "de sajnos keveredik néha".
//
// So the mailbox is a PRIOR, not a verdict. Content can override it, and where
// content and mailbox disagree without either being decisive, the honest answer
// is AMBIGUOUS: a case that gets written to the store the mailbox suggests AND
// flagged for a human, rather than filed confidently in the wrong place. The
// system does not get to be sure when it isn't.
//
// Pure function over text. No DB, no network — the caller decides what to do
// with the verdict, which keeps the policy inspectable and the routing testable.

export type ScopeVerdict =
  | 'PERSONAL_CONFIRMED'
  | 'PERSONAL_PROBABLE'
  | 'AMBIGUOUS'
  | 'CORPORATE_EXCLUDED'
  | 'ZST_EXCLUDED'
  | 'SECURITY_BLOCKED'

export interface ScopeDecision {
  verdict: ScopeVerdict
  /** Which store the caller should write to, or null when nothing may be written. */
  target: 'personal' | 'zst' | null
  /** True when a human should look at the placement. */
  needsReview: boolean
  /** Why, in the order the rules fired. Never empty. */
  reasons: string[]
}

/** Company-scope markers. ZST is separated from the general corporate list
 *  because it has its own COS namespace to route to; the rest have nowhere to
 *  go and must be kept out rather than filed. */
export const ZST_MARKERS = [
  'zst radio', 'zst rádió', 'zstradio', 'zst kft', 'üzletrész', 'uzletresz',
  'ügyvezető', 'ugyvezeto', 'taggyűlés', 'taggyules', 'cégbíróság', 'cegbirosag',
]
export const CORPORATE_MARKERS = [
  'one magyarország', 'one magyarorszag', 'product lab', 'productlab',
  'számlázz.hu', 'szamlazz.hu', 'nav online számla', 'könyvelő', 'konyvelo',
  'áfabevallás', 'afabevallas', 'társasági adó', 'tarsasagi ado', 'céges',
]
/** Personal-scope markers, from the spec's allowed list. */
export const PERSONAL_MARKERS = [
  'család', 'csalad', 'gyerek', 'feleség', 'feleseg', 'iskola', 'óvoda', 'ovoda',
  'ház', 'haz', 'lakás', 'lakas', 'kert', 'medence', 'felújítás', 'felujitas',
  'szerelő', 'szerelo', 'garancia', 'orvos', 'fogorvos', 'recept', 'nyaralás',
  'nyaralas', 'szállás', 'szallas', 'repülő', 'repulo', 'autóbérlés', 'autoberles',
  'rendelés', 'rendeles', 'csomag', 'reklamáció', 'reklamacio', 'visszaküldés',
  'visszakuldes', 'anyakönyvi', 'anyakonyvi', 'ingatlan', 'tulajdoni',
]
/** Prompt-injection / manipulation shapes. Content that tries to change the
 *  rules is never scope-classified, it is blocked — §10 is explicit that
 *  untrusted content must not modify rules, approvals or scope. */
export const INJECTION_MARKERS = [
  'ignore previous instructions', 'ignore all previous', 'disregard the above',
  'you are now', 'system prompt', 'reveal your instructions', 'felejtsd el az eddigi',
  'hagyd figyelmen kívül az utasítás', 'told el a szabály',
]

const ACCENTS = 'áéíóöőúüűÁÉÍÓÖŐÚÜŰ'
const PLAIN = 'aeiooouuuAEIOOOUUU'
function fold(s: string): string {
  let out = ''
  for (const ch of s ?? '') {
    const i = ACCENTS.indexOf(ch)
    out += i >= 0 ? PLAIN[i] : ch
  }
  return out.toLowerCase()
}
const hits = (text: string, markers: string[]) => markers.filter((m) => text.includes(fold(m)))

export interface ScopeInput {
  /** Subject + snippet + whatever else describes the item. */
  text: string
  /** The mailbox it arrived in. A prior, not a verdict. */
  accountId?: string
  /** Accounts that belong to the company. */
  corporateAccounts?: string[]
}

/**
 * Classify one inbound item.
 *
 * Rule order is the policy, so it is written out rather than buried in nested
 * conditions:
 *   1. injection      → SECURITY_BLOCKED, nothing is written at all.
 *   2. ZST content    → ZST_EXCLUDED from personal; it has its own namespace.
 *   3. other company  → CORPORATE_EXCLUDED; there is nowhere to file it.
 *   4. personal words → PERSONAL_CONFIRMED.
 *   5. neither        → the mailbox decides, but only as PROBABLE / AMBIGUOUS,
 *                       never as CONFIRMED. An empty signal is not evidence.
 */
export function classifyScope(input: ScopeInput): ScopeDecision {
  const text = fold(input.text)
  const corporateAccounts = input.corporateAccounts ?? ['zst']
  const fromCorporateBox = !!input.accountId && corporateAccounts.includes(input.accountId)
  const reasons: string[] = []

  const inj = hits(text, INJECTION_MARKERS)
  if (inj.length) {
    return {
      verdict: 'SECURITY_BLOCKED', target: null, needsReview: true,
      reasons: [`utasítás-manipulációra utaló tartalom: "${inj[0]}"`,
        'a §10 szerint az untrusted tartalom nem módosíthat szabályt, jóváhagyást vagy hatókört'],
    }
  }

  const zst = hits(text, ZST_MARKERS)
  const corp = hits(text, CORPORATE_MARKERS)
  const pers = hits(text, PERSONAL_MARKERS)

  if (zst.length) {
    reasons.push(`ZST-tartalom: ${zst.slice(0, 3).join(', ')}`)
    if (!fromCorporateBox) {
      reasons.push('privát postafiókból érkezett, de a tartalom céges — a tartalom dönt')
    }
    return { verdict: 'ZST_EXCLUDED', target: 'zst', needsReview: !fromCorporateBox, reasons }
  }

  if (corp.length) {
    reasons.push(`céges tartalom: ${corp.slice(0, 3).join(', ')}`)
    reasons.push('nincs hova sorolni a személyes tárban — emberi döntés kell')
    return { verdict: 'CORPORATE_EXCLUDED', target: null, needsReview: true, reasons }
  }

  if (pers.length) {
    reasons.push(`személyes tárgykör: ${pers.slice(0, 3).join(', ')}`)
    if (fromCorporateBox) {
      // Personal words in the company mailbox: keep it where the mailbox says,
      // but say so. Filing a company mail into the personal store on the strength
      // of the word "csomag" is exactly the mistake in the other direction.
      reasons.push('céges postafiókból érkezett — a postafiók marad az irányadó, de nézd meg')
      return { verdict: 'AMBIGUOUS', target: 'zst', needsReview: true, reasons }
    }
    return { verdict: 'PERSONAL_CONFIRMED', target: 'personal', needsReview: false, reasons }
  }

  // No content signal at all. The mailbox is all we have, and a prior alone is
  // not confirmation — PROBABLE, and the case is still written.
  reasons.push('a tartalomból nem dönthető el a hatókör')
  if (fromCorporateBox) {
    reasons.push('céges postafiók — valószínűleg céges')
    return { verdict: 'AMBIGUOUS', target: 'zst', needsReview: false, reasons }
  }
  reasons.push('privát postafiók — valószínűleg személyes')
  return { verdict: 'PERSONAL_PROBABLE', target: 'personal', needsReview: false, reasons }
}

/** One-line summary for the case description / audit trail. */
export function describeScope(d: ScopeDecision): string {
  return `${d.verdict}${d.needsReview ? ' (emberi ellenőrzés kell)' : ''}: ${d.reasons.join('; ')}`
}
