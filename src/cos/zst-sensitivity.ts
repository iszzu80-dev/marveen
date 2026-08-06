// ZST Radio Kft. Chief of Staff (Slice 0) — static data-sensitivity policy
// (spec §14). Mirrors the Personal sensitivity module (sensitivity.ts) but with
// the ZST business classes and the SAME two invariants:
//   - the classifier only ESCALATES (never lowers a declared tier);
//   - FAIL-CLOSED: an unknown/unrecognised tier is treated as the most
//     restrictive (ZST_HIGHLY_SENSITIVE), never as PUBLIC — spec §14.2
//     (UNKNOWN → SECURITY_REVIEW_REQUIRED / no autonomous external action).
// Reuses the fleet gate's ONE regex engine (matchSensitivityPatterns) so
// matching semantics never fork.

import type { SensitivityPattern } from '../data-sensitivity-gate.js'
import { matchSensitivityPatterns } from '../data-sensitivity-gate.js'
import { MODEL_PROFILE_IDS, type ModelProfileId } from '../model-profiles.js'

// ZST sensitivity classes (spec §14.1). MUST stay in sync with the zst_cases
// sensitivity CHECK constraint in schema.ts.
export const ZST_SENSITIVITIES = [
  'PUBLIC', 'ZST_INTERNAL', 'ZST_CONFIDENTIAL', 'ZST_FINANCIAL', 'ZST_LEGAL',
  'ZST_PERSONAL_DATA', 'ZST_HIGHLY_SENSITIVE', 'UNKNOWN',
] as const
export type ZstSensitivity = (typeof ZST_SENSITIVITIES)[number]

// Restriction rank, least → most restricted. FINANCIAL / LEGAL / PERSONAL_DATA
// are parallel "restricted" categories at the same rank; UNKNOWN shares the
// most-restricted rank with HIGHLY_SENSITIVE (fail-closed).
const SENSITIVITY_RANK: Record<ZstSensitivity, number> = {
  PUBLIC: 0,
  ZST_INTERNAL: 1,
  ZST_CONFIDENTIAL: 2,
  ZST_FINANCIAL: 3,
  ZST_LEGAL: 3,
  ZST_PERSONAL_DATA: 3,
  ZST_HIGHLY_SENSITIVE: 4,
  UNKNOWN: 4,
}

// The fail-closed target — the most restrictive concrete class.
export const MOST_RESTRICTED: ZstSensitivity = 'ZST_HIGHLY_SENSITIVE'

// Coerce any value into a known class, FAIL-CLOSED to ZST_HIGHLY_SENSITIVE.
// (A literal 'UNKNOWN' also coerces to the most-restricted treatment.)
export function coerceZstSensitivity(value: unknown): ZstSensitivity {
  if (typeof value === 'string' && (ZST_SENSITIVITIES as readonly string[]).includes(value)) {
    return value === 'UNKNOWN' ? MOST_RESTRICTED : (value as ZstSensitivity)
  }
  return MOST_RESTRICTED
}

// Return the MORE restricted of two classes (the escalation rule). On a rank tie
// between different categories, the first argument wins (order-stable).
export function escalateZstSensitivity(a: ZstSensitivity, b: ZstSensitivity): ZstSensitivity {
  return SENSITIVITY_RANK[a] >= SENSITIVITY_RANK[b] ? a : b
}

// ---- classifier pattern sets (ZST-business oriented) -------------------------
// Checked most-restricted first; the first class with any match wins.

const HIGHLY_SENSITIVE_PATTERNS: SensitivityPattern[] = [
  { name: 'private_key_pem', pattern: '-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----', description: 'PEM private key block' },
  { name: 'api_key_or_token', pattern: '(?:Bearer\\s+[A-Za-z0-9_\\-]{20,}|eyJ[A-Za-z0-9_\\-]{20,}\\.[A-Za-z0-9_\\-]{20,}\\.[A-Za-z0-9_\\-]{10,}|rnd_[A-Za-z0-9]{20,})', description: 'Credential: bearer token, JWT, or Render key' },
  { name: 'password_literal', pattern: '(?:jelszó|password|passwd|pwd)\\s*[:=]\\s*\\S{6,}', description: 'Password literal' },
]

const FINANCIAL_PATTERNS: SensitivityPattern[] = [
  { name: 'iban_bank_account', pattern: '\\b[A-Z]{2}\\d{2}[A-Z0-9]{11,30}\\b', context: 'iban|bank|számla|account|utalás|transfer|fizet', description: 'IBAN / bank account number' },
  { name: 'credit_card_number', pattern: '\\b\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}\\b', description: 'Card number' },
  { name: 'hungarian_company_tax', pattern: '\\b\\d{8}-\\d-\\d{2}\\b', context: 'adószám|adóazonosító|NAV|áfa|számla|invoice', description: 'Hungarian company tax number' },
]

