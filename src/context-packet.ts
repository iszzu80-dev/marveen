// Lean Optimization Phase 2 / P2-B -- Fleet Context Packet (format + validator).
//
// A Context Packet is the standard body of a fleet work-package dispatch. Its
// whole point is to stop the dominant fresh-input waste on this fleet: pasting a
// full audit / spec / log / prior artifact into a dispatch when the receiving
// agent can read it from disk. Large material is therefore carried by
// REFERENCE -- path + commit-or-version + content hash + a short relevant
// excerpt -- never re-inlined.
//
// Scope discipline (program constraints):
//  - MEASUREMENT / FORMAT ONLY. No model is ever invoked from this module: it
//    imports nothing but node:crypto and the zero-dependency execution-role
//    vocabulary leaf (WP4 -- see below). Packet sizing and validation are
//    deterministic string/rule operations. There is no LLM, no network, no fs.
//  - The ~3000-token figure is a TARGET, not a cap. A complex task MAY exceed it
//    when it says why (`complexityJustification`). There is deliberately NO
//    cumulative cap of any kind in this module -- in particular no 12000-token
//    cumulative cap; capping cumulative context would degrade correctness on
//    exactly the tasks that need context most. Enforced by a test.
//  - estimateFreshTokens() returns an ESTIMATE and says so. It can never return
//    a 'measured' confidence, because nothing here measures a real tokenizer.
//
// DATA SENSITIVITY (hard): a packet carries paths, commits, hashes and short
// excerpts. `dataSensitivity` is an EXPLICIT required field so every dispatch
// declares its class instead of leaving it implicit. validateContextPacket also
// runs a deterministic credential-shape scan and REJECTS a packet that looks
// like it carries a secret; it is a backstop, not a licence to paste secrets.
//
// Upstream-friendliness: this module is dependency-free apart from node:crypto
// and src/execution-role.ts (which itself imports nothing), so the packet shape
// is still an upstream candidate. Concrete thresholds live in deployment-local
// config (see src/web/session-efficiency-store.ts).

// APG 1.9 WP4 (§12.1) added three things to this module and nothing else:
//  - `executionRole` on the packet (§12.1-e), from the ONE role vocabulary
//    (src/execution-role.ts, shared with the dispatch row's §11.2 role);
//  - packet IDENTITY -- packetHash + packetId -- derived from the RENDERED
//    packet by the same hashContent() a reference already uses for artifacts;
//  - `generatedAt` as an argument of the identity, never a packet field.
// The last two are one decision seen from both sides; see packetIdentity().

import { createHash } from 'node:crypto'
import { asExecutionRole, type ExecutionRole } from './execution-role.js'

export type { ExecutionRole }

// ---- limits (format rules, NOT a context cap) ------------------------------

/** Longest excerpt a single referenced artifact may carry. Anything past this
 *  is re-inlining the document instead of pointing at it. */
export const MAX_EXCERPT_CHARS = 1200

/** Longest a free-text packet section body may be. A section this long is a
 *  pasted document, which is precisely what the packet format exists to stop. */
export const MAX_SECTION_CHARS = 2000

/** Longest an ArtifactRef.note may be (OPT-M7, review 2026-08-12: the note was
 *  the one unbounded, fully-rendered string in the format -- a whole document
 *  could ride it validly, defeating every cap above). A DEDICATED limit rather
 *  than MAX_SECTION_CHARS because the section cap is disproportionate here:
 *  2000 chars per reference would let a note out-carry the excerpt cap (1200)
 *  it sits next to, inverting the discipline -- the note explains WHY an
 *  artifact is referenced and what to look for, a sentence or two, while the
 *  excerpt is the field that carries quoted content. 500 keeps the note
 *  clearly subordinate to the excerpt. */
export const MAX_NOTE_CHARS = 500

/** An excerpt may not be (nearly) the whole artifact. */
export const MAX_EXCERPT_FRACTION_OF_ARTIFACT = 0.5

/** Floor for the fraction rule above. Quoting a genuinely tiny artifact (a short
 *  config block, a two-line snippet) in full is not the waste this rule targets,
 *  and a fraction test on a 20-byte file would be noise. Deliberately well BELOW
 *  MAX_EXCERPT_CHARS: an artifact can be under the excerpt char limit and still
 *  be re-inlined wholesale, which the char limit alone would never catch. */
