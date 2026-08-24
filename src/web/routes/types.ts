import type http from 'node:http'

// Shared shape every route handler in this folder consumes. The dispatcher in
// src/web.ts builds it once per request and walks each module's tryHandle*
// function. A handler returns true once it has written a response, false to
// let the next module try.
export interface RouteContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  path: string
  method: string
  url: URL
  /** Federation caller identity, set by the auth gate when a peer's inbound
   *  token authenticated this request. Absent/undefined and null both mean
   *  "not a federation-token caller" (e.g. dashboard token) -- handlers must
   *  treat the two identically. */
  fedPeer?: string | null
  /** Resolved auth principal for this request, set by the gate. Absent means
   *  the request carried no valid credential (only possible on ungated public
   *  paths, which are reached without a principal). `user` is set for the
   *  'session' kind; `peer` mirrors fedPeer for the 'federation' kind;
   *  `device` is the key name for the 'device' kind. Lets routes distinguish
   *  a human session from a token/fleet caller or an enrolled device. */
  auth?: { kind: 'token' | 'session' | 'federation' | 'device'; user?: string; peer?: string; device?: string }
  /**
   * W10: the execution identity for this request, derived from `auth` by the
   * dispatcher via the principal adapter. Null means no credential authenticated
   * the request, which is a resolution FAILURE rather than an empty-scoped
   * identity -- handlers that act on it must fail closed.
   *
   * Present on every RouteContext the dispatcher builds; optional only so that
   * hand-built test contexts keep compiling.
   */
  identity?: import('../../identity/execution-identity.js').ExecutionIdentity | null
}

export type RouteHandler = (ctx: RouteContext) => Promise<boolean>
