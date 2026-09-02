// W10 — the declared inventory of every way this system reaches outside itself.
//
// Istvan's HYBRID EXTERNAL ACTION BOUNDARY decision (2026-08-25) allows direct
// read-only external access WITHOUT a generic proxy, on four conditions: the
// credential is provably read-only / least-privilege, the capability is DECLARED
// and INVENTORIED, the call is auditable, and it cannot produce a side effect.
//
// This file is the "declared and inventoried" half. It is not documentation
// about the connectors; it is the data the broker reads at runtime to decide
// whether a call is a supported path at all. An undeclared connector is denied,
// which is the only way an inventory can stay true: if forgetting to add an
// entry were free, the inventory would drift into fiction within a release.
//
// WHAT `readOnly` MEANS HERE, AND WHAT IT DOES NOT.
//
// `readOnly: true` is a claim about the CREDENTIAL's granted scope, not about
// the code that uses it. It is the claim that even a fully compromised caller
// holding this credential cannot mutate anything at the provider, because the
// provider itself would refuse. That is the only form of the claim worth
// anything -- "our code only calls read methods" is a statement about today's
// code, and the next commit can falsify it silently.
//
// So each read-only entry names `scopeEvidence`: WHERE the granted scope can be
// checked, so the claim is falsifiable rather than asserted. A read-only claim
// with no way to check it is worse than no claim, because it is believed.
//
// MEASURED, NOT ASSUMED (last re-measured 2026-09-02).
//
// Every `grantedScopes` list below was read from Google's own tokeninfo endpoint
// for the credential named in the entry, not copied from a comment or a memory
// of a consent screen. `scripts/w10-verify-external-scopes.ts` re-runs that
// measurement and exits non-zero on drift, so this file is a claim that can be
// falsified on demand rather than a claim that ages quietly.
//
// The first run of that measurement immediately falsified two long-standing
// comments in this repository -- see the `gmail.send` and `gmail.label` entries.
// That is the value: an inventory nobody can check is a document, and documents
// drift; an inventory a script checks is a control.
//
// AND THE CONTROL ONLY WORKS IF SOMETHING RUNS IT. Between 2026-08-11 and
// 2026-09-02 the private account's scope list changed THREE times -- modify
// granted, silently dropped by two re-auths, granted again -- and each entry
// below went on stating the previous measurement as present tense in between.
// A `measuredAt` is a timestamp, not a guarantee; the verifier on a schedule is
// what turns this file from a dated snapshot into a control. Every entry's
// prose must therefore say WHEN it was measured, never just what is true.
//
// WHY GMAIL APPEARS THREE TIMES.
//
// One Google account, three capability surfaces with genuinely different blast
// radius: reading a thread, labelling a message, and sending mail as Istvan.
// They are separate entries because they are separately grantable and separately
// dangerous -- the same reason gmail-label-api.ts was split from
// gmail-api-transport.ts in the first place ("code that only needs to mark a
// message read cannot be handed an object capable of sending one").

import type { Capability } from './execution-identity.js'
import type { SensitivityLevel } from './sensitivity-scale.js'

/**
 * How much damage a mutating call can do, per Istvan's decision §4.
 *
 * ROUTINE is the only class the broker will execute without an approval record.
 * Everything else is default-DENY and needs an explicit capability AND an
 * approval, because these are the categories where a mistaken action cannot be
 * undone by re-running the correct one.
 */
export type RiskClass =
  /** Reversible, low blast radius: label a mail, post a status line. */
  | 'ROUTINE'
  /** Moves or commits money, or creates a payment obligation. */
  | 'FINANCIAL'
  /** Creates, accepts or terminates an agreement on Istvan's behalf. */
  | 'CONTRACTUAL'
  /** Touches credentials, tokens, keys or security configuration. */
  | 'CREDENTIAL_SECURITY'
  /** Deletes or overwrites data that is not trivially reconstructible. */
  | 'DESTRUCTIVE'
  /** Grants, revokes or changes who may do what. */
  | 'ACCESS_CONTROL'

export const RISK_CLASSES: readonly RiskClass[] = [
  'ROUTINE', 'FINANCIAL', 'CONTRACTUAL', 'CREDENTIAL_SECURITY', 'DESTRUCTIVE', 'ACCESS_CONTROL',
]

/** Everything except ROUTINE is high-risk: default DENY, explicit capability,
 *  approval, readback. Expressed as "not ROUTINE" rather than as a second list,
 *  so a risk class added later is high-risk until someone deliberately says
 *  otherwise -- the safe direction to be wrong in. */
export function isHighRisk(r: RiskClass): boolean {
  return r !== 'ROUTINE'
}