export const MIN_ARTIFACT_BYTES_FOR_INLINE_CHECK = 400

/** Soft TARGET for a normal packet's fresh input tokens. NOT a cap: exceeding
 *  it produces a warning, and no warning at all when the packet documents why
 *  (`complexityJustification`). Nothing in this codebase refuses a packet for
 *  being large, and there is no cumulative budget. */
export const TARGET_FRESH_TOKENS = 3000

// ---- domain types ----------------------------------------------------------

export type TaskSize = 'small' | 'normal' | 'large'

/** Coarse class of the context budget a packet expects to consume. Advisory
 *  metadata for measurement; it gates nothing on its own. */
export type ContextBudgetClass = 'minimal' | 'standard' | 'extended'

/** Declared sensitivity class of the material a packet touches. Explicit by
 *  design -- `internal` is the norm for fleet work, `restricted` says the task
 *  touches material that must not be echoed, quoted or forwarded. */
export type DataSensitivity = 'public' | 'internal' | 'restricted'

/** A large piece of material carried by reference. */
export interface ArtifactRef {
  /** Repo-relative or absolute path. Never file CONTENT. */
  path: string
  /** Commit sha, tag, or version string that pins WHICH revision is meant. */
  ref: string
  /** sha256 (hex, optionally 'sha256:'-prefixed) of the full referenced content. */
  contentHash: string
  /** Size of the FULL artifact in bytes, when known. Used to prove an excerpt
   *  is an excerpt and not the whole document. */
  bytes?: number | null
  /** Short, relevant excerpt (<= MAX_EXCERPT_CHARS). Optional. */
  excerpt?: string | null
  /** Why this artifact is referenced / what to look for in it. A sentence or
   *  two (<= MAX_NOTE_CHARS) -- content belongs in `excerpt`, never here. */
  note?: string | null
}

export interface ContextPacketInput {
  /** Packet format version. Defaults to CONTEXT_PACKET_VERSION. */
  packetVersion?: string
  /**
   * §12.1-e: WHICH ROLE the receiving execution is being dispatched in.
   *
   * The 1.8 conformance audit called this "the single field that would make
   * §12.2/§12.3 expressible", and the reason is that both sections are rules
   * about what a packet may carry: a producer packet MAY hold implementation
   * history and design context (§12.2), a verifier packet may NOT hold the
   * producer's session history (§12.3). Without the role on the packet there
   * is nothing to apply either rule to -- the two packets are the same object
   * and no reader can tell which set of rules it is under.
   *
   * Same closed vocabulary as the dispatch row's §11.2 role (one definition,
   * src/execution-role.ts), and decided by the ORIGIN like that one is: the
   * packet is built server-side, so a receiving agent cannot promote itself
   * from producer to verifier by rewriting a field it was handed.
   *
   * Optional, and absent means absent: a packet built by an origin that has no
   * role model stores null rather than a guessed 'producer'.
   */
  executionRole?: ExecutionRole | null
  /** What the receiving agent must achieve. Required, short. */
  goal: string
  /** Large material, by reference only. */
  references?: ArtifactRef[]
  /** Short constraint bullets (hard rules, gates, non-goals). */
  constraints?: string[]
  /** Explicit sensitivity declaration. Required. */
  dataSensitivity: DataSensitivity
  /** Extra sensitivity notes (e.g. "no customer names in the report"). */
  dataSensitivityNotes?: string[]
  /** Acceptance bullets. Required, at least one. */
  doneWhen: string[]
  /** Originating kanban card, when there is one. */
  cardId?: string | null
  /** Declared task size, when the origin knows it. NEVER inferred by a model. */
  taskSize?: TaskSize | null
  /** Declared context budget class. */
  contextBudgetClass?: ContextBudgetClass | null
  /** Why this packet legitimately exceeds TARGET_FRESH_TOKENS, if it does. */
  complexityJustification?: string | null
}

export interface ContextPacket extends ContextPacketInput {
  packetVersion: string
  executionRole: ExecutionRole | null
  references: ArtifactRef[]
  constraints: string[]
  dataSensitivityNotes: string[]
}

export const CONTEXT_PACKET_VERSION = 'p2b-1'

// ---- builder ---------------------------------------------------------------

