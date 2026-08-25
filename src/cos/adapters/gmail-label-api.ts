// The source-commit write: put COS/Processed on a message we have finished with.
//
// GmailLabelCommitter has existed since F-8 and was deliberately never
// instantiated, because the install's token carried gmail.send only and a
// committer wired ahead of its scope "would produce a committer that fails every
// call and a chain that looks broken rather than ungranted". Istvan granted
// gmail.modify on 2026-08-11 and the scope is confirmed by the provider, so the
// wire can be made honestly.
//
// SEPARATE FROM THE SEND TRANSPORT ON PURPOSE. GmailApiTransport is the WRITE
// surface for outbound mail; this is a labelling surface. Keeping them apart
// means code that only needs to mark a message read cannot be handed an object
// capable of sending one — the same reason the thread reader was split out.
//
// Dependency-free: fetch and the refresh token, like the transport.

import { readFileSync } from 'node:fs'
import { brokerExternalAction, STANDING_APPROVALS } from '../../identity/action-broker.js'
import { scheduledIdentityFromEnv } from '../../identity/scheduled-task-identity.js'

interface Creds { client_id: string; client_secret: string; refresh_token: string; token_uri: string }

export interface GmailLabelApiOptions {
  /** W10: WHO is labelling. Defaults to the scheduled identity in the
   *  environment; absent identity is a refusal, not a bypass. */
  identity?: import('../../identity/execution-identity.js').ExecutionIdentity | null
  /** The standing owner grant for source-commit, for the high-risk gate. */
  approval?: import('../../identity/action-broker.js').ApprovalEvidence | null
  credsPath?: string
  /** The label to apply. Must already exist; this class does NOT create labels —
   *  creating one silently would hide a misconfiguration behind a new label
   *  nobody chose. */
  labelName?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class GmailLabelApi {
  private readonly credsPath: string
  private readonly labelName: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly identity: import('../../identity/execution-identity.js').ExecutionIdentity | null
  private readonly approval: import('../../identity/action-broker.js').ApprovalEvidence | null
  private token?: { value: string; expiresAt: number }
  private labelId?: string

  constructor(opts: GmailLabelApiOptions = {}) {
    this.credsPath = opts.credsPath ?? 'store/.google-private-creds.json'
    this.labelName = opts.labelName ?? 'COS/Processed'
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.identity = opts.identity ?? null
    this.approval = opts.approval ?? null
  }

  private creds(): Creds { return JSON.parse(readFileSync(this.credsPath, 'utf8')) as Creds }

  private async accessToken(nowMs: number): Promise<string> {
    if (this.token && this.token.expiresAt > nowMs + 60_000) return this.token.value
    const c = this.creds()
    const body = new URLSearchParams({
      client_id: c.client_id, client_secret: c.client_secret,
      refresh_token: c.refresh_token, grant_type: 'refresh_token',
    })
    const r = await this.fetchImpl(c.token_uri, { method: 'POST', body, signal: AbortSignal.timeout(this.timeoutMs) })
    if (!r.ok) throw new Error(`token refresh failed: ${r.status} ${(await r.text()).slice(0, 200)}`)
    const j = await r.json() as { access_token: string; expires_in?: number }
    this.token = { value: j.access_token, expiresAt: nowMs + (j.expires_in ?? 3600) * 1000 }
    return j.access_token
  }

  /** Resolve the label NAME to its id once. Throws when the label is absent —
   *  see the option comment: a missing label is a configuration fact, not
   *  something to paper over by creating one. */
  private async resolveLabelId(token: string): Promise<string> {
    if (this.labelId) return this.labelId
    const r = await this.fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!r.ok) throw new Error(`label list failed: ${r.status} ${(await r.text()).slice(0, 200)}`)
    const j = await r.json() as { labels?: Array<{ id: string; name: string }> }
    const hit = (j.labels ?? []).find(l => l.name === this.labelName)
    if (!hit) throw new Error(`label not found in this mailbox: ${this.labelName}`)
    this.labelId = hit.id
    return hit.id
  }

  /**
   * Apply the label. Shaped as the callback GmailLabelCommitter expects.
   *
   * W10 (2026-08-25): this is an external WRITE -- a `gmail.modify` call -- so it
   * goes through the broker like every other one. The identity comes from the
   * scheduled environment, because the only caller is the batch-closing cycle
   * step; a hand-run script has no such environment and is refused rather than
   * quietly labelling Istvan's mailbox under nobody's authority.
   *
   * The connector is inventoried as DESTRUCTIVE, not ROUTINE, and that is not a
   * mistake about what this call does. It is honest about the SCOPE it holds:
   * `gmail.modify` can trash a message, and the risk of a credential is the risk
   * of what it permits, not of the one method we happen to call today. High risk
   * therefore requires approval evidence, which the caller supplies as the
   * standing owner grant for source-commit.
   */
  apply = async (_accountId: string, messageId: string): Promise<void> => {
    const brokered = await brokerExternalAction(
      {
        connector: 'gmail.label',
        operation: 'messages.modify',
        mutating: true,
        // Declared to MATCH the inventory ceiling rather than under it. The
        // call itself only adds a label, but it is made with a credential that
        // can trash a message, and the risk of an action is the risk of what the
        // credential permits. Declaring ROUTINE here would have been raised to
        // DESTRUCTIVE anyway, and left a "risk raised" line on every audit row --
        // an alarm that fires on correct behaviour, which is how alarms get muted.
        riskClass: 'DESTRUCTIVE',
        identity: this.identity ?? scheduledIdentityFromEnv(),
        classification: { level: 'INTERNAL', tags: [], basis: 'label id only; no message content leaves' },
        targetId: messageId,
        approval: this.approval ?? STANDING_APPROVALS['gmail.label'] ?? null,
        context: { label: this.labelName },
      },
      async () => {
        const token = await this.accessToken(Date.now())
        const labelId = await this.resolveLabelId(token)
        const r = await this.fetchImpl(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ addLabelIds: [labelId] }),
            signal: AbortSignal.timeout(this.timeoutMs),
          })
        if (!r.ok) {
          throw new Error(`label apply failed for ${messageId}: ${r.status} ${(await r.text()).slice(0, 200)}`)
        }
        return labelId
      },
      {
        surface: 'gmail_label',
        // The label id we asked for, echoed from the call that succeeded. A
        // second GET to confirm would cost a request per message on a path that
        // runs over every processed mail, and Gmail's modify is not partial: it
        // either applied the label or returned an error.
        readback: labelId => `applied ${labelId}`,
      },
    )
    if (brokered.outcome === 'DENIED') {
      throw new Error(`label apply refused by the policy boundary: ${brokered.reasons.join('; ')}`)
    }
    if (brokered.outcome === 'FAILED') throw new Error(brokered.error ?? 'label apply failed')
  }
}
