// The canonical outbound email payload and the two hashes an approval binds to.
//
// Extracted 2026-08-13. `EmailDraft`, `renderedPayloadHash` and
// `templateHashFor` existed twice — send-flow.ts (personal) and zst-send.ts
// (corporate) — as byte-identical copies. That is the most dangerous shape of
// duplication this codebase has: the hash is what an approval is bound to, so a
// change on one side does not break anything visibly, it just makes every stored
// approval on the OTHER side stop matching. The failure surfaces as "the gate
// refuses everything", which reads like a gate working.
//
// Pure functions, no DB, no I/O — importable from either namespace.

import { sha256Hex } from './attachments.js'

export interface EmailDraft {
  to: string; subject: string; body: string
  /** RFC Message-ID this mail answers. Included in the rendered payload hash,
   *  so approving a reply approves that it IS a reply: changing the threading
   *  after approval invalidates the approval, like changing the text does. */
  inReplyTo?: string
  references?: string
}

/** Deterministic hash of the EXACT rendered payload — what the owner approves and
 *  what the send gate re-checks. Any edit changes it → a stale approval no longer
 *  authorizes. */
export function renderedPayloadHash(email: EmailDraft): string {
  // inReplyTo is part of what is approved. "Reply to this thread" and "start a
  // new conversation" are different acts with different consequences in the
  // recipient's mailbox, so flipping one into the other after approval must
  // invalidate the approval exactly like editing the text does.
  //
  // JSON.stringify drops undefined keys, so a non-reply hashes byte-identically
  // to what it did before this field existed — no stored approval is disturbed.
  return sha256Hex(JSON.stringify({
    to: email.to, subject: email.subject, body: email.body,
    inReplyTo: email.inReplyTo, references: email.references,
  }))
}

/** Hash identifying the typed template a send is built from (free text is never
 *  autonomously sendable — authorizeSend rejects a free-text campaign). */
export function templateHashFor(templateId: string): string {
  return sha256Hex(`template:${templateId}`)
}
