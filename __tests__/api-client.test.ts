import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { createApiClient } from '../src/lib/api-client.js'
import type { ResolvedConfig } from '../src/lib/config.js'
import { _resetStore } from '../src/lib/config.js'
import {
  AuthExpired, ForbiddenError, NotFoundError, ServerError,
  NetworkError, ResponseParseError,
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

  it('masks API key in verbose stderr output', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
    await createApiClient({ ...baseConfig(), verbose: true }).get('/api/workspaces').catch(() => {})
    const output = stderrSpy.mock.calls.map((c) => c[0]).join('')
    expect(output).not.toContain('mrgn_testkey123')
    stderrSpy.mockRestore()
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
