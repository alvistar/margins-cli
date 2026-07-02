import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { createApiClient } from '../src/lib/api-client.js'
import type { ResolvedConfig } from '../src/lib/config.js'
import { _resetStore } from '../src/lib/config.js'
import {
  AuthExpired, ForbiddenError, NotFoundError, ServerError,
  ConflictError, MergeConflictError, NetworkError, ResponseParseError,
} from '../src/lib/errors.js'

// Isolate config store — prevents token refresh tests from writing to the
// real user config at ~/Library/Preferences/margins/config.json
vi.stubEnv('MARGINS_CONFIG_DIR', path.join(os.tmpdir(), 'margins-api-client-test'))

const baseConfig = (): ResolvedConfig => ({
  apiKey: 'mrgn_testkey123',
  serverUrl: 'https://margins.example.com',
  json: false,
  verbose: false,
  noColor: false,
})

// Config simulating a Keycloak session with an expired access token
const expiredKeycloakConfig = (): ResolvedConfig => ({
  apiKey: 'eyJhbGciOiJSUzI1NiJ9.old.token',
  serverUrl: 'https://margins.example.com',
  json: false,
  verbose: false,
  noColor: false,
  refreshToken: 'valid_refresh_token',
  accessTokenExpiresAt: Date.now() - 1000, // already expired
  keycloakIssuer: 'https://keycloak.example.com/realms/margins',
  keycloakClientId: 'margins-cli',
})

// Keycloak OIDC discovery response stub
const keycloakDiscovery = {
  issuer: 'https://keycloak.example.com/realms/margins',
  token_endpoint: 'https://keycloak.example.com/realms/margins/protocol/openid-connect/token',
  jwks_uri: 'https://keycloak.example.com/realms/margins/protocol/openid-connect/certs',
}

describe('api client — basic auth', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('injects Authorization Bearer header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
    const client = createApiClient(baseConfig())
    await client.get('/api/workspaces')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://margins.example.com/api/workspaces',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer mrgn_testkey123' }),
      }),
    )
  })

  it('parses 200 OK JSON response and unwraps { data } envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 1, name: 'test' } }), { status: 200 }),
    ))
    const client = createApiClient(baseConfig())
    // Server wraps all responses in { data: ... } via apiOk() — client unwraps
    expect(await client.get('/api/test')).toEqual({ id: 1, name: 'test' })
  })

  it('throws AuthExpired on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })))
    await expect(createApiClient(baseConfig()).get('/api/test')).rejects.toBeInstanceOf(AuthExpired)
  })

  it('throws ForbiddenError on 403', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })))
    await expect(createApiClient(baseConfig()).get('/api/test')).rejects.toBeInstanceOf(ForbiddenError)
  })

  // Stash update flow (U6): the 403 body's error code decides recreate-vs-error,
  // mirroring the NotFoundError code capture below.
  it('captures the 403 body error code on ForbiddenError (NOT_A_MEMBER / INSUFFICIENT_ROLE)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'NOT_A_MEMBER', message: 'no access' }), { status: 403 }),
    ))
    const err = await createApiClient(baseConfig()).get('/api/test').catch((e) => e)
    expect(err).toBeInstanceOf(ForbiddenError)
    expect((err as ForbiddenError).code).toBe('NOT_A_MEMBER')
  })

  it('leaves ForbiddenError.code undefined for a 403 with no JSON body (regression)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 403 })))
    const err = await createApiClient(baseConfig()).get('/api/test').catch((e) => e)
    expect(err).toBeInstanceOf(ForbiddenError)
    expect((err as ForbiddenError).code).toBeUndefined()
  })

  it('throws NotFoundError on 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })))
    await expect(createApiClient(baseConfig()).get('/api/test')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('throws ServerError on 500', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })))
    await expect(createApiClient(baseConfig()).get('/api/test')).rejects.toBeInstanceOf(ServerError)
  })

  it('throws NetworkError on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(createApiClient(baseConfig()).get('/api/test')).rejects.toBeInstanceOf(NetworkError)
  })

  it('throws ResponseParseError on non-JSON response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json!!!', { status: 200 })))
    await expect(createApiClient(baseConfig()).get('/api/test')).rejects.toBeInstanceOf(ResponseParseError)
  })

  it('sends POST with JSON body', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: '123' }), { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
    await createApiClient(baseConfig()).post('/api/workspaces', { repoUrl: 'https://github.com/a/b' })
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ repoUrl: 'https://github.com/a/b' }),
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    )
  })

  it('sends PUT with JSON body, bearer auth, and the X-Margins-Client header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { binding: {} } }), { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
    const result = await createApiClient(baseConfig()).put('/api/workspaces/ws-1/binding', {
      githubRepoId: 1, repositoryOwnerId: 2, boundRepoName: 'a/b',
    })
    expect(result).toEqual({ binding: {} })
    expect(mockFetch).toHaveBeenCalledWith(
      'https://margins.example.com/api/workspaces/ws-1/binding',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ githubRepoId: 1, repositoryOwnerId: 2, boundRepoName: 'a/b' }),
        headers: expect.objectContaining({
          Authorization: 'Bearer mrgn_testkey123',
          'Content-Type': 'application/json',
          'X-Margins-Client': expect.stringMatching(/^margins-cli\/\d+\.\d+\.\d+$/),
        }),
      }),
    )
  })

  it('maps put() error statuses to typed errors (404 → NotFoundError, 409 → ConflictError)', async () => {
    const { ConflictError } = await import('../src/lib/errors.js')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })))
    await expect(createApiClient(baseConfig()).put('/api/x', {})).rejects.toBeInstanceOf(NotFoundError)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 409 })))
    await expect(createApiClient(baseConfig()).put('/api/x', {})).rejects.toBeInstanceOf(ConflictError)
  })

  it('masks API key in verbose stderr output', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
    await createApiClient({ ...baseConfig(), verbose: true }).get('/api/workspaces').catch(() => {})
    const output = stderrSpy.mock.calls.map((c) => c[0]).join('')
    expect(output).not.toContain('mrgn_testkey123')
    stderrSpy.mockRestore()
  })
})

