import * as oauth from 'oauth4webapi'
import type { ResolvedConfig } from './config.js'
import { setGlobalConfig } from './config.js'
import {
  AuthExpired, ForbiddenError, NotFoundError, ServerError, ConflictError,
  NetworkError, TimeoutError, ResponseParseError,
} from './errors.js'
import { maskKey } from './output.js'

const DEFAULT_TIMEOUT_MS = 30_000

// Buffer: refresh the access token 30s before it actually expires.
// Prevents race conditions where the token expires mid-request.
const REFRESH_BUFFER_MS = 30_000

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ApiClient {
  get(path: string, query?: Record<string, string>): Promise<unknown>
  post(path: string, body?: unknown): Promise<unknown>
  patch(path: string, body?: unknown): Promise<unknown>
  delete(path: string): Promise<unknown>
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
  ): Promise<unknown> {
    const url = buildUrl(path, query)

    // Resolve bearer — transparently refreshes Keycloak token if needed
    const bearer = await resolveBearer(config)

    const headers: Record<string, string> = {
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/json',
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
          return doFetch(method, path, query, body, attempt + 1)
        }
        throw new TimeoutError()
      }
      throw new NetworkError(config.serverUrl)
    }
    clearTimeout(timer)

    log(`→ ${response.status}`)

    if (response.status === 401) throw new AuthExpired()
    if (response.status === 403) throw new ForbiddenError(path)
    if (response.status === 404) throw new NotFoundError(path)
    if (response.status === 409) throw new ConflictError(`Conflict while calling ${path}`)
    if (response.status >= 400 && response.status < 500) throw new ServerError(response.status)
    if (response.status >= 500) throw new ServerError(response.status)

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

  return {
    get: (path, query) => doFetch('GET', path, query),
    post: (path, body) => doFetch('POST', path, undefined, body),
    patch: (path, body) => doFetch('PATCH', path, undefined, body),
    delete: (path) => doFetch('DELETE', path),
  }
}