export interface ExternalCapabilityEntry {
  /** Stable connector id used by callers and recorded in the audit. */
  id: string
  /** Human-readable: what this reaches. */
  description: string
  /** The provider-side identity/credential this uses. */
  credential: string
  /**
   * True when the GRANTED PROVIDER SCOPE cannot mutate anything. This is the
   * hard outer guard from decision §2; the broker treats it as a ceiling, not
   * as a hint.
   */
  readOnly: boolean
  /** Where the granted scope can be checked, so `readOnly` is falsifiable. */
  scopeEvidence: string
  /** The provider scopes actually granted, as granted -- not as needed.
   *  Measured from the provider, not declared by us. */
  grantedScopes: readonly string[]
  /** The credential files whose scopes this connector rides on. Introspectable
   *  OAuth creds only -- a bot token has no scope endpoint, and pretending it
   *  does would make the verifier report a missing file instead of a known
   *  limitation. */
  credentialFiles: readonly string[]
  /** ISO date of the last measurement. */
  measuredAt: string
  /** Set when the granted scopes do NOT support what this entry claims to do.
   *  Present here rather than fixed silently: a capability the code calls and
   *  the provider refuses is a fact about the system, and hiding it in a commit
   *  message is how it stays broken. */
  scopeGap?: string
  /** Capability a caller must hold to use this connector at all. */
  requiredCapability: Capability
  /** Highest risk class this connector can produce. */
  maxRisk: RiskClass
  /**
   * The most sensitive level this connector may carry OFF the machine.
   *
   * The boundary asks every egress target "are you approved for this level?" and
   * treats an unanswered question as a refusal -- unestablished trust is not
   * trust. This field is the answer, kept HERE rather than at each call site,
   * because a per-call-site answer is a per-call-site opportunity to be
   * generous. Read-only connectors carry nothing out, so theirs is the floor.
   */
  maxLevelOut: SensitivityLevel
  /** Where the call is recorded, so "auditable" is a location and not a hope. */
  auditSurface: string
  /**
   * True when the connector runs OUTSIDE this Node process (an MCP server the
   * agent talks to directly). Recorded because the enforcement story differs:
   * in-process connectors are gated by this broker, out-of-process ones are
   * gated by the credential and must be brokered before any mutating use.
   */
  outOfProcess: boolean
}

/**
 * The inventory.
 *
 * Order is by blast radius, loudest last, so a reader who stops halfway has
 * still seen the harmless ones.
 */