/**
 * Normalize a packet input into a complete packet. Pure and deterministic: no
 * clock, no fs, no network, no model. Trims strings and drops empty bullets so
 * a rendered packet has no filler.
 */
export function buildContextPacket(input: ContextPacketInput): ContextPacket {
  const bullets = (xs: string[] | undefined): string[] =>
    (xs ?? []).map(s => String(s).trim()).filter(s => s.length > 0)
  return {
    ...input,
    packetVersion: (input.packetVersion ?? CONTEXT_PACKET_VERSION).trim(),
    // Narrowed, never passed through: an unrecognised role becomes null, the
    // same discipline createDispatch() applies to the role column. A packet
    // rendering `executionRole: verifer` would be read by a human as a
    // verifier packet and by every rule as nothing.
    executionRole: asExecutionRole(input.executionRole),
    goal: String(input.goal ?? '').trim(),
    references: (input.references ?? []).map(normalizeRef),
    constraints: bullets(input.constraints),
    dataSensitivity: input.dataSensitivity,
    dataSensitivityNotes: bullets(input.dataSensitivityNotes),
    doneWhen: bullets(input.doneWhen),
    cardId: input.cardId ?? null,
    taskSize: input.taskSize ?? null,
    contextBudgetClass: input.contextBudgetClass ?? null,
    complexityJustification: (input.complexityJustification ?? null)?.trim() || null,
  }
}

function normalizeRef(r: ArtifactRef): ArtifactRef {
  const excerpt = (r.excerpt ?? null)
  return {
    path: String(r.path ?? '').trim(),
    ref: String(r.ref ?? '').trim(),
    contentHash: String(r.contentHash ?? '').trim(),
    bytes: typeof r.bytes === 'number' && Number.isFinite(r.bytes) ? Math.floor(r.bytes) : null,
    excerpt: excerpt == null ? null : String(excerpt).replace(/\s+$/g, ''),
    note: (r.note ?? null) || null,
  }
}

/** sha256 hex of a string -- the content hash a reference pins. */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

/**
 * Build an ArtifactRef from content the CALLER already has in memory, so the
 * hash and the `bytes` size are derived from the real content rather than
 * asserted. The excerpt is truncated to MAX_EXCERPT_CHARS -- referencing a big
 * document can therefore never accidentally inline it.
 */
export function artifactRefFromContent(
  path: string,
  ref: string,
  content: string,
  opts: { excerpt?: string | null; note?: string | null } = {},
): ArtifactRef {
  const excerpt = opts.excerpt == null ? null : truncateExcerpt(opts.excerpt)
  return normalizeRef({
    path,
    ref,
    contentHash: hashContent(content),
    bytes: Buffer.byteLength(content, 'utf-8'),
    excerpt,
    note: opts.note ?? null,
  })
}

/** Cut an excerpt down to the format limit (marking the cut, so a reader knows
 *  the excerpt is partial and must open the referenced path). */
export function truncateExcerpt(text: string, max: number = MAX_EXCERPT_CHARS): string {
  const t = String(text)
  if (t.length <= max) return t
  return t.slice(0, max - 4).replace(/\s+$/g, '') + ' ...'
}

// ---- rendering -------------------------------------------------------------

/**
 * Render a packet to the fleet's five-section markdown shape:
 * Goal / Canonical references / Relevant constraints / Data sensitivity / Done when.
 * Deterministic: same packet in, byte-identical text out (asserted by a test
 * against the committed example).
 */
