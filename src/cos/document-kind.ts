// Attachment docKind classification — the NORMATIVE reader.
//
// Stage 2H-D (Istvan, 2026-08-18). This rule used to live in exactly one place:
// a few chained ternaries inside `scripts/cos-attachment-ingest.py`. The
// TypeScript side never classified anything; it received `docKind` as a finished
// value. So a replay that wanted to compare docKind had three bad options —
// copy the rule (a third implementation, guaranteed to drift), skip the field,
// or call it unreplayable.
//
// The rule now lives in `document-kind-rules.json` and BOTH sides read it. The
// literals appear once. A regression test asserts that neither reader restates
// them, so a future copy goes red instead of quietly disagreeing.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface DocumentKindRule {
  kind: string
  filenameContains?: string[]
  filenameEndsWith?: string[]
}
export interface DocumentKindRuleset {
  version: number
  rules: DocumentKindRule[]
  fallback: string
}

let cached: DocumentKindRuleset | null = null

export function documentKindRulesPath(): string {
  return fileURLToPath(new URL('./document-kind-rules.json', import.meta.url))
}

export function loadDocumentKindRules(): DocumentKindRuleset {
  if (cached) return cached
  const parsed = JSON.parse(readFileSync(documentKindRulesPath(), 'utf8')) as DocumentKindRuleset
  if (!Array.isArray(parsed.rules) || typeof parsed.fallback !== 'string') {
    throw new Error('document-kind-rules.json is malformed: rules[] and fallback are required')
  }
  cached = parsed
  return parsed
}

/** Classify an attachment filename. Behaviour-preserving with the pre-2026-08-18
 *  Python ternary chain: lowercase compare, first matching rule wins, `other`
 *  when nothing matches. An empty/absent filename falls through to the fallback
 *  rather than throwing — the ingest path has always tolerated one. */
export function classifyDocumentKind(filename: string | null | undefined): string {
  const name = (filename ?? '').toLowerCase()
  const { rules, fallback } = loadDocumentKindRules()
  for (const rule of rules) {
    if (rule.filenameContains?.some(k => name.includes(k))) return rule.kind
    if (rule.filenameEndsWith?.some(k => name.endsWith(k))) return rule.kind
  }
  return fallback
}
