import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  credentialStorePath, readJsonStore,
  type CredentialStoreFailureKind, isCredentialStoreUnreadable,
} from './credential-store.js'
import { readFileOr, AGENTS_BASE_DIR, listAgentNames } from './agent-config.js'
import { getSecret, listSecrets } from './vault.js'
import { getExternalProjectPaths } from './dashboard-settings.js'
import { shellEscape } from './sanitize.js'
import { logger } from '../logger.js'

// Resolved per call — see credential-store.ts. The old module-level constant is
// what made every vitest worker share one bindings file.
const BINDINGS_PATH = () => credentialStorePath('vault-bindings.json')
const VAULT_WRAPPER_PATH = join(PROJECT_ROOT, 'scripts', 'vault-env-wrapper.sh')
const VAULT_HEADERS_HELPER_PATH = join(PROJECT_ROOT, 'scripts', 'vault-headers-helper.sh')

export interface VaultBindingTarget {
  mcpFilePath: string
  serverName: string
}

export interface VaultBinding {
  vaultSecretId: string
  envVar: string
  targets: VaultBindingTarget[]
  // When set, this is a REMOTE-server header binding rather than an env binding.
  // The secret is injected into request headers at connection time via the
  // headersHelper script -- the plaintext token never lands in .mcp.json.
  headerName?: string
  // Auth scheme prefix for the header value, e.g. "Bearer" -> "Bearer <secret>".
  // Empty/undefined means the raw secret is used as the header value.
  headerScheme?: string
}

interface BindingsStore {
  bindings: VaultBinding[]
}

const SENSITIVE_PATTERNS = [
  /_KEY$/i, /_TOKEN$/i, /_SECRET$/i, /_PASSWORD$/i, /_PASS$/i,
  /^API_/i, /^AUTH_/i, /^OAUTH_/i,
  /PASSWORD/i, /CREDENTIAL/i, /ACCESS_KEY/i,
]