export function renderContextPacket(p: ContextPacket): string {
  const out: string[] = []
  out.push(`# Context Packet${p.cardId ? ` -- card ${p.cardId}` : ''}`)
  out.push('')
  const head: string[] = [`packetVersion: ${p.packetVersion}`]
  // §12.1-e. Rendered rather than kept as out-of-band metadata: the receiving
  // agent has to be able to READ which role it was dispatched in -- a verifier
  // that believes it is the producer will helpfully fix what it was asked to
  // judge -- and being in the rendered body is also what puts the role inside
  // packetHash(), so a re-labelled packet is a different packet.
  if (p.executionRole) head.push(`executionRole: ${p.executionRole}`)
  if (p.taskSize) head.push(`taskSize: ${p.taskSize}`)
  if (p.contextBudgetClass) head.push(`contextBudgetClass: ${p.contextBudgetClass}`)
  out.push(`> ${head.join(' | ')}`)
  out.push('')

  out.push('## Goal')
  out.push(p.goal)
  out.push('')

  out.push('## Canonical references')
  if (p.references.length === 0) {
    out.push('(none)')
  } else {
    for (const r of p.references) {
      const size = r.bytes != null ? `, ${r.bytes} bytes` : ''
      out.push(`- \`${r.path}\` @ ${r.ref} (sha256 ${shortHash(r.contentHash)}${size})`)
      if (r.note) out.push(`  - ${r.note}`)
      if (r.excerpt) {
        out.push('  - excerpt:')
        for (const line of r.excerpt.split('\n')) out.push(`    > ${line}`)
      }
    }
  }
  out.push('')

  out.push('## Relevant constraints')
  if (p.constraints.length === 0) out.push('(none)')
  else for (const c of p.constraints) out.push(`- ${c}`)
  out.push('')

  out.push('## Data sensitivity')
  out.push(`- class: ${p.dataSensitivity}`)
  for (const n of p.dataSensitivityNotes) out.push(`- ${n}`)
  out.push('')

  out.push('## Done when')
  for (const d of p.doneWhen) out.push(`- ${d}`)

  if (p.complexityJustification) {
    out.push('')
    out.push('## Size justification')
    out.push(p.complexityJustification)
  }
  out.push('')
  return out.join('\n')
}

function shortHash(h: string): string {
  const hex = h.replace(/^sha256:/i, '')
  return hex.slice(0, 12)
}

// ---- packet identity (§12.1: packet_id, packet_hash, generated_at) ---------

/** Prefix of a derived packet id, so an id is recognisable on sight and can
 *  never be confused with a dispatch uuid or a bare sha256. */
export const PACKET_ID_PREFIX = 'pkt-'

/** Length of the hash prefix a packet id carries. Same 32 hex chars the
 *  kernel's execution_id_for() keeps, for the same reason: long enough that a
 *  collision is not a thing anyone has to reason about, short enough to appear
 *  in a log line and a card comment. */
export const PACKET_ID_HASH_CHARS = 32

/**
 * §12.1's three identity fields for one packet.
 *
 * `generatedAt` is here rather than on the packet itself, and it is the caller's
 * string (this module has no clock, by the same rule the whole file follows).
 */
export interface PacketIdentity {
  packetId: string
  /** sha256 hex of the RENDERED packet. No 'sha256:' prefix, lowercase. */
  packetHash: string
  /** Caller-supplied ISO timestamp, or null when the origin recorded none. */
  generatedAt: string | null
}

/**
 * sha256 of the rendered packet -- §12.1's `packet_hash`.
 *
 * WHY THE RENDERED FORM AND NOT THE OBJECT. The rendered packet is what the
 * agent actually receives; hashing a JSON serialisation would hash a shape
 * nobody is ever handed, and would change when a field was reordered without
 * the delivered context changing at all. renderContextPacket() is already
 * asserted deterministic (byte-identical output for identical input), which is
 * the only property a content hash needs.
 *
 * This is the function that unblocks the kernel's `context_packet_hash`: WP3's
 * execution_identity.py stores CONTEXT_PACKET_HASH_UNKNOWN for every identity
 * it mints, with the recorded reason "the context packet is WP4, and today only
 * its metadata is stored; no packet body is hashed". This hashes the body.
 */
export function hashPacket(p: ContextPacket): string {
  return hashContent(renderContextPacket(p))
}

/**
 * The packet's identity: a content-derived id, the hash, and the caller's
 * generation timestamp.
 *
 * THE ONE DESIGN DECISION WORTH READING. `generatedAt` is deliberately NOT part
 * of the hash and NOT part of the id, so two dispatches of byte-identical
 * context share a packet_id. The alternative -- stirring a clock into the
 * digest -- would make packet_hash useless as the thing it exists to be: the
 * join key by which an execution identity, a receipt and a re-dispatch can be
 * shown to have run against THE SAME context. It would also make the hash
 * untestable for the only property that matters (stable for identical content,
 * different for different content) and would quietly make every replay of a
 * recorded dispatch look like new context.
 *
 * The id is derived, not chosen: like the kernel's execution_id, there is no
 * parameter through which a caller can pick one, so a packet's identity is a
 * fact about its content rather than a label someone attached to it.
 */
