import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resolveConfig, readLocalConfig, setGlobalConfig, getGlobalConfig, clearGlobalConfig, _resetStore } from '../src/lib/config.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// Isolate conf store to a unique directory per test file
vi.stubEnv('MARGINS_CONFIG_DIR', os.tmpdir() + '/margins-config-unit-test')

describe('config module exports', () => {
  it('exports resolveConfig', () => {
    expect(resolveConfig).toBeDefined()
    expect(typeof resolveConfig).toBe('function')
  })

  it('exports readLocalConfig', () => {
    expect(readLocalConfig).toBeDefined()
    expect(typeof readLocalConfig).toBe('function')
  })
})

describe('readLocalConfig', () => {
  let tmpDir: string
  let originalCwd: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-test-'))
    originalCwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null when no .margins.json found', () => {
    process.chdir(tmpDir)
    expect(readLocalConfig()).toBeNull()
  })

  it('reads .margins.json from cwd', () => {
    fs.writeFileSync(path.join(tmpDir, '.margins.json'), JSON.stringify({ workspace_slug: 'gh/owner/repo' }))
    process.chdir(tmpDir)
    const config = readLocalConfig()
    expect(config).toEqual({ workspace_slug: 'gh/owner/repo' })
  })

  it('walks up directories to find .margins.json', () => {
    fs.writeFileSync(path.join(tmpDir, '.margins.json'), JSON.stringify({ workspace_slug: 'gh/owner/repo' }))
    const subDir = path.join(tmpDir, 'src', 'lib')
    fs.mkdirSync(subDir, { recursive: true })
    process.chdir(subDir)
    const config = readLocalConfig()
    expect(config).toEqual({ workspace_slug: 'gh/owner/repo' })
  })

  it('throws ConfigParseError on malformed .margins.json', () => {
    fs.writeFileSync(path.join(tmpDir, '.margins.json'), 'not-valid-json{')
    process.chdir(tmpDir)
    expect(() => readLocalConfig()).toThrow()
  })
})

describe('resolveConfig', () => {
  beforeEach(() => {
    // Reset store so it re-reads the temp MARGINS_CONFIG_DIR location
    _resetStore()
    clearGlobalConfig()
    vi.stubEnv('MARGINS_API_KEY', '')
    vi.stubEnv('MARGINS_SERVER_URL', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    _resetStore()
  })

  it('CLI flag overrides env var and stored config', () => {
    vi.stubEnv('MARGINS_API_KEY', 'env_key')
    const resolved = resolveConfig({ apiKey: 'flag_key', serverUrl: undefined, json: false, verbose: false, noColor: false })
    expect(resolved.apiKey).toBe('flag_key')
  })

  it('env var used when no CLI flag', () => {
    vi.stubEnv('MARGINS_API_KEY', 'env_key')
    const resolved = resolveConfig({ apiKey: undefined, serverUrl: undefined, json: false, verbose: false, noColor: false })
    expect(resolved.apiKey).toBe('env_key')
  })

  it('returns undefined apiKey when nothing set', () => {
    const resolved = resolveConfig({ apiKey: undefined, serverUrl: undefined, json: false, verbose: false, noColor: false })
    expect(resolved.apiKey).toBeUndefined()
  })

  it('serverUrl defaults to https://margins.app when nothing set', () => {
    const resolved = resolveConfig({ apiKey: undefined, serverUrl: undefined, json: false, verbose: false, noColor: false })
    expect(resolved.serverUrl).toBe('https://margins.app')
  })

  it('CLI serverUrl overrides env', () => {
    vi.stubEnv('MARGINS_SERVER_URL', 'https://env.example.com')
    const resolved = resolveConfig({ apiKey: undefined, serverUrl: 'https://flag.example.com', json: false, verbose: false, noColor: false })
    expect(resolved.serverUrl).toBe('https://flag.example.com')
  })
})