const NON_SENSITIVE_VALUE_PATTERNS = [
  /^(true|false)$/i,
  /^https?:\/\//,
  /^\d+$/,
  /^\//,
  /^\$\{/,
]

export interface ScanFinding {
  mcpFilePath: string
  serverName: string
  envVar: string
  maskedValue: string
  suggestedVaultId: string
  alreadyInVault: boolean
  existingVaultId?: string
}

export interface SyncStoreFailure {
  kind: CredentialStoreFailureKind
  path: string
  message: string
}

export interface SyncResult {
  /** COMPLETED means the bindings store was read and every target attempted.
   *  STORE_UNREADABLE means nothing was attempted at all — `updated: 0` here is
   *  "we do not know", never "there was nothing to do". */
  outcome: 'COMPLETED' | 'STORE_UNREADABLE'
  updated: number
  errors: string[]
  failure?: SyncStoreFailure
}

function isBindingsStore(parsed: unknown): parsed is BindingsStore {
  return !!parsed && typeof parsed === 'object' && Array.isArray((parsed as BindingsStore).bindings)
}

/**
 * A missing bindings file is the specified initial state: no binding has ever
 * been made, and an empty list is the honest answer. Every OTHER failure --
 * corrupt JSON, a wrong shape, EACCES, an unexpected IO error -- throws a typed
 * CredentialStoreUnreadable.
 *
 * Before this, all four collapsed into `{ bindings: [] }`. Downstream that read
 * as "this secret is bound to nothing", and syncSecret returned
 * `{ updated: 0, errors: [] }` -- a shape no caller can tell apart from a
 * successful no-op. On a credential path the operator would have been told the
 * sync was fine while the .mcp.json still carried whatever it carried before.
 */
function readBindings(): BindingsStore {
  return readJsonStore<BindingsStore>(BINDINGS_PATH(), { bindings: [] }, isBindingsStore)
}

/** Turn a thrown store failure into the typed FAILED SyncResult. Rethrows
 *  anything that is NOT a store-read failure: a bug in here must not be dressed
 *  up as an IO problem. */
function syncStoreFailure(err: unknown): SyncResult {
  if (!isCredentialStoreUnreadable(err)) throw err
  return {
    outcome: 'STORE_UNREADABLE',
    updated: 0,
    // Non-empty on purpose: a caller that only ever looks at `errors` (every
    // pre-existing one does) must still see this as a failure.
    errors: [`Binding store unreadable (${err.kind}): ${err.message}`],
    failure: { kind: err.kind, path: err.path, message: err.message },
  }
}

function writeBindings(store: BindingsStore): void {
  atomicWriteFileSync(BINDINGS_PATH(), JSON.stringify(store, null, 2) + '\n')
}

export function getBindings(): VaultBinding[] {
  return readBindings().bindings
}

export function addBinding(binding: VaultBinding): void {
  const store = readBindings()
  const idx = store.bindings.findIndex(
    b => b.vaultSecretId === binding.vaultSecretId && b.envVar === binding.envVar,
  )
  if (idx >= 0) {
    store.bindings[idx] = binding
  } else {
    store.bindings.push(binding)
  }
  writeBindings(store)
}

export function removeBinding(vaultSecretId: string, envVar: string): boolean {
  const store = readBindings()
  const before = store.bindings.length
  store.bindings = store.bindings.filter(
    b => !(b.vaultSecretId === vaultSecretId && b.envVar === envVar),
  )
  if (store.bindings.length === before) return false
  writeBindings(store)
  return true
}

export function removeBindingsForSecret(vaultSecretId: string): void {
  const store = readBindings()
  const toRemove = store.bindings.filter(b => b.vaultSecretId === vaultSecretId)
  const remaining = store.bindings.filter(b => b.vaultSecretId !== vaultSecretId)
  for (const binding of toRemove) {
    for (const target of binding.targets) {
      try {
        const content = JSON.parse(readFileOr(target.mcpFilePath, '{}'))
        const serverCfg = content.mcpServers?.[target.serverName]
        if (!serverCfg) continue
        if (binding.headerName) {
          // Rebuild the server's headersHelper from the header bindings that
          // survive this secret's removal.
          applyHeadersHelper(
            serverCfg,
            headerBindingsForServer(target.mcpFilePath, target.serverName, remaining),
          )
        } else {
          if (!serverCfg.env) continue
          delete serverCfg.env[binding.envVar]
          if (!serverHasVaultRefs(serverCfg.env)) unwrapCommand(serverCfg)
        }
        atomicWriteFileSync(target.mcpFilePath, JSON.stringify(content, null, 2))
      } catch { /* skip */ }
    }
  }
  store.bindings = remaining
  writeBindings(store)
}

export function collectAllMcpFilePaths(): Array<{ path: string, label: string }> {
  const paths: Array<{ path: string, label: string }> = []
  const projectMcp = join(PROJECT_ROOT, '.mcp.json')
  if (existsSync(projectMcp)) paths.push({ path: projectMcp, label: 'project' })
  const userMcp = join(homedir(), '.claude.json')
  if (existsSync(userMcp)) paths.push({ path: userMcp, label: 'user' })

  for (const agentName of listAgentNames()) {
    const agentMcp = join(AGENTS_BASE_DIR, agentName, '.mcp.json')
    if (existsSync(agentMcp)) paths.push({ path: agentMcp, label: `agent:${agentName}` })
    const projectsDir = join(AGENTS_BASE_DIR, agentName, 'projects')
    if (existsSync(projectsDir)) {
      try {
        for (const proj of readdirSync(projectsDir)) {
          if (!statSync(join(projectsDir, proj)).isDirectory()) continue
          const projMcp = join(projectsDir, proj, '.mcp.json')
          if (existsSync(projMcp)) paths.push({ path: projMcp, label: `project:${agentName}/${proj}` })
        }
      } catch { /* ignore */ }
    }
  }
  for (const extPath of getExternalProjectPaths()) {
    const extMcp = join(extPath, '.mcp.json')
    if (existsSync(extMcp)) paths.push({ path: extMcp, label: `external:${basename(extPath)}` })
  }
  return paths
}

function maskValue(val: string): string {
  if (val.length <= 6) return '***'
  return val.slice(0, 3) + '...' + val.slice(-3)
}

function looksLikeSensitiveValue(val: string): boolean {
  if (!val || val.length < 8) return false
  if (val.startsWith('vault:')) return false
  for (const p of NON_SENSITIVE_VALUE_PATTERNS) {
    if (p.test(val)) return false
  }
  return true
}

function looksLikeSensitiveKey(key: string): boolean {
  return SENSITIVE_PATTERNS.some(p => p.test(key))
}

export function scanMcpConfigs(): ScanFinding[] {
  const findings: ScanFinding[] = []
  const mcpFiles = collectAllMcpFilePaths()
  const existingSecrets = listSecrets()

  const vaultValues = new Map<string, string>()
  for (const s of existingSecrets) {
    const val = getSecret(s.id)
    if (val) vaultValues.set(val, s.id)
  }

  for (const { path: mcpPath } of mcpFiles) {
    try {
      const parsed = JSON.parse(readFileOr(mcpPath, '{}'))
      const servers = parsed.mcpServers || {}
      for (const [serverName, cfg] of Object.entries(servers) as Array<[string, any]>) {
        const env = cfg?.env || {}
        for (const [envVar, envVal] of Object.entries(env) as Array<[string, string]>) {
          if (!looksLikeSensitiveKey(envVar)) continue
          if (!looksLikeSensitiveValue(String(envVal))) continue

          const existingVaultId = vaultValues.get(String(envVal))
          findings.push({
            mcpFilePath: mcpPath,
            serverName,
            envVar,
            maskedValue: maskValue(String(envVal)),
            suggestedVaultId: `${serverName}-${envVar}`,
            alreadyInVault: !!existingVaultId,
            existingVaultId,
          })
        }
      }
    } catch { /* skip unreadable files */ }
  }
  return findings
}

function wrapCommand(serverCfg: any): void {
  if (serverCfg.command === VAULT_WRAPPER_PATH) return
  serverCfg._vaultOriginalCommand = serverCfg.command
  if (serverCfg.args?.length) serverCfg._vaultOriginalArgs = serverCfg.args
  serverCfg.args = [serverCfg.command, ...(serverCfg.args || [])]
  serverCfg.command = VAULT_WRAPPER_PATH
}

function unwrapCommand(serverCfg: any): void {
  if (serverCfg.command !== VAULT_WRAPPER_PATH) return
  if (!serverCfg._vaultOriginalCommand) return
  serverCfg.command = serverCfg._vaultOriginalCommand
  serverCfg.args = serverCfg._vaultOriginalArgs || []
  delete serverCfg._vaultOriginalCommand
  delete serverCfg._vaultOriginalArgs
}

function serverHasVaultRefs(env: Record<string, string> | undefined): boolean {
  if (!env) return false
  return Object.values(env).some(v => typeof v === 'string' && v.startsWith('vault:'))
}

// All header bindings (across every secret) that target one server in one file.
// The headersHelper for a server must carry EVERY header the vault manages for
// it, so syncing one secret must not drop another secret's header.
function headerBindingsForServer(
  mcpFilePath: string,
  serverName: string,
  all: VaultBinding[] = getBindings(),
): VaultBinding[] {
  return all.filter(
    b => b.headerName && b.targets.some(t => t.mcpFilePath === mcpFilePath && t.serverName === serverName),
  )
}

// Rebuild (or clear) a remote server's headersHelper from the given header
// bindings, and strip any managed plaintext headers so the token only ever
// exists as a vault id on disk. Claude Code runs the helper per connection.
function applyHeadersHelper(serverCfg: any, headerBindings: VaultBinding[]): void {
  for (const b of headerBindings) {
    if (serverCfg.headers && b.headerName) delete serverCfg.headers[b.headerName]
  }
  if (headerBindings.length === 0) {
    delete serverCfg.headersHelper
  } else {
    const args = headerBindings.map(
      b => `${b.headerName}=${b.headerScheme ?? 'Bearer'}:::${b.vaultSecretId}`,
    )
    serverCfg.headersHelper = [VAULT_HEADERS_HELPER_PATH, ...args].map(shellEscape).join(' ')
  }
  if (serverCfg.headers && Object.keys(serverCfg.headers).length === 0) delete serverCfg.headers
}

export function syncSecret(vaultSecretId: string): SyncResult {
  let bindings: VaultBinding[]
  try {
    bindings = getBindings().filter(b => b.vaultSecretId === vaultSecretId)
  } catch (err) {
    // The store could not be read. We do NOT know whether this secret is bound
    // to anything, so we must not report the "bound to nothing" no-op.
    return syncStoreFailure(err)
  }
  if (bindings.length === 0) return { outcome: 'COMPLETED', updated: 0, errors: [] }

  const secret = getSecret(vaultSecretId)
  if (secret === null) {
    return { outcome: 'COMPLETED', updated: 0, errors: [`Vault secret "${vaultSecretId}" not found`] }
  }

  let updated = 0
  const errors: string[] = []

  for (const binding of bindings) {
    for (const target of binding.targets) {
      try {
        const content = JSON.parse(readFileOr(target.mcpFilePath, '{}'))
        const serverCfg = content.mcpServers?.[target.serverName]
        if (!serverCfg) {
          errors.push(`Server "${target.serverName}" not found in ${target.mcpFilePath}`)
          continue
        }
        if (binding.headerName) {
          // Remote header binding: wire the headersHelper (rebuilt from ALL
          // header bindings for this server) and strip any plaintext header.
          applyHeadersHelper(
            serverCfg,
            headerBindingsForServer(target.mcpFilePath, target.serverName),
          )
        } else {
          if (!serverCfg.env) serverCfg.env = {}
          serverCfg.env[binding.envVar] = `vault:${vaultSecretId}`
          if (serverCfg.command && !serverCfg.url) wrapCommand(serverCfg)
        }
        atomicWriteFileSync(target.mcpFilePath, JSON.stringify(content, null, 2))
        updated++
      } catch (err: any) {
        errors.push(`Failed to update ${target.mcpFilePath}: ${err.message}`)
      }
    }
  }

  if (updated > 0) logger.info({ vaultSecretId, updated }, 'Vault secret synced to .mcp.json files')
  return { outcome: 'COMPLETED', updated, errors }
}

/** Throws CredentialStoreUnreadable if the bindings store cannot be read: an
 *  unsync that quietly did nothing would leave the plaintext-free reference in
 *  place while the caller believed the binding had been torn down. */
export function unsyncBinding(vaultSecretId: string, envVar: string): void {
  const all = getBindings()
  const bindings = all.filter(
    b => b.vaultSecretId === vaultSecretId && b.envVar === envVar,
  )
  // Header bindings are rebuilt from the set that survives this removal (the
  // binding is still in the store here; removeBinding runs afterwards).
  const remaining = all.filter(
    b => !(b.vaultSecretId === vaultSecretId && b.envVar === envVar),
  )
  for (const binding of bindings) {
    for (const target of binding.targets) {
      try {
        const content = JSON.parse(readFileOr(target.mcpFilePath, '{}'))
        const serverCfg = content.mcpServers?.[target.serverName]
        if (!serverCfg) continue
        if (binding.headerName) {
          applyHeadersHelper(
            serverCfg,
            headerBindingsForServer(target.mcpFilePath, target.serverName, remaining),
          )
        } else {
          if (!serverCfg.env) continue
          delete serverCfg.env[envVar]
          if (!serverHasVaultRefs(serverCfg.env)) unwrapCommand(serverCfg)
        }
        atomicWriteFileSync(target.mcpFilePath, JSON.stringify(content, null, 2))
      } catch { /* skip */ }
    }
  }
}

export function syncAllBindings(): SyncResult {
  let allBindings: VaultBinding[]
  try {
    allBindings = getBindings()
  } catch (err) {
    // Nothing was enumerated, so nothing was attempted. Reporting `updated: 0`
    // as a COMPLETED sync here would tell an operator every binding is in sync.
    return syncStoreFailure(err)
  }
  const secretIds = new Set(allBindings.map(b => b.vaultSecretId))
  let totalUpdated = 0
  const allErrors: string[] = []
  let outcome: SyncResult['outcome'] = 'COMPLETED'
  let failure: SyncStoreFailure | undefined

  for (const id of secretIds) {
    const result = syncSecret(id)
    totalUpdated += result.updated
    allErrors.push(...result.errors)
    // A store that became unreadable mid-loop degrades the WHOLE run: the
    // remaining ids were read from a store we can no longer trust.
    if (result.outcome === 'STORE_UNREADABLE') {
      outcome = 'STORE_UNREADABLE'
      failure ??= result.failure
    }
  }
  return { outcome, updated: totalUpdated, errors: allErrors, failure }
}
