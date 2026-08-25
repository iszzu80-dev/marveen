// W13 closure invariant (Istvan, 2026-08-26):
//
//   "known credential value cannot enter log / prompt / tool trace even when
//    embedded as an otherwise unstructured string. Ezt ne token-prefix
//    felismeréssel oldd meg, hanem provenance/secret-handling boundaryval."
//
// The structural scrubber in log-redaction.ts matches secret-carrying SHAPES (a
// query parameter, a Bearer header). It cannot see a key pasted into the middle
// of a sentence, and no heuristic can — that is the "unknown secret in arbitrary
// prose" case, which is explicitly NOT in scope.
//
// This module covers the case that IS: a value we ourselves loaded from a
// credential source. That is not a guess, it is PROVENANCE. Every value handed
// out by the vault is registered here, and every text that leaves through a
// boundary (a log line, a disclosed prompt field) is checked against the
// registered set by exact substring. No prefix list, no entropy score, no
// "looks like a token" judgement.
//
// WHY A REGISTRY AND NOT AN OPAQUE SECRET TYPE. An opaque wrapper is the
// stronger design and it is the wrong one to introduce here at this size: every
// current consumer takes a plain string (an SDK constructor, an HTTP header, a
// child-process env), so a wrapper would need an `.unwrap()` at each of them,
// and an `.unwrap()` a caller may write is a boundary a caller may forget. The
// registry needs nothing from the consumers and cannot be forgotten by them.
// Its cost is honest and stated below.
//
// WHAT IT COSTS, said plainly:
//   - The values sit in a module-level Set. They are already in this process's
//     memory (the vault decrypted them); this adds a second reference, not a
//     new exposure class.
//   - Matching is exact substring over a handful of values. Cheap, and it
//     scales with the number of credentials, not with traffic.
//   - A secret SHORTER than MIN_LENGTH is not registered, because a 4-character
//     "secret" would redact ordinary words out of every log line in the system.
//     That is a real limit and it is named rather than hidden.

/** Below this length a value is too short to be matched safely against prose. */
const MIN_LENGTH = 8

/**
 * How many values stay under protection at once (Istvan, 2026-08-26: "registry
 * lifecycle nem eredményez kontrollálatlan, végtelen növekedést").
 *
 * The cap is FIFO on registration order, and it is set far above real usage: the
 * vault holds tens of secrets, and a rotation adds one entry each time. At 256 a
 * credential would have to be rotated hundreds of times inside a single process
 * lifetime before the oldest value is evicted — and an evicted value is one that
 * has not been read from a credential source in a very long time.
 *
 * The eviction IS a real loss of protection for that value, which is why it is a
 * cap and not a "keep the last N": a bounded set whose bound is never reached in
 * practice is the honest shape. Nothing here persists across a restart, so the
 * registry starts empty and refills from the accessors on first use.
 */
const MAX_ENTRIES = 256

/** Insertion-ordered. A JS Set preserves insertion order, which is what makes
 *  FIFO eviction a one-liner rather than a second data structure. */
const known = new Set<string>()

export const KNOWN_SECRET_REDACTED = '[REDACTED:KNOWN_SECRET]'

/**
 * Register a value that came from a credential source.
 *
 * Called by the vault accessor, so every consumer of a stored secret registers
 * it without having to know this module exists. Returns whether it was
 * registered, so a caller that cares (a test, a diagnostic) can tell "protected"
 * from "too short to protect".
 */
export function registerKnownSecret(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (v.length < MIN_LENGTH) return false
  // Re-registering an existing value must not move it to the back of the queue
  // and must not grow the set: a secret read on every cycle would otherwise be
  // the newest entry forever, and the eviction order would mean nothing.
  if (known.has(v)) return true
  known.add(v)
  if (known.size > MAX_ENTRIES) {
    // FIFO: drop the oldest registration. Set iteration is insertion order.
    const oldest = known.values().next().value
    if (oldest !== undefined) known.delete(oldest)
  }
  return true
}

/**
 * ROTATION, as a single call: the new value becomes protected and the old value
 * STAYS protected.
 *
 * Istvan's lifecycle requirement (2026-08-26) is precise about this, and it is
 * the part that is easy to get wrong: a rotated-out credential must remain
 * scrubbable, "ha már korábbi process-memoryban vagy hibaszövegben megjelent".
 * A revoked key does not become safe to print — it is still a real credential in
 * a log somebody may read later. So rotation ADDS; it never removes.
 *
 * What DOES stop is the credential's power to act, and that is not this
 * module's job: the vault returns the new value, so every consumer that asks
 * for the secret gets the new one. Nothing here can hand out either.
 */
export function rotateKnownSecret(oldValue: unknown, newValue: unknown): void {
  registerKnownSecret(oldValue)
  registerKnownSecret(newValue)
}

/** For diagnostics and the lifecycle tests: is this exact value protected? */
export function isKnownSecret(value: string): boolean {
  return known.has(value)
}

/** The cap, exported so a test asserts the SHIPPED bound rather than a copy. */
export const KNOWN_SECRET_MAX_ENTRIES = MAX_ENTRIES

/** How many values are under protection. For diagnostics; never the values. */
export function knownSecretCount(): number {
  return known.size
}

/** Test seam only: drop every registration. Never called by production code. */
export function clearKnownSecrets(): void {
  known.clear()
}

/**
 * Replace every registered secret found anywhere in `text`.
 *
 * Exact substring, so it works on the shapes a structural matcher cannot see:
 * `"the key is " + secret`, a template literal, an error message built by an SDK
 * three layers down, a JSON blob serialised by something we do not control.
 *
 * Longest first, so a secret that contains another registered value cannot be
 * partially replaced and leave a fragment behind.
 */
export function scrubKnownSecrets(text: string): string {
  if (!known.size || !text) return text
  let out = text
  for (const secret of [...known].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join(KNOWN_SECRET_REDACTED)
  }
  return out
}

/** True when the text still carries a registered secret. The assertion form,
 *  for guards that must refuse rather than rewrite. */
export function containsKnownSecret(text: string): boolean {
  if (!known.size || !text) return false
  for (const secret of known) if (text.includes(secret)) return true
  return false
}
