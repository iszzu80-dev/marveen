// A PARENT ROUTE NOBODY CALLS.
//
// The reply/reference resolver was written, tested a hundred times over, merged,
// and was one command away from release — with no production caller.
// `ingestEmailWithReferences` existed; every real email reached `ingestEmail`
// instead, through the triage bridge. The suite was green throughout, because
// every test called the wrapper that the live path did not.
//
// The scope-closure guard surfaced it, and only sideways: it complained about an
// undeclared import edge, and the edge led to a module the live path never
// reached. Nothing in the suite was asking the question directly.
//
// So these ask it directly. Two of them are deliberately static: the claim is
// not "the resolver works" (proven in cos-reply-reference and cos-intake-resolve)
// but "the live path uses it" — a claim about CALLSITES, which no behavioural
// test of the resolver can make.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase, getDb } from '../db.js'
import { recordTriageReceipt } from '../cos/triage-provenance.js'
import { createCase } from '../cos/case-store.js'
import { linkCaseSource, findCasesForSource } from '../cos/case-sources.js'
import { ingestTriagedEmail, type TriagedEmail } from '../cos/triage-bridge.js'
import { liveIntakeMailboxes, INTAKE_MAILBOX_CREDENTIALS } from '../cos/intake-mailboxes.js'
import { resolveReferencesForIntake } from '../cos/intake-resolve.js'

const ROUTE = 'src/web/routes/cos.ts'
const ACC = 'iszzu80', NOW = 1_000_000
const PARENT_MSG = 'AM0P193MB3123X@outlook.com'
const PARENT_THREAD = 'thread-parent'
const NEW_THREAD = 'thread-fresh'

function dossier(caseId: string, thread = PARENT_THREAD): void {
  createCase(getDb(), { caseId, title: caseId, caseType: 'HOME_REPAIR', status: 'READY' } as any, NOW)
  linkCaseSource(getDb(), {
    namespace: 'personal', caseId, sourceType: 'GMAIL_THREAD', sourceRef: thread,
    linkMethod: 'EXPLICIT_RELATION', evidence: 'fixture', discoveredBy: 'test',
  }, NOW)
}

function triaged(messageId: string, over: Partial<TriagedEmail> = {}): TriagedEmail {
  // No openBatch here, unlike the intake-level tests: the BRIDGE's idempotency
  // check reads email_processing, so pre-discovering the message would return
  // ALREADY_PROCESSED before any of this is exercised. The bridge opens its own
  // per-email batch.
  recordTriageReceipt(getDb(), {
    accountId: ACC, messageId, threadId: NEW_THREAD, sourceManifestHash: null,
    actionable: true, caseType: 'HOME_REPAIR', title: 'valasz', workspace: null,
    priority: null, declaredSensitivity: null, actor: 'test', model: null, promptFingerprint: null,
  } as any, NOW)
  return {
    accountId: ACC, messageId, threadId: NEW_THREAD,
    subject: 'Re: peremelem', from: 'vendor@example.com', snippet: 'valasz',
    actionable: true, caseType: 'HOME_REPAIR', title: 'valasz', direction: 'INBOUND',
    triageActor: 'test', headers: { 'In-Reply-To': `<${PARENT_MSG}>` },
    ...over,
  } as TriagedEmail
}