export const EXTERNAL_CAPABILITIES: readonly ExternalCapabilityEntry[] = Object.freeze([
  {
    id: 'gmail.read',
    description: 'Read message and thread bodies from a Google account (triage, thread capture).',
    credential: 'google-private / google-zst OAuth refresh token',
    readOnly: true,
    scopeEvidence: 'oauth2.googleapis.com/tokeninfo, 2026-08-25',
    grantedScopes: ['gmail.readonly'],
    credentialFiles: ['store/.google-private-creds.json', 'store/.google-zst-creds.json'],
    measuredAt: '2026-08-25',
    requiredCapability: 'READ',
    maxRisk: 'ROUTINE',
    maxLevelOut: 'PUBLIC',
    // These reads happen in the AGENT's process, through an MCP server this Node
    // process neither hosts nor proxies -- so nothing here could record them, and
    // until 2026-08-25 nothing did. The fix is the CONNECTOR recording its own
    // calls rather than a gateway in the path of every read: the MCP servers are
    // our own Python, so they append a line per tool call. Timestamp, server,
    // tool, argument KEYS and whether it errored. Never argument values: a query
    // string can carry a person's name, and an audit log that leaks what it
    // audits is a second copy of the data with none of the care.
    auditSurface: 'store/mcp-call-log.jsonl (written by the MCP server itself)',
    outOfProcess: true,
  },
  {
    id: 'gcal.read',
    description: 'List and search calendar events.',
    credential: 'google-private OAuth refresh token',
    readOnly: true,
    scopeEvidence: 'oauth2.googleapis.com/tokeninfo, 2026-08-25',
    grantedScopes: ['calendar.readonly'],
    credentialFiles: ['store/.google-private-creds.json'],
    measuredAt: '2026-08-25',
    requiredCapability: 'READ',
    maxRisk: 'ROUTINE',
    maxLevelOut: 'PUBLIC',
    // These reads happen in the AGENT's process, through an MCP server this Node
    // process neither hosts nor proxies -- so nothing here could record them, and
    // until 2026-08-25 nothing did. The fix is the CONNECTOR recording its own
    // calls rather than a gateway in the path of every read: the MCP servers are
    // our own Python, so they append a line per tool call. Timestamp, server,
    // tool, argument KEYS and whether it errored. Never argument values: a query
    // string can carry a person's name, and an audit log that leaks what it
    // audits is a second copy of the data with none of the care.
    auditSurface: 'store/mcp-call-log.jsonl (written by the MCP server itself)',
    outOfProcess: true,
  },
  {
    id: 'drive.read',
    description: 'Search and read Drive files (CoS source documents).',
    credential: 'google-private / google-zst OAuth refresh token',
    readOnly: true,
    scopeEvidence: 'oauth2.googleapis.com/tokeninfo, 2026-08-25 (both accounts)',
    grantedScopes: ['drive.readonly'],
    credentialFiles: ['store/.google-private-creds.json', 'store/.google-zst-creds.json'],
    measuredAt: '2026-08-25',
    requiredCapability: 'READ',
    maxRisk: 'ROUTINE',
    maxLevelOut: 'PUBLIC',
    // These reads happen in the AGENT's process, through an MCP server this Node
    // process neither hosts nor proxies -- so nothing here could record them, and
    // until 2026-08-25 nothing did. The fix is the CONNECTOR recording its own
    // calls rather than a gateway in the path of every read: the MCP servers are
    // our own Python, so they append a line per tool call. Timestamp, server,
    // tool, argument KEYS and whether it errored. Never argument values: a query
    // string can carry a person's name, and an audit log that leaks what it
    // audits is a second copy of the data with none of the care.
    auditSurface: 'store/mcp-call-log.jsonl (written by the MCP server itself)',
    outOfProcess: true,
  },
  {
    id: 'telegram.cos',
    description: 'Post a CoS case message or owner question to the CoS Telegram channel.',
    credential: 'CoS bot token (0600 file, read at call time)',
    readOnly: false,
    scopeEvidence: 'not read-only: a bot token can always send',
    grantedScopes: ['bot:sendMessage'],
    credentialFiles: [],
    measuredAt: '2026-08-25',
    requiredCapability: 'EXTERNAL_EFFECT',
    maxRisk: 'ROUTINE',
    maxLevelOut: 'CONFIDENTIAL',
    auditSurface: 'cos channel send log + external_action_log',
    outOfProcess: false,
  },
  {
    id: 'telegram.fleet',
    description: 'Post a fleet/notification message to Istvan on the fleet bot.',
    credential: 'fleet bot token',
    readOnly: false,
    scopeEvidence: 'not read-only: a bot token can always send',
    grantedScopes: ['bot:sendMessage'],
    credentialFiles: [],
    measuredAt: '2026-08-25',
    requiredCapability: 'EXTERNAL_EFFECT',
    maxRisk: 'ROUTINE',
    maxLevelOut: 'INTERNAL',
    auditSurface: 'notify log + external_action_log',
    outOfProcess: false,
  },
  {
    id: 'gmail.label',
    description: 'Apply the COS/Processed label to a source message (source-commit).',
    credential: 'google-private OAuth refresh token (gmail.modify)',
    readOnly: false,
    scopeEvidence: 'oauth2.googleapis.com/tokeninfo, 2026-09-02: gmail.modify present on the private account',
    grantedScopes: ['gmail.modify'],
    credentialFiles: ['store/.google-private-creds.json'],
    measuredAt: '2026-09-02',
    // NO scopeGap: the 2026-08-25 gap is CLOSED, and closed is a measurement
    // too. The 08-31 re-auth restored gmail.modify, and on 2026-09-02 the claim
    // was checked at both ends -- tokeninfo says the scope is attached, and
    // three messages this pipeline marked SOURCE_COMMITTED were read back from
    // Gmail with the COS/Processed label actually on them. The second half is
    // the one that matters: a SOURCE_COMMITTED row is this system's own claim
    // about its own write, and a guard that reads back only its own rows can
    // certify a mailbox it never touched.
    requiredCapability: 'EXTERNAL_EFFECT',
    // Labelling is reversible and touches no content, but gmail.modify is a
    // scope that CAN trash a message. The entry is honest about the scope it
    // holds rather than about the one call it makes.
    maxRisk: 'DESTRUCTIVE',
    // INTERNAL, not PUBLIC: what leaves is a message id and a label id, and the
    // destination is the SAME mailbox the id came from. Nothing crosses a trust
    // boundary here -- but a message id is still an identifier for someone's
    // mail, so calling it PUBLIC would be a small lie in the direction that
    // always grows.
    maxLevelOut: 'INTERNAL',
    auditSurface: 'cos source_commit rows + external_action_log',
    outOfProcess: false,
  },
  {
    id: 'gcal.write',
    description: 'Create a calendar event from a confirmed booking.',
    credential: 'google-private OAuth refresh token (calendar.events)',
    readOnly: false,
    scopeEvidence: 'oauth2.googleapis.com/tokeninfo, 2026-08-25: calendar.events present on the private account',
    grantedScopes: ['calendar.events'],
    credentialFiles: ['store/.google-private-creds.json'],
    measuredAt: '2026-08-25',
    requiredCapability: 'EXTERNAL_EFFECT',
    maxRisk: 'ROUTINE',
    maxLevelOut: 'CONFIDENTIAL',
    auditSurface: 'external_action_log (no delete tool exists -- readback is the only undo signal)',
    outOfProcess: true,
  },
  {
    id: 'gmail.send',
    description: 'Send mail as Istvan. The loudest thing this system can do.',
    credential: 'google-private OAuth refresh token (gmail.send)',
    readOnly: false,
    scopeEvidence: 'oauth2.googleapis.com/tokeninfo, 2026-09-02: the private account grants gmail.modify + gmail.readonly + calendar.events + calendar.readonly + drive.readonly. gmail.send is NOT among them.',
    grantedScopes: [],
    credentialFiles: ['store/.google-private-creds.json'],
    measuredAt: '2026-09-02',
    scopeGap:
      'gmail.send is NOT granted on the private account (re-measured 2026-09-02, still absent). That is the credential GmailApiTransport loads by default and the personal COS send path uses, so the personal send is blocked AT THE PROVIDER, whatever this codebase decides -- and this gap is NOT the same shape as the label gap that sat next to it until 2026-09-02. That one was an accident of a re-auth and got fixed by one. This one needs a new browser consent from Istvan, and as of 2026-09-02 he has not been asked to give one, because a send right on the private mailbox is a capability we would not use and a mistake could use expensively. Draft is the terminus on this account by decision, not by oversight. The ZST account does hold gmail.send, which is why the corporate path works.',
    requiredCapability: 'EXTERNAL_EFFECT',
    // A sent mail cannot be recalled, and can create obligations. Everything
    // about this entry is deliberately the strictest in the file.
    maxRisk: 'CONTRACTUAL',
    maxLevelOut: 'CONFIDENTIAL',
    auditSurface: 'cos dispatch gate decision + idempotency marker readback + external_action_log',
    outOfProcess: false,
  },
  {
    id: 'gmail.send.zst',
    description: 'Send corporate mail from the ZST account. The corporate twin of gmail.send.',
    credential: 'google-zst OAuth refresh token (gmail.send)',
    readOnly: false,
    scopeEvidence: 'oauth2.googleapis.com/tokeninfo, 2026-08-25: gmail.send present on the ZST account',
    grantedScopes: ['gmail.send'],
    credentialFiles: ['store/.google-zst-creds.json'],
    measuredAt: '2026-08-25',
    requiredCapability: 'EXTERNAL_EFFECT',
    maxRisk: 'CONTRACTUAL',
    maxLevelOut: 'CONFIDENTIAL',
    auditSurface: 'zst dispatch gate decision + idempotency marker readback + external_action_log',
    outOfProcess: false,
  },
  {
    id: 'gmail.label.zst',
    description: 'Label a processed message in the ZST mailbox (gmail.modify).',
    credential: 'google-zst OAuth refresh token (gmail.modify)',
    readOnly: false,
    scopeEvidence: 'oauth2.googleapis.com/tokeninfo, 2026-08-25: gmail.modify present on the ZST account',
    grantedScopes: ['gmail.modify'],
    credentialFiles: ['store/.google-zst-creds.json'],
    measuredAt: '2026-08-25',
    requiredCapability: 'EXTERNAL_EFFECT',
    maxRisk: 'DESTRUCTIVE',
    maxLevelOut: 'INTERNAL',
    auditSurface: 'cos source_commit rows + external_action_log',
    outOfProcess: false,
  },
  {
    id: 'gcal.write.zst',
    description: 'Create or change events on the ZST calendar.',
    credential: 'google-zst OAuth refresh token (calendar.events)',
    readOnly: false,
    scopeEvidence: 'oauth2.googleapis.com/tokeninfo, 2026-08-25',
    grantedScopes: ['calendar.events'],
    credentialFiles: ['store/.google-zst-creds.json'],
    measuredAt: '2026-08-25',
    requiredCapability: 'EXTERNAL_EFFECT',
    maxRisk: 'ROUTINE',
    maxLevelOut: 'CONFIDENTIAL',
    auditSurface: 'external_action_log',
    outOfProcess: true,
    // GRANTED BUT UNUSED. No code in this repository writes the ZST calendar.
    // Listed anyway, because the inventory's job is to name what the credentials
    // CAN do -- a capability that is held and undocumented is the one nobody
    // thinks to revoke, and it becomes a surprise the day something starts using
    // it. W13's least-privilege work should consider dropping this scope.
    scopeGap: 'granted but no caller: nothing in this repository writes the ZST calendar',
  },
  {
    id: 'sheets.write.zst',
    description: 'Write the Control Tower projection into a Google Sheet.',
    credential: 'google-zst OAuth refresh token (spreadsheets)',
    readOnly: false,
    scopeEvidence: 'oauth2.googleapis.com/tokeninfo, 2026-08-25',
    grantedScopes: ['spreadsheets'],
    credentialFiles: ['store/.google-zst-creds.json'],
    measuredAt: '2026-08-25',
    requiredCapability: 'EXTERNAL_EFFECT',
    // A sheet the owner reads is a report, not an agreement, and it is
    // rewritable. Destructive rather than contractual: a bad write overwrites a
    // projection that can be regenerated from the case store.
    maxRisk: 'DESTRUCTIVE',
    maxLevelOut: 'CONFIDENTIAL',
    auditSurface: 'external_action_log',
    outOfProcess: true,
    scopeGap: 'granted for the Control Tower sheet projection; no in-process caller yet',
  },
  {
    id: 'drive.write.zst',
    description: 'Create or update files this app owns in the ZST Drive (drive.file).',
    credential: 'google-zst OAuth refresh token (drive.file)',
    readOnly: false,
    // drive.file is per-file, not whole-Drive: the narrowest write Google offers
    // here, and worth recording as such so W13 does not "tighten" it to something
    // that is not actually narrower.
    scopeEvidence: 'oauth2.googleapis.com/tokeninfo, 2026-08-25; drive.file is scoped to files this app created',
    grantedScopes: ['drive.file'],
    credentialFiles: ['store/.google-zst-creds.json'],
    measuredAt: '2026-08-25',
    requiredCapability: 'EXTERNAL_EFFECT',
    maxRisk: 'DESTRUCTIVE',
    maxLevelOut: 'CONFIDENTIAL',
    auditSurface: 'external_action_log',
    outOfProcess: true,
    scopeGap: 'granted but no caller: nothing in this repository writes Drive',
  },
  {
    id: 'channel.outbound',
    description:
      'The dashboard channel abstraction: post a message or photo to whichever chat provider is '
      + 'configured (Telegram, Slack, Discord, Google Chat, Teams).',
    credential: 'per-provider bot token from the channel .env',
    readOnly: false,
    scopeEvidence: 'not read-only: a chat bot token can always post',
    grantedScopes: ['bot:postMessage'],
    credentialFiles: [],
    measuredAt: '2026-08-25',
    requiredCapability: 'EXTERNAL_EFFECT',
    maxRisk: 'ROUTINE',
    // ONE entry for five providers, deliberately. The credential differs; the
    // blast radius does not -- each is a bot posting into a chat the owner
    // controls. Five entries saying the same thing would be five places to
    // forget to update. The provider is recorded per call in the audit context,
    // so nothing is lost.
    maxLevelOut: 'INTERNAL',
    auditSurface: 'external_action_log',
    outOfProcess: false,
  },
])

const BY_ID = new Map(EXTERNAL_CAPABILITIES.map(e => [e.id, e]))

/** Unknown connector -> null, and the broker denies. Absence is not permission. */
export function lookupExternalCapability(id: string): ExternalCapabilityEntry | null {
  return BY_ID.get(id) ?? null
}

/** Every connector whose credential is claimed read-only. Used by the audit
 *  report and by the test that asserts none of them is reachable for a write. */
export function readOnlyConnectors(): readonly ExternalCapabilityEntry[] {
  return EXTERNAL_CAPABILITIES.filter(e => e.readOnly)
}

/** Connectors whose granted scopes do not support what the code calls. Empty is
 *  the state we want; non-empty is a live defect list, and the acceptance check
 *  prints it rather than letting it live only in this file. */
export function connectorsWithScopeGaps(): readonly ExternalCapabilityEntry[] {
  return EXTERNAL_CAPABILITIES.filter(e => !!e.scopeGap)
}

/** Every connector that can mutate. These are the ones that MUST be brokered. */
export function mutatingConnectors(): readonly ExternalCapabilityEntry[] {
  return EXTERNAL_CAPABILITIES.filter(e => !e.readOnly)
}
