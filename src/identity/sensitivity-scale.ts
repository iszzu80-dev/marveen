// W10 — one canonical sensitivity scale, above the three that already exist.
//
// THE SITUATION THIS ADDRESSES. Three taxonomies live in this repo, each correct
// in its own domain and each tested:
//
//   fleet  src/data-sensitivity-gate.ts   public | internal | restricted
//   COS    src/cos/schema.ts              PUBLIC | PERSONAL | SENSITIVE_PERSONAL | HIGHLY_SENSITIVE
//   ZST    src/cos/zst-sensitivity.ts     PUBLIC | ZST_INTERNAL | ZST_CONFIDENTIAL | ZST_FINANCIAL
//                                         | ZST_LEGAL | ZST_PERSONAL_DATA | ZST_HIGHLY_SENSITIVE | UNKNOWN
//
// None of them is wrong, and collapsing them into one enum would be a large
// rewrite of working code for no behavioural gain -- §1.2 permits changing the
// HOW but not weakening what works. What is missing is the ability to state ONE
// policy that applies to all three. So this adds a scale ABOVE them, with total
// mappings in one direction only: domain -> canonical.
//
// The direction is deliberate. Mapping canonical -> domain would let a policy
// written here silently RELABEL a case in a domain store, which is how a
// HIGHLY_SENSITIVE case quietly becomes PERSONAL. Nothing here can lower a
// domain tier; the domain modules keep their own escalate-only rules.
//
// TAGS ARE ORTHOGONAL, AND THAT IS THE POINT. The ZST taxonomy encodes FINANCIAL
// and LEGAL as levels on the same axis as CONFIDENTIAL, which forces a choice
// between "this is confidential" and "this is financial" when the true answer is
// both. Levels answer HOW BAD; tags answer WHAT KIND. A policy needs both:
// CREDENTIAL at any level must never leave, while FINANCIAL at INTERNAL may.

/**
 * §4.2's classes. Ordered least → most restricted; the numeric rank is what
 * policy compares, so adding a class means placing it in this array and nowhere
 * else.
 */
export const SENSITIVITY_LEVELS = [
  'PUBLIC',
  'INTERNAL',
  'PERSONAL',
  'CONFIDENTIAL',
  'RESTRICTED',
  'SECRET',
] as const
export type SensitivityLevel = (typeof SENSITIVITY_LEVELS)[number]

/** Rank, least → most restricted. `SECRET` is the ceiling. */
export function levelRank(l: SensitivityLevel): number {
  return SENSITIVITY_LEVELS.indexOf(l)
}

/** The fail-closed answer for anything unrecognised. Not `PUBLIC`, ever. */
export const UNKNOWN_LEVEL: SensitivityLevel = 'SECRET'

/** §4.2's orthogonal tags. A thing may carry any number of them, or none. */
export const SENSITIVITY_TAGS = [
  'PII', 'CREDENTIAL', 'FINANCIAL', 'LEGAL', 'HEALTH', 'AUTH_TOKEN',
] as const
export type SensitivityTag = (typeof SENSITIVITY_TAGS)[number]

/**
 * Tags that must never leave the machine regardless of level.
 *
 * §4.4: SECRET / CREDENTIAL / AUTH_TOKEN default to DENY external propagation.
 * Expressed as tags rather than levels because a credential pasted into an
 * otherwise PUBLIC snippet is still a credential -- the level of the surrounding
 * text is not the question.
 */
export const NEVER_EXTERNAL_TAGS: readonly SensitivityTag[] = ['CREDENTIAL', 'AUTH_TOKEN']

export interface Classification {
  level: SensitivityLevel
  tags: readonly SensitivityTag[]
  /** Where the classification came from, for the audit record. */
  basis: string
}

export function coerceLevel(v: unknown): SensitivityLevel | null {
  return typeof v === 'string' && (SENSITIVITY_LEVELS as readonly string[]).includes(v)
    ? (v as SensitivityLevel)
    : null
}

/** Unrecognised input becomes the ceiling, and says so in `basis`. */
export function levelOrFailClosed(v: unknown, where: string): Classification {
  const l = coerceLevel(v)
  return l
    ? { level: l, tags: [], basis: `declared:${where}` }
    : { level: UNKNOWN_LEVEL, tags: [], basis: `UNRECOGNISED(${where}) -> fail-closed ${UNKNOWN_LEVEL}` }
}

// --- domain -> canonical (total, monotone) ---------------------------------
// Each mapping is total over its domain enum, so a new domain value cannot
// silently fall through to a default. The tests assert totality by iterating the
// domain's own exported array -- adding a value there fails the build's test run
// rather than quietly mapping to PUBLIC.

/** fleet: public | internal | restricted */
export function fromFleetCategory(c: string): SensitivityLevel {
  switch (c) {
    case 'public': return 'PUBLIC'
    case 'internal': return 'INTERNAL'
    case 'restricted': return 'RESTRICTED'
    default: return UNKNOWN_LEVEL
  }
}

