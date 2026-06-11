import { describe, it, expect } from 'vitest'
import { hasOidcAuth } from '../src/lib/auth-env.js'

describe('hasOidcAuth — OIDC satisfies the preAction auth gate without an api key', () => {
  it('true when MARGINS_OIDC_TOKEN is set', () => {
    expect(hasOidcAuth({ MARGINS_OIDC_TOKEN: 'eyJ.a.b' })).toBe(true)
  })

  it('true when both Actions token-request env vars are present (CLI can mint)', () => {
    expect(
      hasOidcAuth({
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines/idtoken',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'reqtok',
      }),
    ).toBe(true)
  })

  it('false when only one Actions env var is present (cannot mint)', () => {
    expect(hasOidcAuth({ ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines/idtoken' })).toBe(false)
    expect(hasOidcAuth({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'reqtok' })).toBe(false)
  })

  it('false with no OIDC env (api key remains required)', () => {
    expect(hasOidcAuth({})).toBe(false)
  })
})
