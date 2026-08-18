// Dependency-free on purpose: the READ-ONLY snapshot exporter imports this, and
// that tool's whole promise is that it has no path to a production write. Pulling
// the extractor graph (schema initializer, extractors, gate) into it to reach one
// pure string function would spend that promise on nothing.

/** Normalise a case row's stored source reference into the ONE production input
 *  message id, or null.
 *
 *  The column is `source_references` (plural) and it holds a bare message id
 *  today, but the name says list and other writers may yet make it one. A
 *  singular guess here fails in the quietest possible way: the exporter emits
 *  NULL for every case, every parity target comes back
 *  RETRIAGE_INPUT_NOT_EQUIVALENT, and the run looks careful rather than blind.
 *  More than one reference is not an input either — it is an ambiguity, and this
 *  returns null rather than picking one. */
export function normaliseSourceReference(raw: unknown): string | null {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s) as unknown
      if (Array.isArray(parsed) && parsed.length === 1 && parsed[0] != null) return String(parsed[0])
      return null
    } catch { return null }
  }
  return s
}
