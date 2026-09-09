/**
 * `resolveCredential` — what a background caller is allowed to use.
 *
 * The rule that matters is a REFUSAL: a Keycloak session is not a credential a
 * daemon may ride. Asserting only the happy path would leave the whole point
 * untested, because falling back to `accessToken` would still make that path
 * pass.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _resetStore, getConfigDir, resolveCredential, setGlobalConfig, DEFAULT_SERVER_URL } from '../src/config-store.js'

let dir: string
const saved = { ...process.env }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-cred-'))
  process.env['MARGINS_CONFIG_DIR'] = dir
  delete process.env['MARGINS_API_KEY']
  delete process.env['MARGINS_SERVER_URL']
  _resetStore()
})

afterEach(() => {
  process.env = { ...saved }
  _resetStore()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('resolveCredential', () => {
  it('uses the stored API key', () => {
    setGlobalConfig({ apiKey: 'mrgn_stored', serverUrl: 'https://margins.test' })
    expect(resolveCredential()).toEqual({ ok: true, apiKey: 'mrgn_stored', serverUrl: 'https://margins.test' })
  })

  it('lets MARGINS_API_KEY win over the stored key', () => {
    setGlobalConfig({ apiKey: 'mrgn_stored' })
    process.env['MARGINS_API_KEY'] = 'mrgn_env'
    expect(resolveCredential()).toMatchObject({ ok: true, apiKey: 'mrgn_env' })
  })

  it('REFUSES a Keycloak-only session rather than sending its access token', () => {
    // The daemon cannot refresh one and cannot prompt when the refresh fails, so
    // riding it would turn a working button into an intermittent 401 whose remedy
    // nothing on screen names.
    setGlobalConfig({ accessToken: 'kc_access', refreshToken: 'kc_refresh' })
    expect(resolveCredential()).toMatchObject({ ok: false, problem: 'SESSION_ONLY' })
  })

  it('distinguishes "never logged in" from "logged in without a key"', () => {
    expect(resolveCredential()).toMatchObject({ ok: false, problem: 'NO_API_KEY' })
  })

  it('falls back to the production server URL when nothing configures one', () => {
    expect(resolveCredential().serverUrl).toBe(DEFAULT_SERVER_URL)
  })

  it('resolves the config dir from MARGINS_CONFIG_DIR', () => {
    expect(getConfigDir()).toBe(dir)
  })
})