const LEGAL_PATTERNS: SensitivityPattern[] = [
  { name: 'contract_terms', pattern: '(?:szerződés|megállapodás|contract|agreement|NDA|titoktartás|felmondás|kártérítés|kötbér)', context: 'aláír|hatályba|felek|kötelezettség|díj|SLA|adatfeldolgoz', description: 'Contract / legal-commitment language' },
]

const PERSONAL_DATA_PATTERNS: SensitivityPattern[] = [
  { name: 'phone_number_hu', pattern: '(?:\\+36|\\b06)[\\s-]?\\d{1,2}[\\s-]?\\d{3}[\\s-]?\\d{3,4}\\b', description: 'Hungarian phone number' },
  { name: 'email_address', pattern: '[\\w.+-]+@[\\w.-]+\\.[\\w]{2,}', description: 'Email address (contact personal data)' },
]

export interface ZstClassification {
  tier: ZstSensitivity
  matched: string[]
}

// Classify raw content into the most-restricted ZST class whose patterns match.
// No match → PUBLIC. This only ESCALATES; combine with the declared class via
// escalateZstSensitivity().
export function classifyZstSensitivity(content: string): ZstClassification {
  const highly = matchSensitivityPatterns(content, HIGHLY_SENSITIVE_PATTERNS)
  if (highly.length > 0) return { tier: 'ZST_HIGHLY_SENSITIVE', matched: highly }

  const financial = matchSensitivityPatterns(content, FINANCIAL_PATTERNS)
  if (financial.length > 0) return { tier: 'ZST_FINANCIAL', matched: financial }

  const legal = matchSensitivityPatterns(content, LEGAL_PATTERNS)
  if (legal.length > 0) return { tier: 'ZST_LEGAL', matched: legal }

  const personal = matchSensitivityPatterns(content, PERSONAL_DATA_PATTERNS)
  if (personal.length > 0) return { tier: 'ZST_PERSONAL_DATA', matched: personal }

  return { tier: 'PUBLIC', matched: [] }
}

// Effective class = the MORE restricted of the declared class and what the
// content classifier finds. Declared is coerced fail-closed first.
export function effectiveZstSensitivity(declared: unknown, content: string): ZstSensitivity {
  return escalateZstSensitivity(coerceZstSensitivity(declared), classifyZstSensitivity(content).tier)
}

// ---- model-profile allowlist (spec §14.3) ------------------------------------
// Static policy: the more restricted the class, the fewer model profiles allowed
// to process it. Every class must be present; a missing class resolves to
// undefined and the fail-closed helper denies it. Dynamic routing is NOT a
// prerequisite (spec §14.3) — this static table is mandatory from Slice 0.
const PROFILE_ALLOWLIST: Record<ZstSensitivity, ReadonlySet<ModelProfileId>> = {
  PUBLIC: new Set<ModelProfileId>(MODEL_PROFILE_IDS),
  ZST_INTERNAL: new Set<ModelProfileId>(['premium_reasoning', 'build_strong', 'analysis_efficient']),
  ZST_CONFIDENTIAL: new Set<ModelProfileId>(['premium_reasoning', 'build_strong']),
  ZST_FINANCIAL: new Set<ModelProfileId>(['premium_reasoning']),
  ZST_LEGAL: new Set<ModelProfileId>(['premium_reasoning']),
  ZST_PERSONAL_DATA: new Set<ModelProfileId>(['premium_reasoning']),
  ZST_HIGHLY_SENSITIVE: new Set<ModelProfileId>(['premium_reasoning']),
  UNKNOWN: new Set<ModelProfileId>(['premium_reasoning']),
}

// Is `profile` allowed to process content of `tier`? FAIL-CLOSED: unknown tier →
// most restricted; unknown profile → never allowed.
export function isProfileAllowedForZstSensitivity(profile: string, tier: unknown): boolean {
  return PROFILE_ALLOWLIST[coerceZstSensitivity(tier)].has(profile as ModelProfileId)
}

export function allowedProfilesForZst(tier: unknown): ReadonlySet<ModelProfileId> {
  return PROFILE_ALLOWLIST[coerceZstSensitivity(tier)]
}

export type ZstGateVerdict = 'allow' | 'block'

export interface ZstGateResult {
  verdict: ZstGateVerdict
  tier: ZstSensitivity
  matched: string[]
  reason: string
}

// Full ZST check: classify content, escalate against the declared class, and
// authorise the target model profile against the effective class. FAIL-CLOSED
// throughout.
export function evaluateZstDispatch(
  content: string,
  declaredSensitivity: unknown,
  targetProfile: string,
): ZstGateResult {
  const { matched } = classifyZstSensitivity(content)
  const tier = effectiveZstSensitivity(declaredSensitivity, content)
  const allowed = isProfileAllowedForZstSensitivity(targetProfile, tier)
  return {
    verdict: allowed ? 'allow' : 'block',
    tier,
    matched,
    reason: allowed
      ? `profile=${targetProfile} allowed for tier=${tier}`
      : `profile=${targetProfile} NOT allowed for tier=${tier} (allowed: ${[...allowedProfilesForZst(tier)].join(', ')})`,
  }
}