describe('api client — X-Margins-Client header', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('attaches X-Margins-Client: margins-cli/<version> to JSON requests', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
    await createApiClient(baseConfig()).get('/api/workspaces')
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Margins-Client': expect.stringMatching(/^margins-cli\/\d+\.\d+\.\d+$/),
        }),
      }),
    )
  })

  it('attaches X-Margins-Client to raw binary uploads', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
    await createApiClient(baseConfig()).putRaw('/api/blob', Buffer.from('x'), 'text/markdown')
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          'X-Margins-Client': expect.stringMatching(/^margins-cli\/\d+\.\d+\.\d+$/),
        }),
      }),
    )
  })
})

describe('api client — GitHub Actions OIDC token', () => {
  // Hermeticity: the release CI job runs with `id-token: write`, so
  // ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN are present in the ambient environment.
  // Clear them by default so the "no mint env" cases are deterministic locally
  // AND in CI. Tests that exercise re-minting stub these explicitly, overriding
  // the clear below.
  beforeEach(() => {
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', '')
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', '')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.stubEnv('MARGINS_CONFIG_DIR', path.join(os.tmpdir(), 'margins-api-client-test'))
  })

  it('MARGINS_OIDC_TOKEN takes precedence over the stored api key', async () => {
    vi.stubEnv('MARGINS_OIDC_TOKEN', 'gh.oidc.token')
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)

    await createApiClient(baseConfig()).get('/api/workspaces')

    expect(mockFetch.mock.calls[0]?.[1]?.headers?.Authorization).toBe('Bearer gh.oidc.token')
  })

  it('MARGINS_OIDC_TOKEN takes precedence over a Keycloak session', async () => {
    vi.stubEnv('MARGINS_OIDC_TOKEN', 'gh.oidc.token')
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)

    await createApiClient(expiredKeycloakConfig()).get('/api/workspaces')

    // No discovery/refresh round-trips — straight to the API with the OIDC token
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0]?.[1]?.headers?.Authorization).toBe('Bearer gh.oidc.token')
  })

  it('re-mints the OIDC token once on 401 and retries with the fresh token', async () => {
    vi.stubEnv('MARGINS_OIDC_TOKEN', 'gh.old.token')
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', 'https://token.actions.example/token?param=1')
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'runner-req-token')

    const fetchMock = vi.fn()
      // 1. API request with stale token → 401
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      // 2. Token mint endpoint → fresh token
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: 'gh.new.token' }), { status: 200 }))
      // 3. Retried API request → 200
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await createApiClient(baseConfig()).get('/api/workspaces')

    expect(fetchMock).toHaveBeenCalledTimes(3)
    // Mint request: $URL&audience=<server origin> with the runner request token
    const mintCall = fetchMock.mock.calls[1]
    expect(mintCall?.[0]).toBe(
      'https://token.actions.example/token?param=1&audience=https%3A%2F%2Fmargins.example.com',
    )
    expect(mintCall?.[1]?.headers?.Authorization).toBe('Bearer runner-req-token')
    // Retry uses the freshly minted token
    expect(fetchMock.mock.calls[2]?.[1]?.headers?.Authorization).toBe('Bearer gh.new.token')
  })

  it('re-mints at most once: a second 401 after the retry throws AuthExpired', async () => {
    vi.stubEnv('MARGINS_OIDC_TOKEN', 'gh.old.token')
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', 'https://token.actions.example/token?param=1')
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'runner-req-token')

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: 'gh.new.token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(createApiClient(baseConfig()).get('/api/workspaces'))
      .rejects.toBeInstanceOf(AuthExpired)
    expect(fetchMock).toHaveBeenCalledTimes(3) // no second mint attempt
  })

  it('401 without the Actions token-request env stays AuthExpired (no mint attempt)', async () => {
    vi.stubEnv('MARGINS_OIDC_TOKEN', 'gh.oidc.token')
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(createApiClient(baseConfig()).get('/api/workspaces'))
      .rejects.toBeInstanceOf(AuthExpired)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('registers the OIDC token with Actions log masking before the first request', async () => {
    vi.stubEnv('MARGINS_OIDC_TOKEN', 'gh.oidc.token')
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    // Fresh Response per call — a single Response body can only be read once
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)

    const client = createApiClient(baseConfig())
    await client.get('/api/workspaces')
    await client.get('/api/workspaces')

    const masks = stdoutSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.startsWith('::add-mask::'))
    expect(masks).toEqual(['::add-mask::gh.oidc.token\n']) // once, not per request
    stdoutSpy.mockRestore()
  })
})