export function packetIdentity(p: ContextPacket, generatedAt?: string | null): PacketIdentity {
  const packetHash = hashPacket(p)
  return {
    packetId: `${PACKET_ID_PREFIX}${packetHash.slice(0, PACKET_ID_HASH_CHARS)}`,
    packetHash,
    generatedAt: (generatedAt ?? null) || null,
  }
}

// ---- fresh-token estimate (ESTIMATE, never 'measured') ---------------------

export type EstimateConfidence = 'estimated'

export interface FreshTokenEstimate {
  tokens: number
  /** Always 'estimated'. This module has no tokenizer, so it must never claim
   *  a measured number. The DB column that stores this is NOT NULL, so a
   *  persisted estimate can never lose its marker. */
  confidence: EstimateConfidence
  /** Human-readable description of HOW the number was produced. */
  method: string
}

/** Characters per token used by the estimator. ~4 chars/token is the standard
 *  rough English/code ratio; it is a heuristic and labelled as one. */
export const CHARS_PER_TOKEN_ESTIMATE = 4

/**
 * Deterministic fresh-input-token ESTIMATE for a rendered packet. No tokenizer,
 * no model call: ceil(chars / 4). Reported with confidence 'estimated' and the
 * method string, so no consumer can mistake it for a measurement.
 */
export function estimateFreshTokens(text: string): FreshTokenEstimate {
  const chars = String(text ?? '').length
  return {
    tokens: Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE),
    confidence: 'estimated',
    method: `chars/${CHARS_PER_TOKEN_ESTIMATE} heuristic on the rendered packet (no tokenizer)`,
  }
}

/** Convenience: render + estimate in one step. */
export function estimatePacketFreshTokens(p: ContextPacket): FreshTokenEstimate {
  return estimateFreshTokens(renderContextPacket(p))
}

// ---- validation ------------------------------------------------------------

export type PacketIssueCode =
  | 'goal_missing'
  | 'done_when_missing'
  | 'data_sensitivity_missing'
  | 'reference_path_missing'
  | 'reference_ref_missing'
  | 'reference_hash_invalid'
  // OPT-M7. Prefixed 'reference_' ON PURPOSE: session-checkpoint.ts's
  // delegated validator forwards packet errors whose code starts with
  // 'reference_' (plus two named codes), so this spelling makes checkpoints
  // inherit the note cap through the existing filter with no second
  // implementation and no drift.
  | 'reference_note_too_long'
  | 'excerpt_too_long'
  | 'artifact_inlined'
  | 'section_inlined'
  | 'possible_secret'
  | 'over_target_tokens'

export interface PacketIssue {
  code: PacketIssueCode
  message: string
  /** Where the issue is (section name or `references[i].field`). */
  at: string
}

export interface PacketValidation {
  ok: boolean
  errors: PacketIssue[]
  warnings: PacketIssue[]
  estimate: FreshTokenEstimate
}

const HASH_RE = /^(sha256:)?[0-9a-f]{64}$/i

// Deterministic credential SHAPES. Not a promise of completeness -- a backstop
// so an obvious pasted secret cannot ride a packet. No value is ever logged.
const SECRET_SHAPES: Array<{ rx: RegExp; what: string }> = [
  { rx: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'PEM private key block' },
  { rx: /\bsk-[A-Za-z0-9_-]{16,}/, what: 'provider API key (sk-...)' },
  { rx: /\bAKIA[0-9A-Z]{12,}/, what: 'AWS access key id' },
  { rx: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s@/]+@/i, what: 'database URL with an inline password' },
  { rx: /\bBearer\s+[A-Za-z0-9._-]{20,}/, what: 'bearer token' },
  { rx: /\bgh[pousr]_[A-Za-z0-9]{20,}/, what: 'GitHub token' },
  { rx: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, what: 'Slack token' },
]

/**
 * Names of the credential shapes found in `text` (empty when none). Exported so
 * the checkpoint validator uses the SAME scan -- one implementation, so the two
 * artifact types can never drift on what counts as a secret. Returns only the
 * SHAPE NAME, never the matched value, so no caller can log a credential.
 */
