// WHICH mailboxes the intake is allowed to ask when a message names a parent.
//
// Cross-mailbox is the point, not a bonus. Istvan writes from both addresses and
// answers from whichever is open, so a reply to a private thread routinely
// arrives on the ZST account and the other way round. A resolver that only ever
// asked the receiving account would answer "no parent" for exactly the cases the
// feature exists to catch.
//
// Read-only by construction: these are GmailThreadReader instances, which have
// no send surface at all. The intake gets an object that can look and cannot
// act, and that is a property of the type rather than a rule someone follows.

import { existsSync } from 'node:fs'
import { GmailThreadReader } from './gmail-thread-read.js'
import type { Mailbox } from './intake-resolve.js'

export interface MailboxCredential {
  /** Recorded verbatim in the link evidence, so a resolution can be traced back
   *  to the account that answered it. */
  id: string
  credsPath: string
}

/** The accounts this machine holds credentials for. */
export const INTAKE_MAILBOX_CREDENTIALS: readonly MailboxCredential[] = [
  { id: 'private', credsPath: 'store/.google-private-creds.json' },
  { id: 'zst', credsPath: 'store/.google-zst-creds.json' },
] as const

/**
 * Readers for every account whose credentials are actually present.
 *
 * A missing credential file is skipped rather than thrown on. The alternative
 * is worse in a specific way: the resolver runs on the intake path, and an
 * intake that refuses to ingest because one of two mailboxes is unconfigured
 * drops real mail to protect a lookup that is optional by design.
 *
 * `existsSync` is checked here rather than left to the reader because the reader
 * only opens the file when it is first asked something. Without this the absent
 * account would look like a reachable mailbox that answered "no such message" —
 * and "asked and found nothing" is the one answer this resolver must not
 * confuse with "could not ask".
 */
export function liveIntakeMailboxes(
  creds: readonly MailboxCredential[] = INTAKE_MAILBOX_CREDENTIALS,
): Mailbox[] {
  return creds
    .filter((c) => existsSync(c.credsPath))
    .map((c) => {
      const reader = new GmailThreadReader({ credsPath: c.credsPath })
      return { id: c.id, lookup: (messageId: string) => reader.lookupThreadByMessageId(messageId) }
    })
}
