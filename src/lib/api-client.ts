import * as oauth from 'oauth4webapi'
import type { ResolvedConfig } from './config.js'
import { setGlobalConfig } from './config.js'
import {
  AuthExpired, ForbiddenError, NotFoundError, ServerError, ConflictError,
  NetworkError, TimeoutError, ResponseParseError,
} from './errors.js'
import { maskKey } from './output.js'
import { CLI_VERSION } from './version.js'

const DEFAULT_TIMEOUT_MS = 30_000

const CLIENT_HEADER = `margins-cli/${CLI_VERSION}`

// Buffer: refresh the access token 30s before it actually expires.
// Prevents race conditions where the token expires mid-request.
const REFRESH_BUFFER_MS = 30_000

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ApiClient {
  get(path: string, query?: Record<string, string>): Promise<unknown>
  post(path: string, body?: unknown): Promise<unknown>
  put(path: string, body?: unknown): Promise<unknown>
  patch(path: string, body?: unknown): Promise<unknown>
  delete(path: string): Promise<unknown>
  /** Upload raw binary data (for CAS blob uploads). Returns parsed JSON response. */
  putRaw(path: string, data: Buffer, contentType: string): Promise<unknown>
}

// ─── Token refresh ────────────────────────────────────────────────────────────

/*
 * Token refresh state machine:
 *
 *  ┌──────────────┐   token fresh   ┌──────────────┐
 *  │  API request │ ──────────────▶ │  send request │
 *  └──────────────┘                 └──────────────┘
 *         │ token expired
 *         ▼
 *  ┌──────────────┐   refresh ok    ┌──────────────┐
 *  │ refresh token│ ──────────────▶ │ update stored │──▶ send request
 *  └──────────────┘                 └──────────────┘
 *         │ refresh expired/missing
 *         ▼
 *  ┌──────────────────────────────────────────────┐
 *  │ throw AuthExpired: "Session expired. Run:     │
 *  │ margins auth login"                          │
 *  └──────────────────────────────────────────────┘
 */
async function refreshAccessToken(cfg: ResolvedConfig): Promise<string> {
  if (!cfg.refreshToken || !cfg.keycloakIssuer || !cfg.keycloakClientId) {
    throw new AuthExpired()
  }

  const issuerUrl = new URL(cfg.keycloakIssuer)
  const as = await oauth.discoveryRequest(issuerUrl, { algorithm: 'oidc' })
    .then((r) => oauth.processDiscoveryResponse(issuerUrl, r))

  const client: oauth.Client = {
    client_id: cfg.keycloakClientId,
    token_endpoint_auth_method: 'none',
  }

  const response = await oauth.refreshTokenGrantRequest(
    as, client, oauth.None(), cfg.refreshToken,
  )

  let result: oauth.TokenEndpointResponse
  try {
    result = await oauth.processRefreshTokenResponse(as, client, response)
  } catch {
    // Refresh token expired or revoked
    throw new AuthExpired()
  }

  const newAccessToken = result.access_token
  const expiresIn = result.expires_in ?? 300
  const accessTokenExpiresAt = Date.now() + expiresIn * 1000

  // Persist the new access token (and new refresh token if Keycloak rotated it)
  setGlobalConfig({
    accessToken: newAccessToken,
    accessTokenExpiresAt,
    ...(result.refresh_token ? { refreshToken: result.refresh_token } : {}),
  })

  return newAccessToken
}

/**
 * Returns the current access token, refreshing it first if it's expired or close
 * to expiry. Falls back to the stored apiKey if no Keycloak session is present.
 */
