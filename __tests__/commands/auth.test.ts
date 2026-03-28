import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import { handleWhoami } from '../../src/commands/auth/whoami.js'
import { handleLogout } from '../../src/commands/auth/logout.js'
import { clearGlobalConfig, _resetStore, setGlobalConfig, getGlobalConfig } from '../../src/lib/config.js'

vi.stubEnv('MARGINS_CONFIG_DIR', os.tmpdir() + '/margins-auth-test')

const baseCfg = (overrides = {}) => ({
  apiKey: 'mrgn_testkey1234567',
  serverUrl: 'https://margins.example.com',
  json: false,
  verbose: false,
  noColor: false,
  ...overrides,
})

const keycloakCfg = (overrides = {}) => ({
  apiKey: 'eyJhbGciOiJSUzI1NiJ9.test.token', // looks like a JWT
  serverUrl: 'https://margins.example.com',
  json: false,
  verbose: false,
  noColor: false,
  refreshToken: 'refresh_token_value',
  accessTokenExpiresAt: Date.now() + 5 * 60 * 1000, // expires in 5 min
  keycloakIssuer: 'https://keycloak.example.com/realms/margins',
  keycloakClientId: 'margins-cli',
  ...overrides,
})

const mockWhoamiResponse = {
  user: { id: 'user-1', name: 'Alice', email: 'alice@example.com', avatarUrl: null },
  key: { id: 'key-id', label: 'margins-cli', role: 'edit', createdAt: '2026-01-01', lastUsedAt: null, expiresAt: null },
}

describe('auth whoami', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('displays user name, email, and key info', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockWhoamiResponse), { status: 200 }),
    ))
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await handleWhoami(baseCfg())
    const output = spy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(output).toContain('Alice')
    expect(output).toContain('alice@example.com')
    expect(output).toContain('margins-cli')
    spy.mockRestore()
  })

  it('outputs JSON with user + key when json=true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...mockWhoamiResponse, key: { ...mockWhoamiResponse.key, expiresAt: '2027-01-01' } }), { status: 200 }),
    ))
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await handleWhoami({ ...baseCfg(), json: true })
    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string)
    expect(parsed).toHaveProperty('user')
    expect(parsed).toHaveProperty('key')
    expect(parsed.user.name).toBe('Alice')
    spy.mockRestore()
  })

  it('throws AuthMissing when no api key', async () => {
    const { AuthMissing } = await import('../../src/lib/errors.js')
    await expect(handleWhoami({ ...baseCfg(), apiKey: undefined })).rejects.toBeInstanceOf(AuthMissing)
  })
})

describe('auth logout — Margins API key path', () => {
  beforeEach(() => {
    _resetStore()
    clearGlobalConfig()
    setGlobalConfig({ apiKey: 'mrgn_testkey1234567', serverUrl: 'https://margins.example.com' })
  })
  afterEach(() => { vi.unstubAllGlobals(); _resetStore() })

  it('clears local config (no Keycloak session)', async () => {
    vi.stubGlobal('fetch', vi.fn())
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await handleLogout(baseCfg())
    expect(getGlobalConfig().apiKey).toBeUndefined()
  })

  it('preserves serverUrl after logout', async () => {
    vi.stubGlobal('fetch', vi.fn())
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await handleLogout(baseCfg())
    // serverUrl must survive logout — user should not need to re-run config set-url
    expect(getGlobalConfig().serverUrl).toBe('https://margins.example.com')
  })

  it('outputs JSON when json=true', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await handleLogout({ ...baseCfg(), json: true })
    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string)
    expect(parsed.loggedOut).toBe(true)
    spy.mockRestore()
  })

  it('throws AuthMissing when no api key and no refresh token', async () => {
    const { AuthMissing } = await import('../../src/lib/errors.js')
    await expect(handleLogout({ ...baseCfg(), apiKey: undefined, refreshToken: undefined })).rejects.toBeInstanceOf(AuthMissing)
  })

  it('allows logout when access token is expired but refresh token is still present', async () => {
    // Simulates the state where the access token expired but the refresh token is valid.
    // Logout should clear the session, not throw AuthMissing.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cfg = { ...baseCfg(), apiKey: undefined, refreshToken: 'still-valid-refresh' }
    // Should not throw AuthMissing
    await expect(handleLogout(cfg)).resolves.toBeUndefined()
    expect(getGlobalConfig().refreshToken).toBeUndefined()
  })
})

describe('auth logout — Keycloak token path', () => {
  beforeEach(() => {
    _resetStore()
    clearGlobalConfig()
    setGlobalConfig({
      accessToken: 'eyJhbGciOiJSUzI1NiJ9.test.token',
      refreshToken: 'refresh_token_value',
      accessTokenExpiresAt: Date.now() + 5 * 60 * 1000,
      keycloakIssuer: 'https://keycloak.example.com/realms/margins',
      keycloakClientId: 'margins-cli',
    })
  })
  afterEach(() => { vi.unstubAllGlobals(); _resetStore() })

  it('attempts Keycloak revocation and clears local config', async () => {
    const fetchMock = vi.fn()
      // OIDC discovery
      .mockResolvedValueOnce(new Response(JSON.stringify({
        issuer: 'https://keycloak.example.com/realms/margins',
        revocation_endpoint: 'https://keycloak.example.com/realms/margins/protocol/openid-connect/revoke',
        token_endpoint: 'https://keycloak.example.com/realms/margins/protocol/openid-connect/token',
        jwks_uri: 'https://keycloak.example.com/realms/margins/protocol/openid-connect/certs',
      }), { status: 200 }))
      // revocation call
      .mockResolvedValueOnce(new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await handleLogout(keycloakCfg())

    expect(getGlobalConfig().accessToken).toBeUndefined()
    expect(getGlobalConfig().refreshToken).toBeUndefined()
  })

  it('still clears local config if Keycloak revocation fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await handleLogout(keycloakCfg())

    expect(getGlobalConfig().accessToken).toBeUndefined()
    expect(getGlobalConfig().refreshToken).toBeUndefined()
  })
})
