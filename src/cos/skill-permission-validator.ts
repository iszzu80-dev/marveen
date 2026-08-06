// Personal Chief of Staff (COS) — skill permission validator (spec §F / gap-
// matrix #7: the stricter Skill Factory gate).
//
// A self-generated or loaded skill may declare the capabilities it needs in its
// frontmatter (`permissions: [ ... ]`). This validator gates that declaration:
//   - a SENSITIVE capability (send email, touch credentials, shell, delete,
//     payment, browser checkout) requires an explicit `sensitive_approved: true`
//     in the frontmatter — otherwise it is rejected;
//   - an UNKNOWN capability is rejected fail-closed (we do not silently allow
//     something we cannot reason about);
//   - benign known capabilities pass.
// Pure over the parsed metadata, so it is unit-testable and can gate skill
// generation before a skill is ever written/run.

/** Capabilities that are safe to grant without explicit approval. */
export const BENIGN_CAPABILITIES: ReadonlySet<string> = new Set([
  'read-email', 'read-calendar', 'read-drive', 'read-file', 'web-search',
  'db-read', 'memory-read', 'memory-write', 'kanban-read', 'kanban-write',
  'bus-message', 'daily-log',
])

/** Capabilities that can cause external / irreversible effects — require explicit
 *  `sensitive_approved: true`. */
export const SENSITIVE_CAPABILITIES: ReadonlySet<string> = new Set([
  'send-email', 'send-message-external', 'credential-access', 'shell-exec',
  'file-delete', 'network-write', 'payment', 'browser-checkout', 'calendar-write',
])

export interface SkillMeta {
  name?: string
  permissions?: string[]
  sensitiveApproved?: boolean
}

export type ViolationKind = 'UNKNOWN_CAPABILITY' | 'UNAPPROVED_SENSITIVE'
export interface Violation { capability: string; kind: ViolationKind; reason: string }
export interface ValidationResult { ok: boolean; violations: Violation[] }

/** Validate a skill's declared permissions against the policy. A skill with no
 *  declared permissions is trivially OK (it claims nothing). */
export function validateSkillPermissions(meta: SkillMeta): ValidationResult {
  const violations: Violation[] = []
  for (const raw of meta.permissions ?? []) {
    const cap = raw.trim()
    if (!cap) continue
    if (SENSITIVE_CAPABILITIES.has(cap)) {
      if (!meta.sensitiveApproved) {
        violations.push({ capability: cap, kind: 'UNAPPROVED_SENSITIVE', reason: `sensitive capability '${cap}' requires sensitive_approved: true` })
      }
    } else if (!BENIGN_CAPABILITIES.has(cap)) {
      violations.push({ capability: cap, kind: 'UNKNOWN_CAPABILITY', reason: `unknown capability '${cap}' (fail-closed: not on the benign allowlist)` })
    }
  }
  return { ok: violations.length === 0, violations }
}

/**
 * Parse a SKILL.md's frontmatter into SkillMeta. Handles the simple `key: value`
 * frontmatter the skills use, plus `permissions:` as an inline `[a, b]` list or a
 * YAML block list (`- a` lines). No external YAML dep. Returns {} if there is no
 * frontmatter block.
 */
export function parseSkillFrontmatter(md: string): SkillMeta {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(md)
  if (!m) return {}
  const lines = m[1].split('\n')
  const meta: SkillMeta = {}
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]
    const val = kv[2].trim()
    if (key === 'name') meta.name = val
    else if (key === 'sensitive_approved') meta.sensitiveApproved = /^(true|yes)$/i.test(val)
    else if (key === 'permissions') {
      if (val.startsWith('[')) {
        meta.permissions = val.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      } else {
        // YAML block list on following `- item` lines
        const perms: string[] = []
        for (let j = i + 1; j < lines.length; j++) {
          const item = /^\s*-\s*(.+)$/.exec(lines[j])
          if (!item) break
          perms.push(item[1].trim().replace(/^["']|["']$/g, ''))
        }
        meta.permissions = perms
      }
    }
  }
  return meta
}

/** Convenience: parse + validate a raw SKILL.md string. */
export function validateSkillMd(md: string): ValidationResult {
  return validateSkillPermissions(parseSkillFrontmatter(md))
}
