import Conf from 'conf'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ─── Global config store ──────────────────────────────────────────────────────
//
// Moved here from the CLI (`src/lib/config.ts`) so the CLI and the Margins Light
// daemon resolve the SAME directory. Two implementations of this walk would
// eventually disagree about where `config.json` lives, and the symptom would be
// a daemon that reports "no API key" on a machine where `margins auth` plainly
// works — a difference in a path, presented as a difference in credentials.

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

const GLOBAL_CONFIG_KEYS: (keyof GlobalConfig)[] = [
  'apiKey',
  'serverUrl',
  'accessToken',
  'refreshToken',
  'accessTokenExpiresAt',
  'keycloakIssuer',
  'keycloakClientId',
]

export const DEFAULT_SERVER_URL = 'https://margins.thealvistar.com'

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
  for (const key of GLOBAL_CONFIG_KEYS) {
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

/**
 * Directory holding the CLI's global state (config.json and, for the stash
 * update path, the global stash-bindings.json). Follows the same resolution
 * order as the conf store itself: MARGINS_CONFIG_DIR → existing XDG dir →
 * platform default.
 */
export function getConfigDir(): string {
  return path.dirname(getStore().path)
}

// ─── Credential resolution for a non-CLI caller ───────────────────────────────

export type CredentialProblem = 'NO_API_KEY' | 'SESSION_ONLY'

export type CredentialResult =
  | { ok: true; apiKey: string; serverUrl: string }
  | { ok: false; problem: CredentialProblem; serverUrl: string }

/**
 * The credential a background process may use, from the environment and the
 * stored config only.
 *
 * Deliberately NARROWER than the CLI's `resolveConfig`, in two ways, and both
 * are the point rather than an omission:
 *
 *  - No CLI flags and no `.margins.json` walk. A daemon serving a browser tab has
 *    no argv the user typed and no cwd the user chose.
 *  - A Keycloak `accessToken` is NOT accepted as a fallback. The CLI can fall back
 *    to one because its HTTP client owns the refresh flow and can prompt when the
 *    refresh fails; a daemon has neither. Silently sending a token that expires in
 *    five minutes would turn a working feature into an intermittent 401 whose
 *    remedy — `margins auth login` — nothing on screen would name. `SESSION_ONLY`
 *    says exactly that instead.
 */
export function resolveCredential(): CredentialResult {
  const global = getGlobalConfig()
  const serverUrl =
    process.env['MARGINS_SERVER_URL'] || global.serverUrl || DEFAULT_SERVER_URL

  const apiKey = process.env['MARGINS_API_KEY'] || global.apiKey
  if (apiKey) return { ok: true, apiKey, serverUrl }

  const problem: CredentialProblem = global.accessToken ? 'SESSION_ONLY' : 'NO_API_KEY'
  return { ok: false, problem, serverUrl }
}
