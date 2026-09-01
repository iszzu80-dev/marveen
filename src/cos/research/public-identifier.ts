// PHASE 3 (P3-B) -- WHAT COUNTS AS A PUBLIC IDENTIFIER, AND WHAT ONLY LOOKS LIKE ONE.
//
// Owner policy 2026-09-01: "Egy szallito nyilvanos webdomainje kimehet research
// queryben, HA valoban public identifier ... nem customer-specific/private URL;
// nincs benne token, path-param, account-id, tenant-id vagy mas private
// identifier. Customer-specific subdomain / portal URL NEM public identifier
// automatikusan."
//
// And the sentence that shapes the whole file: "a domain lehet public, mikozben
// az a teny, hogy MI kapcsolatban allunk vele, nem public."
//
// So this module answers one narrow question -- is this string a thing anybody
// could have typed without knowing us -- and it answers NO by default. It
// returns the REGISTRABLE ROOT, never what it was given: `portal.acme.com/u/42`
// is not sanitised into `acme.com` and passed along, it is refused, because a
// caller that meant the root can say the root and a caller that meant the portal
// meant the customer-specific thing.
//
// Two categories are refused even though they are perfectly public domains:
//
//   FREE MAIL. `gmail.com` identifies a person, not a vendor. Searching it
//   researches nothing and the only information in the query is that we are
//   interested in somebody's mail.
//
//   AUTHORITIES. A `gov.hu` sender is the legal/administrative class the owner
//   lifted out of this pilot by name. That the tax authority wrote to us is
//   exactly the fact that must not leave.

/** Suffixes where the registrable name is the THIRD label from the right. Kept
 *  short and explicit: a full public-suffix list is a dependency and a lie by
 *  omission is worse here than a refusal. Anything not listed uses two labels,
 *  and a caller that needs more says so by passing the root itself. */
const TWO_LEVEL_SUFFIXES = [
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'com.au', 'co.nz',
  'com.br', 'co.za', 'com.tr', 'co.il', 'com.mx',
]

/** Mail that identifies a person rather than an organisation. */
const FREE_MAIL = [
  'gmail.com', 'googlemail.com', 'freemail.hu', 'citromail.hu', 'yahoo.com',
  'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com',
  'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com', 't-online.hu',
]

/** The administrative/authority class, lifted out of the pilot by the owner. */
const AUTHORITY_SUFFIXES = [
  'gov.hu', 'gov.uk', 'europa.eu', 'nmhh.hu', 'mkik.hu', 'onyf.hu', 'police.hu',
  'kormany.hu', 'birosag.hu', 'ksh.hu',
]

/** Labels that mark a host as belonging to one customer rather than to everybody. */
const CUSTOMER_SPECIFIC_LABELS = [
  'portal', 'my', 'account', 'accounts', 'client', 'clients', 'customer',
  'tenant', 'app', 'dashboard', 'admin', 'secure', 'login', 'billing', 'invoice',
]

export interface PublicIdentifierVerdict {
  ok: boolean
  /** The registrable root, present only when ok. */
  value: string | null
  /** Always present. A refusal that cannot say why is not a decision. */
  reason: string
}

const REFUSE = (reason: string): PublicIdentifierVerdict => ({ ok: false, value: null, reason })

/**
 * Decide whether `raw` is a public vendor identifier, and return the root.
 *
 * `raw` may be a bare host or an email address. Anything carrying a scheme, a
 * path, a query string, a port or credentials is refused rather than trimmed --
 * see the header.
 */
export function publicVendorIdentifier(raw: string | null | undefined): PublicIdentifierVerdict {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s) return REFUSE('empty')

  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) return REFUSE('a URL was given, not a domain: a scheme can carry a path and a path can carry a customer')
  if (s.includes('/')) return REFUSE('contains a path; a customer-specific page is not a public identifier')
  if (s.includes('?') || s.includes('#')) return REFUSE('contains a query string or fragment, which is where tokens live')
  if (s.includes(':')) return REFUSE('contains a port or credentials')
  if (/\s/.test(s)) return REFUSE('contains whitespace')

  const host = s.includes('@') ? s.split('@').pop()! : s
  if (!host) return REFUSE('no host part')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return REFUSE('an IP address is not a vendor identifier')
  if (!/^[a-z0-9.-]+$/.test(host)) return REFUSE('contains characters a hostname may not')
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return REFUSE('malformed host')

  const labels = host.split('.')
  if (labels.length < 2) return REFUSE('not a domain')
  if (labels.some((l) => l.length === 0)) return REFUSE('empty label')

  const twoLevel = TWO_LEVEL_SUFFIXES.find((suf) => host === suf || host.endsWith(`.${suf}`))
  const rootLabels = twoLevel ? 3 : 2
  if (labels.length < rootLabels) return REFUSE('shorter than its own registrable root')
  const root = labels.slice(-rootLabels).join('.')
  const subLabels = labels.slice(0, labels.length - rootLabels)

  if (AUTHORITY_SUFFIXES.some((a) => root === a || host === a || host.endsWith(`.${a}`))) {
    return REFUSE(`${root} is a public authority: that we are in contact with them is the fact that must not leave`)
  }
  if (FREE_MAIL.includes(root)) {
    return REFUSE(`${root} is free mail: it identifies a person, not a vendor, and searching it researches nothing`)
  }

  // A SUBDOMAIN IS NOT AUTOMATICALLY PUBLIC, and this refuses rather than
  // silently reducing to the root: a caller that wanted the root can pass the
  // root. Reducing would quietly turn "the customer portal we were given" into
  // "the vendor's public site" and lose the distinction the owner drew.
  const suspicious = subLabels.find(
    (l) => CUSTOMER_SPECIFIC_LABELS.includes(l) || /\d{3,}/.test(l) || l.length >= 20,
  )
  if (suspicious) {
    return REFUSE(`subdomain "${suspicious}" looks customer-specific; pass the vendor's root domain instead of a host we were handed`)
  }
  // `www` is the one subdomain that means "everybody's".
  if (subLabels.length && !(subLabels.length === 1 && subLabels[0] === 'www')) {
    return REFUSE(`"${host}" is a subdomain, and a subdomain is not automatically a public identifier`)
  }

  return { ok: true, value: root, reason: `${root} is a registrable public root domain` }
}
