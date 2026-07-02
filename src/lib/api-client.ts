import * as oauth from 'oauth4webapi'
import type { ResolvedConfig } from './config.js'
import { setGlobalConfig } from './config.js'
import {
  AuthExpired, ForbiddenError, NotFoundError, ServerError, ConflictError,
  MergeConflictError, FullDeleteNotConfirmedError, NetworkError, TimeoutError,
  ResponseParseError,
  type SyncConflictEntry,
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

  interface ParsedErrorBody {
    code?: string
    message?: string
    conflicts?: SyncConflictEntry[]
    head?: string | null
  }

  /**
   * Parse a JSON error body once, normalizing the server's error code across
   * every shape it ships:
   *   - flat string  `{ error: "CODE", message }`     ← apiError() / merge-conflict 409
   *   - nested object `{ error: { code: "CODE" } }`    ← legacy
   *   - top-level     `{ code: "CODE" }`
   * Also surfaces a merge-conflict 409's `conflicts` + `head`. A Response body
   * can only be read once, so callers must use this XOR read the body elsewhere.
   */
  async function parseErrorBody(response: Response): Promise<ParsedErrorBody | undefined> {
    let parsed: Record<string, unknown> | null
    try {
      parsed = await response.json() as Record<string, unknown> | null
    } catch {
      return undefined // Non-JSON error body — nothing to extract
    }
    if (!parsed || typeof parsed !== 'object') return undefined

    const err = parsed['error']
    let code: string | undefined
    if (typeof err === 'string') code = err
    else if (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string') {
      code = (err as { code: string }).code
    } else if (typeof parsed['code'] === 'string') {
      code = parsed['code'] as string
    }

    const message = typeof parsed['message'] === 'string' ? parsed['message'] as string : undefined
    const conflicts = Array.isArray(parsed['conflicts'])
      ? (parsed['conflicts'] as unknown[]).filter(
          (c): c is SyncConflictEntry =>
            !!c && typeof c === 'object'
            && typeof (c as { path?: unknown }).path === 'string'
            && typeof (c as { reason?: unknown }).reason === 'string',
        )
      : undefined
    const head = typeof parsed['head'] === 'string' ? parsed['head'] as string
      : parsed['head'] === null ? null : undefined

    return { code, message, conflicts, head }
  }

  /** Extract the server error code from an error response body, if any. */
  async function readErrorCode(response: Response): Promise<string | undefined> {
    return (await parseErrorBody(response))?.code
  }
  /** Map an error response status to the matching typed error. */
  async function throwForStatus(response: Response, path: string): Promise<void> {
    if (response.status === 403) {
      // Capture the error code (when the body carries one) — mirrors the 404
      // branch below. The stash update flow branches on NOT_A_MEMBER vs
      // INSUFFICIENT_ROLE to decide recreate-vs-error.
      throw new ForbiddenError(path, await readErrorCode(response))
    }
    if (response.status === 404) {
      // Capture the error code (if the 404 carries a JSON body) so callers can
      // tell a real "resource not found" from a route that doesn't exist on an
      // older server (no JSON body → no code → feature-detect upgrade needed).
      throw new NotFoundError(path, await readErrorCode(response))
    }
    if (response.status === 409) {
      // Read the body to tell a server-side merge conflict (SYNC_MERGE_CONFLICT,
      // never auto-overwrite) apart from a generic/legacy 409.
      const body = await parseErrorBody(response)
      if (body?.code === 'SYNC_MERGE_CONFLICT') {
        throw new MergeConflictError(body.conflicts ?? [], body.head ?? null, body.message)
      }
      if (body?.code === 'SYNC_FULL_DELETE_NOT_CONFIRMED') {
        throw new FullDeleteNotConfirmedError(
          body.message ??
            'This push would delete every file on the branch. Re-run with --confirm-full-delete.',
        )
      }
      // Carry the server's message + code when present (e.g. REVERT_UNSUPPORTED
      // from the stash update path) so callers can show an actionable line.
      throw new ConflictError(body?.message ?? `Conflict while calling ${path}`, body?.code)
    }
    if (response.status >= 400) throw new ServerError(response.status, await readErrorCode(response))
  }

  /**
   * Send a request; on a 401 in GitHub Actions (where the ~5-min OIDC JWT can
   * expire mid-push), re-mint the token once and resend. Any remaining 401 is
   * AuthExpired. `send` resolves the bearer itself, so the resend picks up the
   * freshly minted token.
   */
  async function sendWithOidcRemint(send: () => Promise<Response>): Promise<Response> {
    let response = await send()
    if (response.status === 401 && canRemintOidc()) {
      await remintOidcToken()
      response = await send()
    }
    if (response.status === 401) throw new AuthExpired()
    return response
  }

  /** Parse a JSON body, unwrapping the server's { data: ... } apiOk() envelope. */
  async function parseBody(response: Response): Promise<unknown> {
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

  /** fetch with the default timeout; maps aborts/failures to typed errors. */
  async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new TimeoutError()
      throw new NetworkError(config.serverUrl)
    } finally {
      clearTimeout(timer)
    }
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
  ): Promise<unknown> {
    const url = buildUrl(path, query)

    let response: Response
    try {
      response = await sendWithOidcRemint(async () => {
        // Resolve bearer — OIDC env token wins; otherwise Keycloak/api-key
        const bearer = await resolveRequestBearer()
        log(`${method} ${url} (key: ${maskKey(bearer)})`)
        const sent = await fetchWithTimeout(url, {
          method,
          headers: {
            Authorization: `Bearer ${bearer}`,
            Accept: 'application/json',
            'X-Margins-Client': CLIENT_HEADER,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        })
        log(`→ ${sent.status}`)
        return sent
      })
    } catch (err) {
      if (err instanceof TimeoutError) {
        // Only retry idempotent methods to avoid creating duplicate resources
        const isIdempotent = method === 'GET' || method === 'DELETE'
        if (isIdempotent && attempt < 2) {
          log('Timeout — retrying once...')
          return doFetch(method, path, query, body, attempt + 1)
        }
      }
      throw err
    }

    await throwForStatus(response, path)
    return parseBody(response)
  }

  /**
   * Send a raw binary request (for CAS blob uploads).
   * Unlike doFetch, this sends the body as-is with the given Content-Type
   * and never retries timeouts.
   */
  async function doFetchRaw(
    method: string,
    path: string,
    data: Buffer,
    contentType: string,
  ): Promise<unknown> {
    const url = buildUrl(path)

    const response = await sendWithOidcRemint(async () => {
      const bearer = await resolveRequestBearer()
      log(`${method} ${url} (${data.length} bytes, key: ${maskKey(bearer)})`)
      const sent = await fetchWithTimeout(url, {
        method,
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: 'application/json',
          'X-Margins-Client': CLIENT_HEADER,
          'Content-Type': contentType,
        },
        body: new Uint8Array(data),
      })
      log(`→ ${sent.status}`)
      return sent
    })

    await throwForStatus(response, path)
    return parseBody(response)
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