export function findSecretShapes(text: string): string[] {
  const s = String(text ?? '')
  return SECRET_SHAPES.filter(shape => shape.rx.test(s)).map(shape => shape.what)
}

/**
 * Validate a packet against the format rules. Deterministic, no model.
 *
 * ERRORS (packet is not valid):
 *  - a required section is missing (goal / doneWhen / dataSensitivity)
 *  - a reference is not a real reference (no path, no pinned ref, no sha256)
 *  - an excerpt is longer than MAX_EXCERPT_CHARS, a note is longer than
 *    MAX_NOTE_CHARS, or excerpt + note together are (nearly) the whole
 *    artifact -- i.e. the document was re-inlined under an excerpt/note label
 *  - a free-text section body is longer than MAX_SECTION_CHARS -- i.e. a
 *    document was pasted into the packet instead of referenced
 *  - the packet carries something shaped like a credential
 *
 * WARNING (packet is still valid):
 *  - the estimate is over TARGET_FRESH_TOKENS and the packet gives no
 *    justification. This is a target, NOT a cap, and there is no cumulative
 *    budget anywhere.
 */
export function validateContextPacket(p: ContextPacket): PacketValidation {
  const errors: PacketIssue[] = []
  const warnings: PacketIssue[] = []
  const err = (code: PacketIssueCode, at: string, message: string) => errors.push({ code, at, message })

  if (!p.goal || p.goal.trim().length === 0) err('goal_missing', 'Goal', 'Goal is required')
  if (!p.doneWhen || p.doneWhen.length === 0) err('done_when_missing', 'Done when', 'At least one Done-when bullet is required')
  if (p.dataSensitivity !== 'public' && p.dataSensitivity !== 'internal' && p.dataSensitivity !== 'restricted') {
    err('data_sensitivity_missing', 'Data sensitivity', 'dataSensitivity must be explicitly public|internal|restricted')
  }

  p.references.forEach((r, i) => {
    if (!r.path) err('reference_path_missing', `references[${i}].path`, 'A reference must carry a path')
    if (!r.ref) err('reference_ref_missing', `references[${i}].ref`, 'A reference must pin a commit/tag/version')
    if (!HASH_RE.test(r.contentHash ?? '')) {
      err('reference_hash_invalid', `references[${i}].contentHash`, 'A reference must carry a sha256 content hash of the full artifact')
    }
    const ex = r.excerpt ?? ''
    if (ex.length > MAX_EXCERPT_CHARS) {
      err('excerpt_too_long', `references[${i}].excerpt`,
        `Excerpt is ${ex.length} chars (limit ${MAX_EXCERPT_CHARS}) -- reference the path, do not re-inline the document`)
    }
    // OPT-M7 (review 2026-08-12): the note is rendered in full, so an
    // unbounded note was a valid side door around every cap above -- a whole
    // document could be pasted into it and the packet still validated.
    const note = r.note ?? ''
    if (note.length > MAX_NOTE_CHARS) {
      err('reference_note_too_long', `references[${i}].note`,
        `Note is ${note.length} chars (limit ${MAX_NOTE_CHARS}) -- a note says why the artifact is referenced; quoted content belongs in the excerpt, large material behind the path`)
    }
    // The reference-not-inline rule: an "excerpt" that is most of a large
    // artifact is the full document wearing an excerpt label. The note counts
    // toward the same fraction (OPT-M7): both strings are rendered verbatim
    // under this reference, so splitting a document across excerpt + note must
    // not evade the check either field would trip alone.
    if (r.bytes != null && r.bytes >= MIN_ARTIFACT_BYTES_FOR_INLINE_CHECK
      && (ex.length + note.length) >= r.bytes * MAX_EXCERPT_FRACTION_OF_ARTIFACT) {
      err('artifact_inlined', `references[${i}].excerpt`,
        `Excerpt + note are ${ex.length + note.length} of ${r.bytes} artifact bytes -- that is the document inlined, not an excerpt`)
    }
  })

  // Free-text sections. A packet body this long is a pasted document.
  for (const [at, body] of freeTextSections(p)) {
    if (body.length > MAX_SECTION_CHARS) {
      err('section_inlined', at,
        `Section body is ${body.length} chars (limit ${MAX_SECTION_CHARS}) -- carry large material by path+commit+hash+excerpt instead of inlining it`)
    }
  }

  // Credential-shape scan over everything the packet would actually send.
  const rendered = renderContextPacket(p)
  for (const what of findSecretShapes(rendered)) {
    err('possible_secret', 'packet', `Packet appears to contain a ${what}; packets carry paths and hashes only`)
  }

  const estimate = estimateFreshTokens(rendered)
  if (estimate.tokens > TARGET_FRESH_TOKENS && !p.complexityJustification) {
    warnings.push({
      code: 'over_target_tokens',
      at: 'packet',
      message: `Estimated ${estimate.tokens} fresh tokens, over the ~${TARGET_FRESH_TOKENS} target. This is a TARGET, not a cap -- document why in complexityJustification to silence this.`,
    })
  }

  return { ok: errors.length === 0, errors, warnings, estimate }
}

