// Print the canonical runtime model identity AND its raw provenance source.
//
// Istvan, 2026-08-23: "A következő preflight reportban mutasd meg a kanonikus
// értéket és annak nyers provenance-forrását." This is that surface. It asserts
// nothing it cannot show: every line below is either read from /proc or derived
// from what was read, and the raw bytes are printed next to the verdict so the
// two can be compared rather than trusted.
//
// Exit code is the signal: 0 = a canonical identity was proven, 1 = it was not.
// A preflight that treats "unresolved" as a warning has learned nothing.
import { resolveRuntimeModelIdentity, procfsReader } from '../src/cos/model-identity.js'

/** Render a string with control bytes made visible, so an ANSI escape cannot
 *  disguise itself in the very report meant to expose it. */
function visible(s: string): string {
  return JSON.stringify(s).slice(1, -1)
}

const res = resolveRuntimeModelIdentity(process.pid, procfsReader())

const out = {
  resolvedAt: new Date().toISOString(),
  ok: res.ok,
  modelId: res.modelId,
  canonicalBaseModelId: res.model,
  modelVariant: res.modelVariant,
  reason: res.reason,
  detail: res.detail,
  rawValueAsRead: res.raw === null ? null : visible(res.raw),
  rawValueByteLength: res.raw === null ? null : Buffer.byteLength(res.raw, 'utf8'),
  provenanceSource: res.source,
  ancestryWalked: res.walked,
}

console.log(JSON.stringify(out, null, 2))

if (!res.ok) {
  console.error(
    `\nMODEL IDENTITY NOT PROVEN: ${res.reason}\n`
    + `  read from : ${res.source?.path ?? '(nothing was read)'}\n`
    + `  raw value : ${res.raw === null ? '(none)' : visible(res.raw)}\n`
    + `  why       : ${res.detail}\n`
    + '  NOT sanitized, NOT defaulted. Provenance receipts written now would carry\n'
    + '  MODEL_IDENTITY_UNRESOLVED and fail the go-forward gate.',
  )
  process.exit(1)
}
console.error(
  `\nMODEL IDENTITY PROVEN: ${res.modelId}\n`
  + `  base id   : ${res.model}\n`
  + `  variant   : ${res.modelVariant ?? '(none)'}\n`
  + `  read from : ${res.source!.path} (argv[${res.source!.argvIndex}], ${res.source!.form})\n`
  + `  argv[0]   : ${res.source!.argv0}\n`
  + `  exe       : ${res.source!.exe ?? '(unreadable)'}`,
)