async function resolveBearer(cfg: ResolvedConfig): Promise<string> {
  // Only attempt refresh if we have both a refresh token AND an expiry timestamp.
  // If accessTokenExpiresAt is set but refreshToken is missing, fall through to
  // using the raw apiKey (or empty string) — don't crash.
  if (cfg.refreshToken && cfg.keycloakIssuer && cfg.accessTokenExpiresAt) {
    const needsRefresh = Date.now() >= cfg.accessTokenExpiresAt - REFRESH_BUFFER_MS
    if (needsRefresh) {
      return refreshAccessToken(cfg)
    }
  }
  return cfg.apiKey ?? ''
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createApiClient(config: ResolvedConfig): ApiClient {
  // OIDC token re-minted mid-session (GitHub Actions). Takes precedence over
  // the env var so a re-mint sticks for the rest of the push.
  let mintedOidcToken: string | undefined
  // Tokens already registered with the Actions log-masking mechanism.
  const maskRegistered = new Set<string>()

  function currentOidcToken(): string | undefined {
    return mintedOidcToken ?? process.env['MARGINS_OIDC_TOKEN'] ?? undefined
  }

  /** Register a token with GitHub Actions log masking before it's ever used. */
  function registerActionsMask(token: string): void {
    if (process.env['GITHUB_ACTIONS'] && !maskRegistered.has(token)) {
      maskRegistered.add(token)
      process.stdout.write(`::add-mask::${token}\n`)
    }
  }

  function canRemintOidc(): boolean {
    return Boolean(
      process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] &&
      process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'],
    )
  }

  /**
   * Re-mint a GitHub Actions OIDC token (a long push can outlive the ~5-min
   * JWT validity). Audience = the server origin, no trailing slash — must
   * match the server's exact-string audience pin.
   */
  async function remintOidcToken(): Promise<void> {
    const requestUrl = process.env['ACTIONS_ID_TOKEN_REQUEST_URL']!
    const requestToken = process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN']!
    const audience = new URL(config.serverUrl).origin

    log('401 — re-minting GitHub Actions OIDC token...')
    let response: Response
    try {
      response = await fetch(`${requestUrl}&audience=${encodeURIComponent(audience)}`, {
        headers: { Authorization: `Bearer ${requestToken}` },
      })
    } catch {
      throw new AuthExpired()
    }
    if (!response.ok) throw new AuthExpired()
    const result = await response.json().catch(() => null) as { value?: string } | null
    if (!result?.value) throw new AuthExpired()
    registerActionsMask(result.value)
    mintedOidcToken = result.value
  }

  /**
   * Resolve the bearer for a request. MARGINS_OIDC_TOKEN (or a re-minted
   * Actions token) takes precedence over Keycloak/api-key resolution.
   */
  async function resolveRequestBearer(): Promise<string> {
    const oidc = currentOidcToken()
    if (oidc) {
      registerActionsMask(oidc)
      return oidc
    }
    return resolveBearer(config)
  }

  /** Extract the server error code from an error response body, if any. */
  async function readErrorCode(response: Response): Promise<string | undefined> {
    try {
      const parsed = await response.json() as {
        error?: { code?: string } | string
        code?: string
      } | null
      if (parsed && typeof parsed.error === 'object' && parsed.error?.code) {
        return parsed.error.code
      }
      if (parsed?.code) return parsed.code
    } catch {
      // Non-JSON error body — no code available
    }
    return undefined
  }
  function buildUrl(path: string, query?: Record<string, string>): string {
    const base = config.serverUrl.replace(/\/$/, '')
    const url = new URL(`${base}${path}`)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, v)
      }
    }
    return url.toString()
  }

  function log(msg: string): void {
    if (config.verbose) {
      process.stderr.write(`[margins] ${msg}\n`)
    }
  }

  async function doFetch(
    method: string,
    path: string,
    query?: Record<string, string>,
    body?: unknown,
    attempt = 1,
    remintAttempted = false,
  ): Promise<unknown> {
    const url = buildUrl(path, query)

    // Resolve bearer — OIDC env token wins; otherwise Keycloak/api-key
    const bearer = await resolveRequestBearer()

    const headers: Record<string, string> = {
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/json',
      'X-Margins-Client': CLIENT_HEADER,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    }

    log(`${method} ${url} (key: ${maskKey(bearer)})`)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      if ((err as Error).name === 'AbortError') {
        // Only retry idempotent methods to avoid creating duplicate resources
        const isIdempotent = method === 'GET' || method === 'DELETE'
        if (isIdempotent && attempt < 2) {
          log('Timeout — retrying once...')
          return doFetch(method, path, query, body, attempt + 1, remintAttempted)
        }
        throw new TimeoutError()
      }
      throw new NetworkError(config.serverUrl)
    }
    clearTimeout(timer)

    log(`→ ${response.status}`)

    if (response.status === 401) {
      // In GitHub Actions, the OIDC JWT (~5 min) can expire mid-push:
      // re-mint it once and retry the request with the fresh token.
      if (!remintAttempted && canRemintOidc()) {
        await remintOidcToken()
        return doFetch(method, path, query, body, attempt, true)
      }
      throw new AuthExpired()
    }
    if (response.status === 403) throw new ForbiddenError(path)
    if (response.status === 404) throw new NotFoundError(path)
    if (response.status === 409) throw new ConflictError(`Conflict while calling ${path}`)
    if (response.status >= 400) throw new ServerError(response.status, await readErrorCode(response))

    // Parse body — server wraps all responses in { data: ... } via apiOk()
    const text = await response.text()
    if (!text) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ResponseParseError()
    }
    // Unwrap { data: ... } envelope from apiOk()
    if (parsed !== null && typeof parsed === 'object' && 'data' in (parsed as object)) {
      return (parsed as { data: unknown }).data
    }
    return parsed
  }

  /**
   * Send a raw binary request (for CAS blob uploads).
   * Unlike doFetch, this sends the body as-is with the given Content-Type.
   */
  async function doFetchRaw(
    method: string,
    path: string,
    data: Buffer,
    contentType: string,
    remintAttempted = false,
  ): Promise<unknown> {
    const url = buildUrl(path)
    const bearer = await resolveRequestBearer()

    const headers: Record<string, string> = {
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/json',
      'X-Margins-Client': CLIENT_HEADER,
      'Content-Type': contentType,
    }

    log(`${method} ${url} (${data.length} bytes, key: ${maskKey(bearer)})`)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: new Uint8Array(data),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      if ((err as Error).name === 'AbortError') throw new TimeoutError()
      throw new NetworkError(config.serverUrl)
    }
    clearTimeout(timer)

    log(`→ ${response.status}`)

    if (response.status === 401) {
      if (!remintAttempted && canRemintOidc()) {
        await remintOidcToken()
        return doFetchRaw(method, path, data, contentType, true)
      }
      throw new AuthExpired()
    }
    if (response.status === 403) throw new ForbiddenError(path)
    if (response.status === 404) throw new NotFoundError(path)
    if (response.status === 409) throw new ConflictError(`Conflict while calling ${path}`)
    if (response.status >= 400) throw new ServerError(response.status, await readErrorCode(response))

    const text = await response.text()
    if (!text) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ResponseParseError()
    }
    if (parsed !== null && typeof parsed === 'object' && 'data' in (parsed as object)) {
      return (parsed as { data: unknown }).data
    }
    return parsed
  }

  return {
    get: (path, query) => doFetch('GET', path, query),
    post: (path, body) => doFetch('POST', path, undefined, body),
    put: (path, body) => doFetch('PUT', path, undefined, body),
    patch: (path, body) => doFetch('PATCH', path, undefined, body),
    delete: (path) => doFetch('DELETE', path),
    putRaw: (path, data, contentType) => doFetchRaw('PUT', path, data, contentType),
  }
}