describe('api client — 409 conflict typing (merge vs generic)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const HEAD = 'ab'.repeat(32)

  // The merge-conflict 409 body is TOP-LEVEL (not in the { data } envelope) and
  // its `error` is a flat string code — mirrors the server's manifest route.
  const mergeBody = {
    error: 'SYNC_MERGE_CONFLICT',
    message: 'Divergent push could not be merged cleanly; resolve the conflicts and re-push.',
    merged: false,
    conflicts: [{ path: 'notes.md', reason: 'content' }],
    head: HEAD,
  }

  it('types a 409 SYNC_MERGE_CONFLICT as MergeConflictError exposing conflicts + head (AE4)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mergeBody), { status: 409 }),
    ))
    let caught: unknown
    await createApiClient(baseConfig()).post('/api/x', {}).catch((e) => { caught = e })

    expect(caught).toBeInstanceOf(MergeConflictError)
    expect(caught).toBeInstanceOf(ConflictError) // subclass — legacy `instanceof ConflictError` still catches it
    const err = caught as MergeConflictError
    expect(err.conflicts).toEqual([{ path: 'notes.md', reason: 'content' }])
    expect(err.head).toBe(HEAD)
    expect(err.userMessage).toContain('could not be merged')
  })

  it('falls back to a plain ConflictError on a 409 with a non-merge code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'SOMETHING_ELSE' }), { status: 409 }),
    ))
    let caught: unknown
    await createApiClient(baseConfig()).post('/api/x', {}).catch((e) => { caught = e })

    expect(caught).toBeInstanceOf(ConflictError)
    expect(caught).not.toBeInstanceOf(MergeConflictError)
  })

  it('carries the 409 body message + code on the plain ConflictError (e.g. REVERT_UNSUPPORTED)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'REVERT_UNSUPPORTED', message: 'This content is byte-identical to an earlier version.' }), { status: 409 }),
    ))
    const err = await createApiClient(baseConfig()).put('/api/stash', {}).catch((e) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).code).toBe('REVERT_UNSUPPORTED')
    expect((err as ConflictError).userMessage).toContain('byte-identical')
  })

  it('falls back to a plain ConflictError on a non-JSON 409 body (no crash)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<<not json>>', { status: 409 })))
    let caught: unknown
    await createApiClient(baseConfig()).post('/api/x', {}).catch((e) => { caught = e })

    expect(caught).toBeInstanceOf(ConflictError)
    expect(caught).not.toBeInstanceOf(MergeConflictError)
  })

  it('reads a flat-string `error` code into ServerError.code (real apiError shape)', async () => {
    // The live server emits { error: "CODE", message } (flat). Regression guard:
    // before this, readErrorCode only handled the nested { error: { code } } shape.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'PUSH_SYNC_NOT_SUPPORTED', message: 'nope' }), { status: 422 }),
    ))
    let caught: unknown
    await createApiClient(baseConfig()).post('/api/x', {}).catch((e) => { caught = e })

    expect(caught).toBeInstanceOf(ServerError)
    expect((caught as ServerError).code).toBe('PUSH_SYNC_NOT_SUPPORTED')
  })
})

