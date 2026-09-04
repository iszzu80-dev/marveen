// REPLY/REFERENCE RESOLUTION — how a message finds its case when its thread is
// unknown to us.
//
// THE GAP THIS CLOSES, measured rather than supposed. Until now `findActiveCaseByThread`
// was the only route from an incoming message to a case, and it asks exactly one
// question: do we already know this THREAD. That question has no answer for a
// conversation the provider decided to file separately — and providers do decide
// that. On 2026-09-03 a reply from a supplier arrived on a thread nothing had
// seen, so it opened its own case beside PRI-HOME-2026-005, which already held
// the same matter. On 2026-09-04 our own outgoing reply did the same thing in
// the other direction. Two incidents, one missing question.
//
// The missing question is the one every mail client answers instinctively:
// WHAT IS THIS A REPLY TO. RFC 5322 puts it in the message itself —
// `In-Reply-To` names the parent, `References` names the ancestry — and those
// are identifiers, not similarities. If a referenced id belongs to a message on
// a thread we already attribute to a case, then this message belongs to that
// case, and saying so is reading a fact rather than making a guess.
//
// THIS IS DELIBERATELY NOT A SIMILARITY MATCHER. Nothing here looks at subject
// lines, participants or timing. A resolution either follows a stored reply
// relation or it does not happen, which is why the link it justifies is
// CANONICAL and not a candidate. The semantic case — a related conversation
// with no reply relation at all — is a different feature with a different
// output, and it must stay different.

/** RFC 5322 msg-id list, in the order a resolver should try them.
 *
 *  `In-Reply-To` first: it names the direct parent, so it is the strongest
 *  claim in the message. Then `References` from the END backwards, because that
 *  header is oldest-first and the nearest ancestor is the most likely to be a
 *  conversation we already track. Duplicates are dropped, keeping the first
 *  (strongest) occurrence.
 *
 *  Angle brackets are stripped: they are envelope syntax, and every consumer
 *  here (Gmail's `rfc822msgid:`, a stored id column) wants the bare value. */
export function referencedMessageIds(headers: {
  inReplyTo?: string | null
  references?: string | null
}): string[] {
  const bare = (s: string) => s.trim().replace(/^</, '').replace(/>$/, '').trim()
  const fromList = (v: string | null | undefined) =>
    (v ?? '').split(/\s+/).map(bare).filter(Boolean)

  const parent = fromList(headers.inReplyTo)
  const ancestry = fromList(headers.references).reverse()

  const seen = new Set<string>()
  const out: string[] = []
  for (const id of [...parent, ...ancestry]) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** Looks up which conversation a message id lives in, in ONE mailbox.
 *
 *  Returns null when the mailbox does not have it — which is not an error and
 *  must not be treated as one: the parent may live in another mailbox, or may
 *  have been deleted. Throwing is reserved for "we could not ask".
 */
export type ThreadLookup = (messageId: string) => Promise<string | null>

/** Where the answer came from. Shared by both outcomes so an ambiguous result
 *  is exactly as auditable as a resolved one. */
export interface ReplyReferenceEvidence {
  /** The referenced message that carried the answer — the evidence. */
  viaMessageId: string
  /** The conversation that message lives in. */
  viaThreadId: string
  /** Which mailbox answered. Present so a cross-mailbox resolution is legible
   *  afterwards rather than looking like a same-mailbox one. */
  viaMailbox: string
}

/**
 * RESOLVED: exactly one open case claims the referenced conversation.
 *
 * One claimant is what makes this canonical. The reply relation says WHICH
 * conversation, and a single claimant says which case that conversation is —
 * two facts, no judgement in between.
 */
export interface ReplyReferenceResolved extends ReplyReferenceEvidence {
  kind: 'RESOLVED'
  caseId: string
}

/**
 * AMBIGUOUS: several open cases claim the referenced conversation.
 *
 * Owner ruling 2026-09-04: "Ambiguous parent/multi-case relation eseten
 * canonical auto-link NEM mehet; candidate/ambiguity legyen."
 *
 * There IS a tie-break available — the most recently updated case — and the
 * thread-id path already uses it to route live mail. It must not be reused
 * here, and the difference is worth stating: routing a message to the liveliest
 * of several claimants is a delivery decision that the next message can
 * correct, while writing a CANONICAL source link is a durable claim that this
 * message BELONGS to that case. Six threads in the live store are claimed by
 * more than one case, so this is not hypothetical.
 *
 * The caller records candidates and lets a human decide. Silence would be
 * worse than either: an ambiguity nobody is told about is resolved by whoever
 * reads the board first, using no rule at all.
 */
export interface ReplyReferenceAmbiguous extends ReplyReferenceEvidence {
  kind: 'AMBIGUOUS'
  /** Every open case claiming the conversation, in the order the store gave
   *  them. No ranking: ranking here would be the tie-break by another name. */
  caseIds: string[]
}

export type ReplyReferenceResolution = ReplyReferenceResolved | ReplyReferenceAmbiguous

/**
 * Find the case a message belongs to by following what it replies to.
 *
 * Mailboxes are tried in the order given, and the FIRST is expected to be the
 * message's own. Cross-mailbox is not a special mode: a reply relation is a
 * fact about messages, not about accounts, and a conversation that moved from a
 * private address to a company one is still the same conversation. What the
 * order buys is that the cheap, likely answer is asked for first.
 *
 * A lookup that throws is swallowed PER MAILBOX and the search continues. The
 * reason is asymmetric cost: an unavailable mailbox that aborts the whole
 * resolution turns a transient error into a permanently orphaned case, while
 * carrying on merely risks not finding a link that a later run can still find.
 */
export async function resolveCaseByReplyReference(
  headers: { inReplyTo?: string | null; references?: string | null },
  mailboxes: ReadonlyArray<{ id: string; lookup: ThreadLookup }>,
  /** Every OPEN case claiming this conversation. Returning all of them rather
   *  than a best one is the whole point: the ambiguity has to survive the
   *  lookup in order to be reportable. */
  findCasesByThread: (threadId: string) => string[],
): Promise<ReplyReferenceResolution | null> {
  for (const messageId of referencedMessageIds(headers)) {
    for (const mailbox of mailboxes) {
      let threadId: string | null = null
      try {
        threadId = await mailbox.lookup(messageId)
      } catch {
        continue // could not ask this mailbox; another may still answer
      }
      if (!threadId) continue
      const caseIds = findCasesByThread(threadId)
      const evidence = { viaMessageId: messageId, viaThreadId: threadId, viaMailbox: mailbox.id }
      if (caseIds.length === 1) return { kind: 'RESOLVED', caseId: caseIds[0], ...evidence }
      if (caseIds.length > 1) return { kind: 'AMBIGUOUS', caseIds, ...evidence }
      // zero claimants: this conversation is not ours to attribute — keep looking
      // further up the ancestry rather than stopping at the first known thread.
    }
  }
  return null
}
