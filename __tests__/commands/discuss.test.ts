import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'

vi.stubEnv('MARGINS_CONFIG_DIR', os.tmpdir() + '/margins-cmd-test')

const baseCfg = () => ({
  apiKey: 'mrgn_test', serverUrl: 'https://margins.example.com',
  json: false, verbose: false, noColor: false,
})

const mockWorkspace = { id: 'ws-uuid' }
const mockDiscussion = { id: 'disc-uuid', path: 'README.md', body: 'Test', status: 'open', authorName: 'Agent', anchorHeadingText: 'Setup' }

describe('discuss list', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(mockWorkspace), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([mockDiscussion]), { status: 200 })),
    )
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('lists discussions as table', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { handleDiscussList } = await import('../../src/commands/discuss/list.js')
    await handleDiscussList(baseCfg(), 'gh/owner/repo', {})
    expect(spy.mock.calls.map((c) => c.join('')).join('')).toContain('Setup')
    expect(spy.mock.calls.map((c) => c.join('')).join('')).toContain('README.md')
    expect(spy.mock.calls.map((c) => c.join('')).join('')).toContain('open')
    spy.mockRestore()
  })

  it('outputs JSON when json=true', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { handleDiscussList } = await import('../../src/commands/discuss/list.js')
    await handleDiscussList({ ...baseCfg(), json: true }, 'gh/owner/repo', {})
    expect(() => JSON.parse(spy.mock.calls[0]?.[0] as string)).not.toThrow()
    spy.mockRestore()
  })
})

describe('discuss create', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(mockWorkspace), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'new-disc' }), { status: 200 })),
    )
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('creates discussion with heading anchor', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(mockWorkspace), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'new-disc' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { handleDiscussCreate } = await import('../../src/commands/discuss/create.js')
    await handleDiscussCreate(baseCfg(), 'gh/owner/repo', { path: 'README.md', body: 'Needs detail', anchorHeading: 'Setup' })
    const createCall = fetchMock.mock.calls[1]
    expect(createCall?.[1]?.body).toContain('Setup')
    spy.mockRestore()
  })

  it('throws ValidationError when no slug and no .margins.json', async () => {
    const { handleDiscussCreate } = await import('../../src/commands/discuss/create.js')
    const { ValidationError } = await import('../../src/lib/errors.js')
    await expect(handleDiscussCreate(baseCfg(), undefined, { path: 'README.md', body: 'body' })).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('discuss reply', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('posts reply to discussion', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(mockWorkspace), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'reply-id' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { handleDiscussReply } = await import('../../src/commands/discuss/reply.js')
    await handleDiscussReply(baseCfg(), 'disc-id', { body: 'Good point', workspace: 'gh/owner/repo' })
    const replyCall = fetchMock.mock.calls[1]
    expect(replyCall?.[0] as string).toContain('/reply')
    spy.mockRestore()
  })

  it('throws when no workspace context', async () => {
    const { handleDiscussReply } = await import('../../src/commands/discuss/reply.js')
    const { ValidationError } = await import('../../src/lib/errors.js')
    await expect(handleDiscussReply(baseCfg(), 'disc-id', { body: 'hello' })).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('discuss resolve', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('patches discussion with resolved status', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(mockWorkspace), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'disc-id', status: 'resolved' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { handleDiscussResolve } = await import('../../src/commands/discuss/resolve.js')
    await handleDiscussResolve(baseCfg(), 'disc-id', { summary: 'Fixed in 1a2b3c', workspace: 'gh/owner/repo' })
    const patchCall = fetchMock.mock.calls[1]
    expect(patchCall?.[1]?.body).toContain('resolved')
    spy.mockRestore()
  })

  it('prints already resolved on conflict', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: mockWorkspace }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'RESOLVE_FAILED', message: 'Discussion is already resolved.' }), { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { handleDiscussResolve } = await import('../../src/commands/discuss/resolve.js')
    await handleDiscussResolve(baseCfg(), 'disc-id', { summary: 'ignored', workspace: 'gh/owner/repo' })
    expect(spy.mock.calls.map((c) => c.join('')).join('')).toContain('already resolved')
    spy.mockRestore()
  })
})