/** COS: PUBLIC | PERSONAL | SENSITIVE_PERSONAL | HIGHLY_SENSITIVE */
export function fromCosSensitivity(c: string): SensitivityLevel {
  switch (c) {
    case 'PUBLIC': return 'PUBLIC'
    case 'PERSONAL': return 'PERSONAL'
    case 'SENSITIVE_PERSONAL': return 'CONFIDENTIAL'
    case 'HIGHLY_SENSITIVE': return 'SECRET'
    default: return UNKNOWN_LEVEL
  }
}

/** ZST: 8 values, three of which are really tags wearing a level's clothes. */
export function fromZstSensitivity(c: string): Classification {
  switch (c) {
    case 'PUBLIC': return { level: 'PUBLIC', tags: [], basis: 'zst:PUBLIC' }
    case 'ZST_INTERNAL': return { level: 'INTERNAL', tags: [], basis: 'zst:ZST_INTERNAL' }
    case 'ZST_CONFIDENTIAL': return { level: 'CONFIDENTIAL', tags: [], basis: 'zst:ZST_CONFIDENTIAL' }
    // The three that carry a KIND as well as a level. Mapping them to
    // CONFIDENTIAL + a tag is what lets a policy say "financial data may go to
    // the accountant" without also saying "confidential data may".
    case 'ZST_FINANCIAL': return { level: 'CONFIDENTIAL', tags: ['FINANCIAL'], basis: 'zst:ZST_FINANCIAL' }
    case 'ZST_LEGAL': return { level: 'CONFIDENTIAL', tags: ['LEGAL'], basis: 'zst:ZST_LEGAL' }
    case 'ZST_PERSONAL_DATA': return { level: 'PERSONAL', tags: ['PII'], basis: 'zst:ZST_PERSONAL_DATA' }
    case 'ZST_HIGHLY_SENSITIVE': return { level: 'SECRET', tags: [], basis: 'zst:ZST_HIGHLY_SENSITIVE' }
    case 'UNKNOWN': return { level: UNKNOWN_LEVEL, tags: [], basis: 'zst:UNKNOWN -> fail-closed' }
    default: return { level: UNKNOWN_LEVEL, tags: [], basis: `zst:UNRECOGNISED(${c}) -> fail-closed` }
  }
}

/**
 * Derive tags from the matched pattern NAMES the existing engine already
 * produces, so tagging reuses the one matcher instead of adding a second one.
 *
 * The pattern names are the fleet gate's own (`src/data-sensitivity-gate.ts`
 * DEFAULT_RESTRICTED / DEFAULT_INTERNAL) plus whatever an operator adds in
 * `store/data-sensitivity-gate.json`. An operator-added pattern with an unknown
 * name contributes NO tag -- it still raises the level through the existing
 * path, so an unknown pattern makes things stricter, never looser.
 */
export function tagsFromPatternNames(names: readonly string[]): readonly SensitivityTag[] {
  const out = new Set<SensitivityTag>()
  for (const n of names) {
    switch (n) {
      case 'email': out.add('PII'); break
      case 'hungarian_taj': out.add('PII'); out.add('HEALTH'); break
      case 'hungarian_tax_id': out.add('PII'); out.add('FINANCIAL'); break
      case 'credit_card_number': out.add('FINANCIAL'); out.add('PII'); break
      case 'api_key_header': out.add('CREDENTIAL'); out.add('AUTH_TOKEN'); break
      case 'jwt_token': out.add('CREDENTIAL'); out.add('AUTH_TOKEN'); break
      case 'dash_bearer_token': out.add('CREDENTIAL'); out.add('AUTH_TOKEN'); break
      case 'render_api_key': out.add('CREDENTIAL'); break
      case 'private_key_pem': out.add('CREDENTIAL'); break
      case 'db_connection_string': out.add('CREDENTIAL'); break
      case 'secret_key_name': out.add('CREDENTIAL'); break
      case 'vault_path': out.add('CREDENTIAL'); break
      default: break
    }
  }
  return Object.freeze([...out])
}

/** Merge classifications, taking the STRICTEST level and the union of tags. */
export function mergeClassifications(...cs: Classification[]): Classification {
  if (!cs.length) return { level: UNKNOWN_LEVEL, tags: [], basis: 'no input -> fail-closed' }
  let level = cs[0].level
  const tags = new Set<SensitivityTag>()
  const bases: string[] = []
  for (const c of cs) {
    if (levelRank(c.level) > levelRank(level)) level = c.level
    for (const t of c.tags) tags.add(t)
    bases.push(c.basis)
  }
  return { level, tags: Object.freeze([...tags]), basis: bases.join(' + ') }
}

/** Does this classification carry a tag that may never leave the machine? */
export function carriesNeverExternalTag(c: Classification): boolean {
  return c.tags.some(t => NEVER_EXTERNAL_TAGS.includes(t))
}
