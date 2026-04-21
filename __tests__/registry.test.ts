import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { readRegistry, writeRegistry, addRepo, normalize, registryPath } from '../src/lib/registry.js'

describe('registry', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-test-'))
    process.env['MARGINS_DATA_DIR'] = tmpDir
  })

  afterEach(() => {
    delete process.env['MARGINS_DATA_DIR']
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('registryPath uses MARGINS_DATA_DIR override', () => {
    expect(registryPath()).toBe(path.join(tmpDir, 'repos.json'))
  })

  it('readRegistry returns empty when file does not exist', () => {
    expect(readRegistry()).toEqual({ repos: [] })
  })

  it('readRegistry returns empty on malformed JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'repos.json'), 'not json', 'utf-8')
    expect(readRegistry()).toEqual({ repos: [] })
  })

  it('writeRegistry + readRegistry round-trip', () => {
    const registry = {
      repos: [{
        path: '/test/folder',
        workspaceId: 'ws-1',
        slug: 'test-slug',
        branch: 'main',
        enabled: true,
      }],
    }
    writeRegistry(registry)
    expect(readRegistry()).toEqual(registry)
  })

  it('writeRegistry is atomic (tmp file does not persist)', () => {
    writeRegistry({ repos: [] })
    const tmpPath = path.join(tmpDir, 'repos.json.tmp')
    expect(fs.existsSync(tmpPath)).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, 'repos.json'))).toBe(true)
  })

  it('addRepo deduplicates by resolved path', () => {
    const registry = { repos: [{ path: '/test/folder', workspaceId: 'ws-1', slug: 's', branch: 'main', enabled: true }] }
    const added = addRepo(registry, { path: '/test/folder/', workspaceId: 'ws-2', slug: 's2', branch: 'main', enabled: true })
    expect(added).toBe(false)
    expect(registry.repos).toHaveLength(1)
  })

  it('addRepo adds new entry', () => {
    const registry = { repos: [] }
    const added = addRepo(registry, { path: '/new/path', workspaceId: 'ws-1', slug: 's', branch: 'main', enabled: true })
    expect(added).toBe(true)
    expect(registry.repos).toHaveLength(1)
  })
})

describe('normalize', () => {
  it('resolves to absolute path', () => {
    const result = normalize('.')
    expect(path.isAbsolute(result)).toBe(true)
  })

  it('strips trailing slashes', () => {
    expect(normalize('/foo/bar/')).toBe('/foo/bar')
  })
})
