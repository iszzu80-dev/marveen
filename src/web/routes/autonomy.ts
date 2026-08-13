import { readFileSync, writeFileSync, existsSync, renameSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../../config.js'
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { setStoreWriteActor } from '../../store-watcher.js'
import type { RouteContext } from './types.js'

const CONFIG_PATH = join(PROJECT_ROOT, 'store', 'autonomy-config.json')
const LOCK_PATH = CONFIG_PATH + '.lock'

interface AutonomyCategory {
  key: string
  label: string
  level: number
  locked: boolean
  maxLevel: number
}

interface AutonomyConfig {
  version: number
  updated_at: number
  _doc?: string
  categories: AutonomyCategory[]
}

/** The level a caller gets when the config, or the key inside it, is missing.
 *
 *  It used to be 3 — fully autonomous — documented in docs/heartbeat-autonomy.md
 *  as "the previous behaviour". A missing key granting the MOST permissive level
 *  inverts the fail-closed posture every other gate in this codebase takes: the
 *  SQLite ladder defaults an unknown case type to PREPARE ("it may draft, never
 *  send"), the sensitivity gate defaults unknown to HIGHLY_SENSITIVE, and the
 *  completion gate defaults an unnamed actor to the strict side. A category
 *  nobody has configured is a category nobody has thought about, and the safe
 *  reading of that is "report only". */
export const DEFAULT_AUTONOMY_LEVEL = 1

function loadConfig(): AutonomyConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error('autonomy-config.json not found')
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
}

/** The autonomy level for one category, for callers that must act on it.
 *
 *  Every failure — no file, unreadable file, unknown key, a level outside 1-3 —
 *  returns DEFAULT_AUTONOMY_LEVEL. Exported so the answer to "how autonomous am
 *  I here" comes from one place; a caller that inlines its own `?? 3` is how the
 *  permissive default came back the last time. */
export function autonomyLevel(key: string, configPath: string = CONFIG_PATH): 1 | 2 | 3 {
  try {
    if (!existsSync(configPath)) return DEFAULT_AUTONOMY_LEVEL
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as AutonomyConfig
    const cat = config.categories?.find(c => c.key === key)
    if (!cat) return DEFAULT_AUTONOMY_LEVEL
    if (!Number.isInteger(cat.level) || cat.level < 1 || cat.level > 3) return DEFAULT_AUTONOMY_LEVEL
    return cat.level as 1 | 2 | 3
  } catch {
    return DEFAULT_AUTONOMY_LEVEL
  }
}

/** Hold an exclusive lock around a read-modify-write of the config file.
 *
 *  The old POST read the file, mutated one category and wrote the whole
 *  document back with no lock at all. Two writers (the dashboard and the CLI, or
 *  two dashboard tabs) interleave into a lost update — and the update being lost
 *  is an autonomy level, so the value that survives may be the more permissive
 *  one. O_EXCL on a lock file is the smallest thing that actually excludes
 *  across processes; a stale lock older than the timeout is broken rather than
 *  wedging the endpoint for ever. */
function withConfigLock<T>(fn: () => T): T {
  const STALE_MS = 10_000
  let fd: number | null = null
  for (let attempt = 0; attempt < 50 && fd === null; attempt++) {
    try {
      fd = openSync(LOCK_PATH, 'wx')
    } catch {
      try {
        if (Date.now() - statSync(LOCK_PATH).mtimeMs > STALE_MS) unlinkSync(LOCK_PATH)
      } catch { /* someone else broke it first */ }
      // Busy-wait briefly: the critical section is two synchronous file
      // operations, so a contended lock clears in microseconds.
      const until = Date.now() + 2
      while (Date.now() < until) { /* spin */ }
    }
  }
  if (fd === null) throw new Error('autonomy config is locked by another writer')
  try {
    return fn()
  } finally {
    try { closeSync(fd) } catch { /* already closed */ }
    try { unlinkSync(LOCK_PATH) } catch { /* already gone */ }
  }
}

/** Write via a temp file + rename: a reader must never see a half-written
 *  config, because a truncated JSON read falls back to the default level. */
function saveConfig(config: AutonomyConfig): void {
  config.updated_at = Math.floor(Date.now() / 1000)
  const tmp = `${CONFIG_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  renameSync(tmp, CONFIG_PATH)
}

export async function tryHandleAutonomy(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/autonomy' && method === 'GET') {
    try {
      const config = loadConfig()
      json(res, config)
    } catch (err) {
      logger.error({ err }, 'Failed to load autonomy config')
      json(res, { error: 'Config not found' }, 404)
    }
    return true
  }

  if (path === '/api/autonomy' && method === 'POST') {
    try {
      const body = await readBody(req)
      const { key, level } = JSON.parse(body.toString())

      // Integer, not merely "a number between 1 and 3". 2.5 passed the old
      // check and was persisted, and every consumer compares with === 3 or
      // >= 2, so a fractional level means whatever each reader happens to do
      // with it.
      if (!key || typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 3) {
        json(res, { error: 'Invalid key or level (must be an integer 1-3)' }, 400)
        return true
      }

      const result = withConfigLock(() => {
        const config = loadConfig()
        const cat = config.categories.find(c => c.key === key)
        if (!cat) return { error: `Category "${key}" not found`, code: 404 } as const

        if (cat.locked && level > 1) {
          return { error: `Category "${key}" is locked at level 1 (safety constraint)`, code: 403 } as const
        }

        if (level > cat.maxLevel) {
          return { error: `Category "${key}" max level is ${cat.maxLevel}`, code: 400 } as const
        }

        cat.level = level
        setStoreWriteActor('dashboard')
        saveConfig(config)
        return { updated_at: config.updated_at } as const
      })

      if ('error' in result) {
        json(res, { error: result.error }, result.code)
        return true
      }

      logger.info({ key, level }, 'Autonomy level updated')
      json(res, { ok: true, key, level, updated_at: result.updated_at })
    } catch (err) {
      logger.error({ err }, 'Failed to update autonomy config')
      json(res, { error: 'Failed to update' }, 500)
    }
    return true
  }

  return false
}
