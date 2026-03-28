import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

vi.stubEnv('MARGINS_CONFIG_DIR', os.tmpdir() + '/margins-cmd-test')

const baseCfg = () => ({
  apiKey: 'mrgn_test', serverUrl: 'https://margins.example.com',
  json: false, verbose: false, noColor: false,
})

describe('workspace list', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('displays workspaces as table', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify([{ id: '1', slug: 'gh/a/b', name: 'A/B', syncStatus: 'synced' }]), { status: 200 },
    )))
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { handleList } = await import('../../src/commands/workspace/list.js')
    await handleList(baseCfg())
    expect(spy.mock.calls.map((c) => c.join('')).join('')).toContain('gh/a/b')
    spy.mockRestore()
  })

  it('shows hint when no workspaces', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 })))
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { handleList } = await import('../../src/commands/workspace/list.js')
    await handleList(baseCfg())
    expect(spy.mock.calls.map((c) => c.join('')).join('')).toContain('margins workspace create')
    spy.mockRestore()
  })

  it('outputs JSON when json=true', async () => {
    const ws = [{ id: '1', slug: 'gh/a/b', name: 'A/B', syncStatus: 'synced' }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(ws), { status: 200 })))
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { handleList } = await import('../../src/commands/workspace/list.js')
    await handleList({ ...baseCfg(), json: true })
    expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toEqual(ws)
    spy.mockRestore()
  })
})

describe('workspace create', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('creates workspace and shows slug', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: '1', slug: 'gh/owner/repo', name: 'repo' }), { status: 200 },
    )))
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { handleCreate } = await import('../../src/commands/workspace/create.js')
    await handleCreate(baseCfg(), 'https://github.com/owner/repo')
    expect(spy.mock.calls.map((c) => c.join('')).join('')).toContain('gh/owner/repo')
    spy.mockRestore()
  })

  it('handles server response shape with nested workspace object', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ workspace: { id: '1', slug: 'gh/owner/repo', name: 'repo' }, tree: [], autoJoined: false }),
      { status: 200 },
    )))
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { handleCreate } = await import('../../src/commands/workspace/create.js')
    await handleCreate(baseCfg(), 'https://github.com/owner/repo')
    expect(spy.mock.calls.map((c) => c.join('')).join('')).toContain('gh/owner/repo')
    spy.mockRestore()
  })

  it('throws ValidationError for invalid URL', async () => {
    const { handleCreate } = await import('../../src/commands/workspace/create.js')
    const { ValidationError } = await import('../../src/lib/errors.js')
    await expect(handleCreate(baseCfg(), 'not-a-url')).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('workspace open', () => {
  let tmpDir: string
  let originalCwd: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-test-'))
    originalCwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('opens browser with server url + slug', async () => {
    const openMock = vi.fn().mockResolvedValue(undefined)
    vi.doMock('open', () => ({ default: openMock }))
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { handleOpen } = await import('../../src/commands/workspace/open.js')
    await handleOpen(baseCfg(), 'gh/owner/repo')
    expect(spy.mock.calls.map((c) => c.join('')).join('')).toContain('/w/gh/owner/repo')
    spy.mockRestore()
  })

  it('auto-detects slug from .margins.json', async () => {
    fs.writeFileSync(path.join(tmpDir, '.margins.json'), JSON.stringify({ workspace_slug: 'gh/auto/detect' }))
    process.chdir(tmpDir)
    const openMock = vi.fn().mockResolvedValue(undefined)
    vi.doMock('open', () => ({ default: openMock }))
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { handleOpen } = await import('../../src/commands/workspace/open.js')
    await handleOpen(baseCfg(), undefined)
    expect(spy.mock.calls.map((c) => c.join('')).join('')).toContain('gh/auto/detect')
    spy.mockRestore()
  })

  it('throws ValidationError when no slug and no .margins.json', async () => {
    process.chdir(tmpDir)
    const { handleOpen } = await import('../../src/commands/workspace/open.js')
    const { ValidationError } = await import('../../src/lib/errors.js')
    await expect(handleOpen(baseCfg(), undefined)).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('workspace sync', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('resolves slug via by-slug endpoint and posts sync', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'ws-uuid' }), { status: 200 })) // by-slug
      .mockResolvedValueOnce(new Response(JSON.stringify({ artifactsUpdated: 5 }), { status: 200 })) // sync
    vi.stubGlobal('fetch', fetchMock)
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { handleSync } = await import('../../src/commands/workspace/sync.js')
    await handleSync({ ...baseCfg(), json: true }, 'gh/owner/repo', undefined)
    const [firstCall] = fetchMock.mock.calls
    expect((firstCall?.[0] as string)).toContain('by-slug/gh/owner/repo')
    spy.mockRestore()
  })

  it('passes branch in sync body', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'ws-uuid' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ artifactsUpdated: 0 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { handleSync } = await import('../../src/commands/workspace/sync.js')
    await handleSync({ ...baseCfg(), json: true }, 'gh/owner/repo', 'feature/xyz')
    const syncCall = fetchMock.mock.calls[1]
    expect(syncCall?.[1]?.body).toContain('feature/xyz')
  })

  it('prints already-in-progress JSON payload on sync conflict', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 'ws-uuid' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'SYNC_IN_PROGRESS', message: 'Sync already in progress' }), { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { handleSync } = await import('../../src/commands/workspace/sync.js')
    await handleSync({ ...baseCfg(), json: true }, 'gh/owner/repo', undefined)
    const output = spy.mock.calls.map((c) => c.join('')).join(' ')
    expect(output).toContain('already_running')
    expect(output).toContain('already in progress')
    spy.mockRestore()
  })
})
