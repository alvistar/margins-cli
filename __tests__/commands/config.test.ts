import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { clearGlobalConfig, _resetStore, setGlobalConfig, getGlobalConfig } from '../../src/lib/config.js'
import { handleShow } from '../../src/commands/config/show.js'
import { handleSetKey } from '../../src/commands/config/set-key.js'
import { handleSetUrl } from '../../src/commands/config/set-url.js'
import * as os from 'node:os'

// Isolate conf store to a unique directory per test file
vi.stubEnv('MARGINS_CONFIG_DIR', os.tmpdir() + '/margins-config-test')

describe('config set-key', () => {
  beforeEach(() => { _resetStore(); clearGlobalConfig() })
  afterEach(() => { vi.unstubAllEnvs(); _resetStore() })

  it('stores API key in global config', () => {
    handleSetKey('mrgn_newkey123')
    expect(getGlobalConfig().apiKey).toBe('mrgn_newkey123')
  })
})

describe('config set-url', () => {
  beforeEach(() => { _resetStore(); clearGlobalConfig() })
  afterEach(() => { vi.unstubAllEnvs(); _resetStore() })

  it('stores server URL in global config', () => {
    handleSetUrl('https://self-hosted.example.com')
    expect(getGlobalConfig().serverUrl).toBe('https://self-hosted.example.com')
  })
})

describe('config show', () => {
  beforeEach(() => { _resetStore(); clearGlobalConfig() })
  afterEach(() => { vi.unstubAllEnvs(); _resetStore() })

  it('masks the API key in output', () => {
    setGlobalConfig({ apiKey: 'mrgn_abcdefghijklmnop', serverUrl: 'https://margins.app' })
    const output = handleShow({ json: false })
    expect(output).toContain('mrgn_...nop')
    expect(output).not.toContain('mrgn_abcdefghijklmnop')
  })

  it('shows login hint when empty', () => {
    const output = handleShow({ json: false })
    expect(output).toContain('margins auth login')
  })

  it('outputs JSON when json=true', () => {
    setGlobalConfig({ apiKey: 'mrgn_testkey1234567', serverUrl: 'https://margins.app' })
    const output = handleShow({ json: true })
    const parsed = JSON.parse(output)
    expect(parsed).toHaveProperty('apiKey')
    expect(parsed).toHaveProperty('serverUrl')
    // key should be masked even in JSON
    expect(parsed.apiKey).not.toBe('mrgn_testkey1234567')
  })

  it('shows active Keycloak token session in JSON output', () => {
    setGlobalConfig({ accessToken: 'eyJhbGciOi.test.token', serverUrl: 'https://margins.app' })
    const output = handleShow({ json: true })
    const parsed = JSON.parse(output)
    expect(parsed.apiKey).not.toBe('(not set)')
    expect(parsed.apiKey).toContain('...')
  })
})