describe('api client — Keycloak token refresh', () => {
  afterEach(() => { vi.unstubAllGlobals(); _resetStore() })

  it('refreshes expired access token before request', async () => {
    const fetchMock = vi.fn()
      // 1. OIDC discovery for refresh
      .mockResolvedValueOnce(new Response(JSON.stringify(keycloakDiscovery), { status: 200 }))
      // 2. Token refresh response
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'new_access_token',
        expires_in: 300,
        token_type: 'Bearer',
      }), { status: 200 }))
      // 3. Actual API request with new token
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createApiClient(expiredKeycloakConfig())
    await client.get('/api/workspaces')

    // Third call is the actual API request — should use the new token
    const apiCall = fetchMock.mock.calls[2]
    expect(apiCall?.[1]?.headers?.Authorization).toBe('Bearer new_access_token')
  })

  it('throws AuthExpired when refresh token is expired', async () => {
    const fetchMock = vi.fn()
      // OIDC discovery
      .mockResolvedValueOnce(new Response(JSON.stringify(keycloakDiscovery), { status: 200 }))
      // Token refresh fails (refresh token expired)
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createApiClient(expiredKeycloakConfig())
    await expect(client.get('/api/workspaces')).rejects.toBeInstanceOf(AuthExpired)
  })

  it('sends request with stale token when no refresh token stored (401 → AuthExpired)', async () => {
    // No refresh token — the client sends the expired token as-is.
    // The server returns 401, which the client maps to AuthExpired.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })))
    const cfg: ResolvedConfig = {
      ...expiredKeycloakConfig(),
      refreshToken: undefined,
    }
    const client = createApiClient(cfg)
    await expect(client.get('/api/workspaces')).rejects.toBeInstanceOf(AuthExpired)
  })

  it('does not refresh when token is still fresh', async () => {
    const freshToken = Date.now() + 10 * 60 * 1000 // expires in 10 min — well within buffer
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const cfg: ResolvedConfig = {
      ...expiredKeycloakConfig(),
      apiKey: 'eyJhbGciOiJSUzI1NiJ9.fresh.token',
      accessTokenExpiresAt: freshToken,
    }
    await createApiClient(cfg).get('/api/workspaces')

    // Only one fetch call — no refresh discovery call
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]?.headers?.Authorization).toBe('Bearer eyJhbGciOiJSUzI1NiJ9.fresh.token')
  })
})