describe('the live intake path actually asks what a message replies to', () => {
  it('HEADLINE: the intake route resolves references AND hands the answer to the bridge', () => {
    // Both halves are load-bearing. Resolving and then not passing the answer on
    // is the same live-inert outcome with more code in it.
    // Line comments only. A block-comment stripper run over this file eats
    // far more than its comments (a regex literal is enough to confuse it) and
    // left a body so short the check passed on absence. Prose lives on `//`
    // lines here, which is the false positive that actually needs excluding.
    const body = readFileSync(join(process.cwd(), ROUTE), 'utf8').replace(/^\s*\/\/.*$/gm, '')
    expect(body, 'the route must resolve references').toContain('resolveReferencesForIntake(')
    expect(body, 'the route must supply real mailboxes').toContain('liveIntakeMailboxes()')
    expect(body, 'the resolution must reach the bridge').toMatch(
      /ingestTriagedEmail\(\s*getDb\(\)\s*,\s*\{\s*\.\.\.input\s*,\s*referenceResolution\s*\}/,
    )
  })

  it('the route imports both, so the check above is not matching a comment', () => {
    // The header of this very file names the functions it is looking for. A
    // check whose own explanation would satisfy it is not a check.
    const src = readFileSync(join(process.cwd(), ROUTE), 'utf8')
    expect(src).toMatch(/import \{ resolveReferencesForIntake \} from '\.\.\/\.\.\/cos\/intake-resolve\.js'/)
    expect(src).toMatch(/import \{ liveIntakeMailboxes \} from '\.\.\/\.\.\/cos\/intake-mailboxes\.js'/)
  })
})

describe('the bridge forwards the resolution rather than merely accepting it', () => {
  beforeEach(() => { initDatabase(':memory:'); dossier('PRI-HOME-2026-005') })

  it('HEADLINE: a resolved parent wins, and the new conversation joins that dossier', () => {
    // A field the bridge takes and drops type-checks perfectly, which is why
    // this is behavioural and not a signature assertion.
    const res = ingestTriagedEmail(getDb(), triaged('m-fwd', {
      referenceResolution: {
        kind: 'RESOLVED', caseId: 'PRI-HOME-2026-005',
        viaMessageId: PARENT_MSG, viaThreadId: PARENT_THREAD, viaMailbox: 'private',
      },
    }), NOW)

    expect(res.caseId).toBe('PRI-HOME-2026-005')
    expect(findCasesForSource(getDb(), 'personal', 'GMAIL_THREAD', NEW_THREAD)
      .map((c) => c.caseId)).toContain('PRI-HOME-2026-005')
  })

  it('MUTATION FLOOR: the identical email WITHOUT the resolution does not join it', () => {
    // If this ever passes alongside the headline, the forwarding is not what
    // produced the headline's result and the headline proves nothing.
    const res = ingestTriagedEmail(getDb(), triaged('m-nofwd'), NOW)
    expect(res.caseId).not.toBe('PRI-HOME-2026-005')
  })
})

describe('the mailboxes the live path hands the resolver', () => {
  it('HEADLINE: both accounts are offered, so the lookup is cross-mailbox', () => {
    // Istvan answers from whichever account is open, so a reply to a private
    // thread routinely arrives on the ZST one. A single-mailbox resolver would
    // answer "no parent" for precisely the replies this feature exists for.
    expect(INTAKE_MAILBOX_CREDENTIALS.map((c) => c.id).sort()).toEqual(['private', 'zst'])
  })

  it('an account with no credential file is skipped, not offered as a silent no', () => {
    // The filter lives in the factory rather than in the reader because the
    // reader only opens the file when first asked something — so an
    // unconfigured account would look like a reachable mailbox that answered
    // "no such message", and "asked and found nothing" is the one answer this
    // resolver must never confuse with "could not ask".
    const dir = mkdtempSync(join(tmpdir(), 'mbx-'))
    const present = join(dir, 'present.json')
    writeFileSync(present, '{}')
    const boxes = liveIntakeMailboxes([
      { id: 'present', credsPath: present },
      { id: 'absent', credsPath: join(dir, 'nope.json') },
    ])
    expect(boxes.map((b) => b.id)).toEqual(['present'])
  })

  it('the declared credential paths are the ones the rest of the system uses', () => {
    // A mailbox list that points at paths nobody else writes would degrade to
    // an empty list forever, silently, and every intake would look parentless.
    expect(INTAKE_MAILBOX_CREDENTIALS.map((c) => c.credsPath).sort()).toEqual([
      'store/.google-private-creds.json', 'store/.google-zst-creds.json',
    ])
  })
})

describe('the round-trip is spent only when the answer is unknown', () => {
  beforeEach(() => { initDatabase(':memory:'); dossier('PRI-HOME-2026-005') })

  it('HEADLINE: a thread an open case already claims asks no mailbox', async () => {
    const lookup = vi.fn(async () => null)
    const r = await resolveReferencesForIntake(
      getDb(),
      { threadId: PARENT_THREAD, headers: { 'In-Reply-To': `<${PARENT_MSG}>` } },
      [{ id: 'private', lookup }],
    )
    expect(lookup).not.toHaveBeenCalled()
    expect(r).toBeUndefined()
  })

  it('an unknown thread DOES ask, or the check above proves nothing', async () => {
    const lookup = vi.fn(async () => null)
    await resolveReferencesForIntake(
      getDb(),
      { threadId: NEW_THREAD, headers: { 'In-Reply-To': `<${PARENT_MSG}>` } },
      [{ id: 'private', lookup }],
    )
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('an unreachable mailbox costs the parent route and nothing else', async () => {
    const r = await resolveReferencesForIntake(
      getDb(),
      { threadId: NEW_THREAD, headers: { 'In-Reply-To': `<${PARENT_MSG}>` } },
      [{ id: 'private', lookup: async () => { throw new Error('token refresh failed: 401') } }],
    )
    expect(r).toBeUndefined()
  })
})
