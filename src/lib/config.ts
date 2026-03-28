import Conf from 'conf'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ConfigParseError } from './errors.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LocalConfig {
  workspace_slug?: string
  default_branch?: string
  server_url?: string
}

export interface GlobalConfig {
  /** Margins API key (mrgn_...) — for agents, CI, non-interactive use */
  apiKey?: string
  serverUrl?: string
  /** Keycloak access token — stored after `margins auth login` */
  accessToken?: string
  /** Keycloak refresh token — used to silently refresh the access token */
  refreshToken?: string
  /** Epoch ms when the access token expires */
  accessTokenExpiresAt?: number
  /** Keycloak issuer URL — needed to hit the token endpoint for refresh */
  keycloakIssuer?: string
  /** Keycloak client ID — needed for refresh requests */
  keycloakClientId?: string
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

// ─── Global config via conf ───────────────────────────────────────────────────

let _store: InstanceType<typeof Conf<GlobalConfig>> | null = null

function getStore(): InstanceType<typeof Conf<GlobalConfig>> {
  if (!_store) {
    // Config directory resolution order:
    //   1. MARGINS_CONFIG_DIR env var — explicit override (tests, CI)
    //   2. $XDG_CONFIG_HOME/margins/ or ~/.config/margins/ — if config.json already
    //      exists there (migration path; Linux default via env-paths)
    //   3. Platform default via conf/env-paths:
    //        macOS  → ~/Library/Preferences/margins/
    //        Linux  → ~/.config/margins/  (XDG)
    //        Windows → %APPDATA%/margins/Config/
    const explicitDir = process.env['MARGINS_CONFIG_DIR']
    let cwd: string | undefined = explicitDir

    if (!cwd) {
      const xdgBase = process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config')
      const xdgConfig = path.join(xdgBase, 'margins', 'config.json')
      if (fs.existsSync(xdgConfig)) {
        cwd = path.dirname(xdgConfig)
      }
    }

    _store = new Conf<GlobalConfig>({
      projectName: 'margins',
      projectSuffix: '', // no '-nodejs' suffix
      ...(cwd ? { cwd } : {}),
    })
  }
  return _store
}

/** For testing: reset the lazy store so a fresh instance is created */
export function _resetStore(): void {
  _store = null
}

export function getGlobalConfig(): GlobalConfig {
  const store = getStore()
  return {
    apiKey: store.get('apiKey') as string | undefined,
    serverUrl: store.get('serverUrl') as string | undefined,
    accessToken: store.get('accessToken') as string | undefined,
    refreshToken: store.get('refreshToken') as string | undefined,
    accessTokenExpiresAt: store.get('accessTokenExpiresAt') as number | undefined,
    keycloakIssuer: store.get('keycloakIssuer') as string | undefined,
    keycloakClientId: store.get('keycloakClientId') as string | undefined,
  }
}

export function setGlobalConfig(updates: Partial<GlobalConfig>): void {
  const store = getStore()
  const keys: (keyof GlobalConfig)[] = [
    'apiKey', 'serverUrl', 'accessToken', 'refreshToken',
    'accessTokenExpiresAt', 'keycloakIssuer', 'keycloakClientId',
  ]
  for (const key of keys) {
    if (key in updates) {
      const val = updates[key]
      if (val == null) store.delete(key)
      else store.set(key, val as string | number)
    }
  }
}

export function clearGlobalConfig(): void {
  getStore().clear()
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

const DEFAULT_SERVER_URL = 'https://margins.app'

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
