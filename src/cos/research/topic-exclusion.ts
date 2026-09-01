// PHASE 3 (P3-B) -- THE CONTENT CLASSIFIER THAT MAY ONLY TIGHTEN.
//
// Owner policy 2026-09-01: normalising `ZST_INTERNAL` into the canonical
// vocabulary "csak namespace/default classification. Nem jelent automatikus
// research permissiont. A content-level classifier ezutan csak SZIGORITHAT."
// And then the list, by name: legal/authority, financial/banking/payment,
// contract, security, credentials/secrets, personal data, HR/personnel,
// confidential commercial details, UNKNOWN.
//
// WHY THIS EXISTS SEPARATELY FROM THE TIER. The tier answers "how sensitive is
// this case". This answers a different question -- "is this the KIND of subject
// the pilot was told to stay away from" -- and the two do not coincide. A ZST
// case about an unpaid invoice normalises to the same internal tier as one about
// a service outage; only the second belongs in a web-research pilot. Reading the
// tier alone would have let the first through on a technically correct number.
//
// It is a ONE-WAY valve: it can lift a case out of the pilot and it can never
// let one in. Nothing here returns "safe"; it returns a reason or nothing.
//
// The patterns are Hungarian and English, because the mailbox is.

export type ExcludedTopic =
  | 'LEGAL_OR_AUTHORITY'
  | 'FINANCIAL_BANKING_PAYMENT'
  | 'CONTRACT'
  | 'SECURITY'
  | 'CREDENTIALS_OR_SECRETS'
  | 'PERSONAL_DATA'
  | 'HR_PERSONNEL'
  | 'CONFIDENTIAL_COMMERCIAL'

export interface TopicExclusion {
  topic: ExcludedTopic
  /** The matched fragment, truncated. Enough to audit the decision, not enough
   *  to copy the content into a log. */
  evidence: string
}

const RULES: ReadonlyArray<{ topic: ExcludedTopic; re: RegExp }> = [
  { topic: 'LEGAL_OR_AUTHORITY', re: /\b(NAV|APEH|ceg?kapu|tarhely|tárhely|hatosag|hatóság|birosag|bíróság|vegrehajt|végrehajt|hatralek|hátralék|kereset|idezes|idézés|jogi kepvisel|jogi képvisel|ugyved|ügyvéd|lawyer|attorney|court|subpoena|litigation|regulator|compliance notice)/i },
  { topic: 'FINANCIAL_BANKING_PAYMENT', re: /\b(szamla|számla|invoice|fizetes|fizetés|payment|utalas|utalás|transfer|bankszamla|bankszámla|IBAN|SWIFT|BIC|kartya|kártya|card number|hitel|loan|tartozas|tartozás|overdue balance|penzugy|pénzügy|adó|ÁFA|VAT|kamat|deposit|refund)/i },
  { topic: 'CONTRACT', re: /\b(szerzodes|szerződés|contract|megallapod|megállapod|agreement|NDA|SLA|terms of service|felmond|termination clause|addendum|amendment|megújít|megujit|renewal terms)/i },
  { topic: 'SECURITY', re: /\b(security incident|breach|behatol|adatszivarg|adatszivárg|malware|ransomware|phishing|unauthorized access|jogosulatlan hozzafer|jogosulatlan hozzáfér|vulnerabilit|CVE-\d|exploit|2FA|MFA|gyanus belep|gyanús belép|suspicious (?:sign-?in|login))/i },
  { topic: 'CREDENTIALS_OR_SECRETS', re: /\b(jelszo|jelszó|password|passwd|api[_ -]?key|secret|token|credential|private key|access key|belepesi adat|belépési adat)/i },
  { topic: 'PERSONAL_DATA', re: /\b(TAJ|szemelyi szam|személyi szám|adoazonosito|adóazonosító|szuletesi|születési|lakcim|lakcím|passport|utlevel|útlevél|egeszsegugy|egészségügy|orvosi|diagnos|lelet|GDPR|erintetti|érintetti|adatvedelmi|adatvédelmi)/i },
  { topic: 'HR_PERSONNEL', re: /\b(munkaszerzod|munkaszerződ|munkavallal|munkavállal|employment|payroll|ber(?:ezes|szamfejt)|bérezés|bérszámfejt|felmondas|felmondás|allasinterju|állásinterjú|candidate cv|onelet(?:rajz)?|önéletrajz|HR |szabadsag kerelm|szabadság kérelm)/i },
  { topic: 'CONFIDENTIAL_COMMERCIAL', re: /\b(bizalmas|confidential|arres|árrés|margin|arkalkulaci|árkalkuláci|belso ar|belső ár|internal pricing|acquisition|due diligence|term sheet|cap table|uzleti titok|üzleti titok|proprietary)/i },
]

// A NOTE ON THE BOUNDARIES. These are PREFIX stems on purpose -- `munkaszerzod`
// has to match `munkaszerzodes`, `munkaszerzodest`, `munkaszerzodesben`, because
// Hungarian inflects and a word list that only matches the nominative is a word
// list that misses most of its own language. An earlier cut of this file closed
// every alternation with `\b` and silently matched almost nothing; it was caught
// by the test that names all eight classes.

/**
 * The first matching class, or null.
 *
 * FIRST rather than all, deliberately: the caller needs to refuse and to say
 * why, and a list of eight reasons is not a better refusal than one. The order
 * above is the owner's, so the strongest class names itself when several match.
 */
export function excludedTopicOf(content: string): TopicExclusion | null {
  const text = content ?? ''
  for (const rule of RULES) {
    const m = rule.re.exec(text)
    if (m) return { topic: rule.topic, evidence: m[0].slice(0, 24) }
  }
  return null
}

export const EXCLUDED_TOPICS: readonly ExcludedTopic[] = Object.freeze(RULES.map((r) => r.topic))
