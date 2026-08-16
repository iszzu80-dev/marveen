// Personal Chief of Staff (COS) — Scope Gate + v4.4/v1.2 namespace boundary.
//
// SECURITY POLICY (2026-08-16 target baseline): connector identity is the
// automatic storage boundary. Content is evidence ABOUT scope, but untrusted
// message content may never move an item across the Personal/ZST boundary.
//
// This deliberately supersedes the 2026-08-09 "content can override mailbox"
// rule. That earlier rule fixed misfiling but created a stronger security flaw:
// a message arriving through the private connector could be written directly
// into the ZST operational store merely because its text looked corporate.
// Under ZST CoS v1.2 that is forbidden. Cross-domain movement requires an
// explicit, human-approved bridge and keeps the original provenance.
//
// Pure function over text + connector identity. No DB, no network. The caller
// may create a scope-review/quarantine case in the connector's own namespace;
// it must NOT reinterpret `needsReview` as permission to cross namespaces.

export type ScopeVerdict =
  | 'PERSONAL_CONFIRMED'
  | 'PERSONAL_PROBABLE'
  | 'AMBIGUOUS'
  | 'CORPORATE_EXCLUDED'
  | 'ZST_EXCLUDED'
  | 'SECURITY_BLOCKED'

export interface ScopeDecision {
  verdict: ScopeVerdict
  /** Automatic store selected ONLY by connector identity; null means blocked. */
  target: 'personal' | 'zst' | null
  /** True when a human should review scope / optionally approve a bridge. */
  needsReview: boolean
  /** Why, in rule order. Never empty. */
  reasons: string[]
}

export const ZST_MARKERS = [
  'zst radio', 'zst rádió', 'zstradio', 'zst kft', 'üzletrész', 'uzletresz',
  'ügyvezető', 'ugyvezeto', 'taggyűlés', 'taggyules', 'cégbíróság', 'cegbirosag',
]
export const CORPORATE_MARKERS = [
  'one magyarország', 'one magyarorszag', 'product lab', 'productlab',
  'számlázz.hu', 'szamlazz.hu', 'nav online számla', 'könyvelő', 'konyvelo',
  'áfabevallás', 'afabevallas', 'társasági adó', 'tarsasagi ado', 'céges',
]
export const PERSONAL_MARKERS = [
  'család', 'csalad', 'gyerek', 'feleség', 'feleseg', 'iskola', 'óvoda', 'ovoda',
  'ház', 'haz', 'lakás', 'lakas', 'kert', 'medence', 'felújítás', 'felujitas',
  'szerelő', 'szerelo', 'garancia', 'orvos', 'fogorvos', 'recept', 'nyaralás',
  'nyaralas', 'szállás', 'szallas', 'repülő', 'repulo', 'autóbérlés', 'autoberles',
  'rendelés', 'rendeles', 'csomag', 'reklamáció', 'reklamacio', 'visszaküldés',
  'visszakuldes', 'anyakönyvi', 'anyakonyvi', 'ingatlan', 'tulajdoni',
]
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
  /** Stable connector/account identity. It is the automatic namespace authority. */
  accountId?: string
  /** Accounts whose connector identity is the ZST corporate ingress. */
  corporateAccounts?: string[]
}

/**
 * Classify one inbound item without allowing content-driven namespace crossing.
 *
 * Rules:
 *   1. injection -> SECURITY_BLOCKED, no write.
 *   2. choose automatic target from connector identity.
 *   3. inspect content only to assess confidence/mismatch.
 *   4. mismatch stays in the connector namespace and `needsReview=true`.
 *      An explicit human bridge is a separate command, outside this function.
 */
export function classifyScope(input: ScopeInput): ScopeDecision {
  const text = fold(input.text)
  const corporateAccounts = input.corporateAccounts ?? ['zst']
  const fromCorporateBox = !!input.accountId && corporateAccounts.includes(input.accountId)
  const automaticTarget: 'personal' | 'zst' = fromCorporateBox ? 'zst' : 'personal'

  const inj = hits(text, INJECTION_MARKERS)
  if (inj.length) {
    return {
      verdict: 'SECURITY_BLOCKED', target: null, needsReview: true,
      reasons: [`utasítás-manipulációra utaló tartalom: "${inj[0]}"`,
        'untrusted tartalom nem módosíthat szabályt, jóváhagyást vagy namespace-et'],
    }
  }

  const zst = hits(text, ZST_MARKERS)
  const corp = hits(text, CORPORATE_MARKERS)
  const pers = hits(text, PERSONAL_MARKERS)

  if (fromCorporateBox) {
    if (pers.length && !zst.length && !corp.length) {
      return {
        verdict: 'AMBIGUOUS', target: automaticTarget, needsReview: true,
        reasons: [
          `személyes tárgykörre utaló tartalom a ZST connectoron: ${pers.slice(0, 3).join(', ')}`,
          'connector identity megtartja a ZST namespace-et; cross-route nincs',
        ],
      }
    }
    if (zst.length || corp.length) {
      return {
        verdict: 'ZST_EXCLUDED', target: automaticTarget, needsReview: false,
        reasons: [
          `ZST/céges tartalom a ZST connectoron: ${[...zst, ...corp].slice(0, 3).join(', ')}`,
          'connector identity és tartalom összhangban',
        ],
      }
    }
    return {
      verdict: 'AMBIGUOUS', target: automaticTarget, needsReview: false,
      reasons: ['a tartalomból nem dönthető el a hatókör', 'ZST connector identity -> ZST namespace'],
    }
  }

  // Private connector: NEVER target ZST automatically, even for unmistakable
  // ZST content. Preserve the source in Personal scope-review/quarantine and let
  // an explicit, audited human bridge copy/project it later.
  if (zst.length || corp.length) {
    return {
      verdict: zst.length ? 'ZST_EXCLUDED' : 'CORPORATE_EXCLUDED',
      target: automaticTarget,
      needsReview: true,
      reasons: [
        `céges/ZST tartalom privát connectoron: ${[...zst, ...corp].slice(0, 3).join(', ')}`,
        'connector identity megtartja a Personal namespace-et; ZST bridge csak explicit emberi jóváhagyással',
      ],
    }
  }

  if (pers.length) {
    return {
      verdict: 'PERSONAL_CONFIRMED', target: automaticTarget, needsReview: false,
      reasons: [`személyes tárgykör: ${pers.slice(0, 3).join(', ')}`, 'privát connector identity -> Personal namespace'],
    }
  }

  return {
    verdict: 'PERSONAL_PROBABLE', target: automaticTarget, needsReview: false,
    reasons: ['a tartalomból nem dönthető el a hatókör', 'privát connector identity -> Personal namespace'],
  }
}

/** One-line summary for case description / audit trail. */
export function describeScope(d: ScopeDecision): string {
  return `${d.verdict}${d.needsReview ? ' (emberi ellenőrzés kell)' : ''}: ${d.reasons.join('; ')}`
}