// ---- packet metadata (derivation; persistence is costops/packet-metadata.ts) --

/**
 * The optional metadata a dispatch may carry about its packet. Paths, pinned
 * refs and hashes ONLY -- no prompt text, no excerpt, no PII, no secret. That
 * is why `referencedArtifacts` holds `path@ref` strings and never content.
 */
export interface PacketMetadata {
  packetVersion: string
  /** §12.1 packet_id -- content-derived (see packetIdentity). */
  packetId: string
  /** §12.1 packet_hash -- sha256 hex of the rendered packet. */
  packetHash: string
  /** §12.1 generated_at -- the ORIGIN's ISO timestamp, or null. Null means
   *  "this origin recorded no generation time", never "now". */
  generatedAt: string | null
  /** §12.1-e execution_role, carried alongside the hash so a stored packet
   *  record can be compared with the dispatch row's §11.2 role. */
  executionRole: ExecutionRole | null
  /** `path@ref` per referenced artifact, index-aligned with contentHashes. */
  referencedArtifacts: string[]
  /** sha256 hex per referenced artifact, index-aligned with referencedArtifacts. */
  contentHashes: string[]
  estimatedFreshTokens: number
  /** Confidence marker, persisted as free-text TEXT NOT NULL (see
   *  costops/packet-metadata.ts). Always literally 'estimated' when produced by
   *  derivePacketMetadata() below -- the number is a heuristic and must never be
   *  presented as measured -- but the field itself is a provenance string, not
   *  a closed enum: other recorders may stamp a different non-empty marker
   *  (e.g. the method name) and the KPI layer surfaces whatever was actually
   *  stored rather than assuming the literal. */
  estimateConfidence: EstimateConfidence | string
  estimateMethod: string
  taskSize: TaskSize | null
  contextBudgetClass: ContextBudgetClass | null
}

/**
 * Derive packet metadata from a packet. Pure and deterministic. The estimate is
 * produced by estimateFreshTokens(), so the confidence marker travels with the
 * number by construction -- there is no way to build PacketMetadata carrying a
 * bare unmarked token count.
 */
export function derivePacketMetadata(p: ContextPacket, generatedAt?: string | null): PacketMetadata {
  const estimate = estimatePacketFreshTokens(p)
  const identity = packetIdentity(p, generatedAt)
  return {
    packetVersion: p.packetVersion,
    packetId: identity.packetId,
    packetHash: identity.packetHash,
    generatedAt: identity.generatedAt,
    executionRole: p.executionRole ?? null,
    referencedArtifacts: p.references.map(r => `${r.path}@${r.ref}`),
    contentHashes: p.references.map(r => r.contentHash.replace(/^sha256:/i, '').toLowerCase()),
    estimatedFreshTokens: estimate.tokens,
    estimateConfidence: estimate.confidence,
    estimateMethod: estimate.method,
    taskSize: p.taskSize ?? null,
    contextBudgetClass: p.contextBudgetClass ?? null,
  }
}

/** The packet's free-text bodies, keyed by section, for the inline check. */
function freeTextSections(p: ContextPacket): Array<[string, string]> {
  return [
    ['Goal', p.goal ?? ''],
    ['Relevant constraints', (p.constraints ?? []).join('\n')],
    ['Data sensitivity', (p.dataSensitivityNotes ?? []).join('\n')],
    ['Done when', (p.doneWhen ?? []).join('\n')],
    ['Size justification', p.complexityJustification ?? ''],
  ]
}
