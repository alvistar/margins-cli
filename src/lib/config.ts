import * as fs from 'node:fs'
import * as path from 'node:path'
import { DEFAULT_SERVER_URL, getGlobalConfig } from '@alvistar/margins-stash-core'
import { ConfigParseError } from './errors.js'

// The global config STORE lives in @alvistar/margins-stash-core, not here.
// The Margins Light daemon reads the same `config.json`, and two copies of the
// directory walk would eventually disagree — a daemon reporting "no API key" on
// a machine where `margins auth` plainly works, because one of them looked in
// the wrong place. Re-exported so every existing importer of `./config.js` keeps
// working unchanged; what remains below is the part that is genuinely CLI-only:
// argv flags and the `.margins.json` walk up from cwd.
export {
  _resetStore,
  getGlobalConfig,
  setGlobalConfig,
  clearGlobalConfig,
  getConfigDir,
} from '@alvistar/margins-stash-core'
export type { GlobalConfig } from '@alvistar/margins-stash-core'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LocalConfig {
  workspace_slug?: string
  workspace_id?: string
  default_branch?: string
  server_url?: string
  syncMode?: 'server' | 'client'
  mode?: 'overlay' | 'local' // Legacy field, replaced by syncMode
}

export interface ResolvedConfig {
  /** Margins API key (mrgn_...) OR a Keycloak access token — whichever is active */
  apiKey: string | undefined
  serverUrl: string
  json: boolean
  verbose: boolean
  noColor: boolean
  /** Keycloak tokens — present only when logged in via `margins auth login` */
  refreshToken?: string
  accessTokenExpiresAt?: number
  keycloakIssuer?: string
  keycloakClientId?: string
}

export interface CliOpts {
  apiKey?: string
  serverUrl?: string
  json?: boolean
  verbose?: boolean
  noColor?: boolean
}


// ─── Local .margins.json ──────────────────────────────────────────────────────

/**
 * Walk up from cwd looking for .margins.json.
 * Returns parsed contents, null if not found, throws ConfigParseError if malformed.
 */
export function readLocalConfig(): LocalConfig | null {
  let dir = process.cwd()
  const root = path.parse(dir).root

  while (true) {
    const candidate = path.join(dir, '.margins.json')
    if (fs.existsSync(candidate)) {
      const raw = fs.readFileSync(candidate, 'utf-8')
      try {
        return JSON.parse(raw) as LocalConfig
      } catch (e) {
        throw new ConfigParseError(`Invalid .margins.json at ${candidate}: ${(e as Error).message}`)
      }
    }
    if (dir === root) break
    dir = path.dirname(dir)
  }
  return null
}

// ─── Config resolution order ──────────────────────────────────────────────────

/**
 * Merge config sources in priority order:
 *   1. CLI flags (--api-key, --server-url)
 *   2. Env vars (MARGINS_API_KEY, MARGINS_SERVER_URL)
 *   3. Local .margins.json (server_url only)
 *   4. Global conf store
 */
export function resolveConfig(cliOpts: CliOpts): ResolvedConfig {
  const global = getGlobalConfig()
  let local: LocalConfig | null = null
  try {
    local = readLocalConfig()
  } catch (err) {
    // Warn but don't fatal — a malformed .margins.json should not block commands.
    // The error is also surfaced when commands explicitly call readLocalConfig().
    process.stderr.write(`Warning: ${err instanceof Error ? err.message : String(err)}\n`)
  }

  // apiKey resolution: explicit flag/env/stored key takes precedence over Keycloak token.
  // If none of those are set, fall back to the stored Keycloak access token.
  const apiKey =
    cliOpts.apiKey ||
    process.env['MARGINS_API_KEY'] ||
    global.apiKey ||
    global.accessToken ||
    undefined

  const serverUrl =
    cliOpts.serverUrl ||
    process.env['MARGINS_SERVER_URL'] ||
    local?.server_url ||
    global.serverUrl ||
    DEFAULT_SERVER_URL

  return {
    apiKey: apiKey || undefined,
    serverUrl,
    json: cliOpts.json ?? false,
    verbose: cliOpts.verbose ?? false,
    noColor: cliOpts.noColor ?? false,
    // Keycloak session fields — only present when logged in via auth login
    refreshToken: global.refreshToken,
    accessTokenExpiresAt: global.accessTokenExpiresAt,
    keycloakIssuer: global.keycloakIssuer,
    keycloakClientId: global.keycloakClientId,
  }
}
