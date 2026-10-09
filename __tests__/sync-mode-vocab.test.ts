/**
 * The sync mode vocabulary (src/lib/sync-mode.ts): the CLI says push / pull
 * everywhere a person or a file sees it; the API keeps client / server. One
 * module owns the translation, and the deprecated file values.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  fromApiSyncMode, toApiSyncMode, parseFileSyncMode, readMarginsJson, upgradeDeprecatedSyncMode,
} from '../src/lib/sync-mode.js'

afterEach(() => {
  vi.restoreAllMocks()
})

function tmpFile(content: unknown): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-smv-'))
  const file = path.join(dir, '.margins.json')
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  return { dir, file }
}

describe('API values', () => {
  it('maps push/pull to client/server and back', () => {
    expect(toApiSyncMode('push')).toBe('client')
    expect(toApiSyncMode('pull')).toBe('server')
    expect(fromApiSyncMode('client')).toBe('push')
    expect(fromApiSyncMode('server')).toBe('pull')
  })

  it('an unknown or missing API value is null — never push', () => {
    expect(fromApiSyncMode(undefined)).toBeNull()
    expect(fromApiSyncMode(null)).toBeNull()
    expect(fromApiSyncMode('sideways')).toBeNull()
    // The CLI words are not API values.
    expect(fromApiSyncMode('push')).toBeNull()
    expect(fromApiSyncMode('pull')).toBeNull()
  })
})

describe('.margins.json values', () => {
  it('reads push/pull, and client/server as deprecated aliases', () => {
    expect(parseFileSyncMode('push')).toEqual({ mode: 'push' })
    expect(parseFileSyncMode('pull')).toEqual({ mode: 'pull' })
    expect(parseFileSyncMode('client')).toEqual({ mode: 'push', deprecated: 'client' })
    expect(parseFileSyncMode('server')).toEqual({ mode: 'pull', deprecated: 'server' })
  })

  it('anything else is not a sync mode', () => {
    expect(parseFileSyncMode(undefined)).toBeNull()
    expect(parseFileSyncMode('sideways')).toBeNull()
    expect(parseFileSyncMode(1)).toBeNull()
  })
})

describe('the deprecated-alias rewrite', () => {
  it('rewrites "client" to "push" in place, keeps other fields, and says so once on stderr', () => {
    const { dir, file } = tmpFile({ workspace_id: 'ws-1', syncMode: 'client', extra: 1 })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(upgradeDeprecatedSyncMode(file)).toBe(true)
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ workspace_id: 'ws-1', syncMode: 'push', extra: 1 })
      expect(err).toHaveBeenCalledTimes(1)
      expect(err.mock.calls[0]![0]).toBe('Updated .margins.json: "syncMode": "client" → "push" — commit it.')

      // Idempotent: the second read finds nothing to do and prints nothing.
      expect(upgradeDeprecatedSyncMode(file)).toBe(false)
      expect(err).toHaveBeenCalledTimes(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rewrites "server" to "pull"', () => {
    const { dir, file } = tmpFile({ syncMode: 'server' })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(upgradeDeprecatedSyncMode(file)).toBe(true)
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).syncMode).toBe('pull')
      expect(err.mock.calls[0]![0]).toBe('Updated .margins.json: "syncMode": "server" → "pull" — commit it.')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves new values, a missing file and a malformed file alone', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = tmpFile({ syncMode: 'push' })
    const b = tmpFile('{ not json')
    try {
      expect(upgradeDeprecatedSyncMode(a.file)).toBe(false)
      expect(upgradeDeprecatedSyncMode(path.join(a.dir, 'missing.json'))).toBe(false)
      expect(upgradeDeprecatedSyncMode(b.file)).toBe(false)
      expect(fs.readFileSync(b.file, 'utf8')).toBe('{ not json')
      expect(err).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(a.dir, { recursive: true, force: true })
      fs.rmSync(b.dir, { recursive: true, force: true })
    }
  })

  it('readMarginsJson returns the parsed file with the alias already rewritten', () => {
    const { dir, file } = tmpFile({ workspace_slug: 's', syncMode: 'client' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(readMarginsJson(file)).toEqual({ workspace_slug: 's', syncMode: 'push' })
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).syncMode).toBe('push')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readMarginsJson throws on a malformed file (callers decide what that means)', () => {
    const { dir, file } = tmpFile('{ nope')
    try {
      expect(() => readMarginsJson(file)).toThrow()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
