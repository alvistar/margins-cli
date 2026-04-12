import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handlePush } from '../src/commands/workspace/push.js'
import type { ResolvedConfig } from '../src/lib/config.js'

const mockPost = vi.fn()

vi.mock('../src/lib/api-client.js', () => ({
  createApiClient: () => ({ post: mockPost }),
}))

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    serverUrl: 'https://margins.test',
    token: 'test-token',
    json: false,
    verbose: false,
    ...overrides,
  } as ResolvedConfig
}

describe('handlePush', () => {
  beforeEach(() => {
    mockPost.mockReset()
  })

  it('throws when neither --workspace nor --project given', async () => {
    await expect(handlePush(makeConfig(), {})).rejects.toThrow('Specify --workspace')
  })

  it('creates workspace when --project given', async () => {
    mockPost
      .mockResolvedValueOnce({ workspace: { id: 'ws-new', slug: 'local/user/my-docs' } }) // create
      .mockResolvedValueOnce({ added: 2, changed: 0, skipped: 0 }) // ingest

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await handlePush(makeConfig(), {
      project: 'my-docs',
      dir: `${import.meta.dirname}/fixtures/docs`,
    })

    // First call creates workspace
    expect(mockPost).toHaveBeenCalledWith('/api/workspaces', {
      name: 'my-docs',
      source: 'local',
      projectName: 'my-docs',
    })

    // Second call pushes files
    expect(mockPost).toHaveBeenCalledWith('/api/workspaces/ws-new/ingest', expect.objectContaining({
      files: expect.any(Array),
    }))

    consoleSpy.mockRestore()
  })

  it('pushes to existing workspace with --workspace', async () => {
    mockPost.mockResolvedValueOnce({ added: 1, changed: 0, skipped: 0 })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await handlePush(makeConfig(), {
      workspace: 'ws-existing',
      dir: `${import.meta.dirname}/fixtures/docs`,
    })

    expect(mockPost).toHaveBeenCalledWith('/api/workspaces/ws-existing/ingest', expect.objectContaining({
      files: expect.any(Array),
    }))

    consoleSpy.mockRestore()
  })

  it('throws when no .md files found', async () => {
    await expect(
      handlePush(makeConfig(), { workspace: 'ws-1', dir: `${import.meta.dirname}/fixtures/empty` })
    ).rejects.toThrow('No .md files found')
  })

  it('outputs JSON when --json flag set', async () => {
    mockPost.mockResolvedValueOnce({ added: 1, changed: 0, skipped: 0 })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await handlePush(makeConfig({ json: true }), {
      workspace: 'ws-1',
      dir: `${import.meta.dirname}/fixtures/docs`,
    })

    const output = consoleSpy.mock.calls[0][0]
    expect(JSON.parse(output)).toEqual({ added: 1, changed: 0, skipped: 0 })

    consoleSpy.mockRestore()
  })

  // ─── D-023: anchor lifecycle counts in CLI output ──────────────────────────

  it('omits anchor lifecycle counts in human output when all zero', async () => {
    mockPost.mockResolvedValueOnce({
      added: 2,
      changed: 0,
      skipped: 0,
      addressed: 0,
      orphaned: 0,
      moved: 0,
    })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await handlePush(makeConfig(), {
      workspace: 'ws-1',
      dir: `${import.meta.dirname}/fixtures/docs`,
    })

    const output = consoleSpy.mock.calls[0][0]
    expect(output).toBe('Pushed: 2 added, 0 changed, 0 skipped')
    expect(output).not.toMatch(/addressed|orphaned|moved/)

    consoleSpy.mockRestore()
  })

  it('shows anchor lifecycle counts in human output when non-zero', async () => {
    mockPost.mockResolvedValueOnce({
      added: 0,
      changed: 1,
      skipped: 0,
      addressed: 2,
      orphaned: 1,
      moved: 3,
    })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await handlePush(makeConfig(), {
      workspace: 'ws-1',
      dir: `${import.meta.dirname}/fixtures/docs`,
    })

    const output = consoleSpy.mock.calls[0][0]
    expect(output).toBe('Pushed: 0 added, 1 changed, 0 skipped (2 addressed, 1 orphaned, 3 moved)')

    consoleSpy.mockRestore()
  })

  // ─── D-006: workspace metadata in --project --json output ─────────────────

  it('includes workspace metadata in push result JSON when --project --json', async () => {
    mockPost
      .mockResolvedValueOnce({ workspace: { id: 'ws-new', slug: 'local/user/my-docs' } })
      .mockResolvedValueOnce({ added: 2, changed: 0, skipped: 0 })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await handlePush(makeConfig({ json: true }), {
      project: 'my-docs',
      dir: `${import.meta.dirname}/fixtures/docs`,
    })

    // First call: creation JSON (unchanged)
    const creationOutput = JSON.parse(consoleSpy.mock.calls[0][0])
    expect(creationOutput).toEqual({ created: true, workspaceId: 'ws-new', slug: 'local/user/my-docs' })

    // Second call: push result includes workspace metadata
    const pushOutput = JSON.parse(consoleSpy.mock.calls[1][0])
    expect(pushOutput).toMatchObject({
      added: 2, changed: 0, skipped: 0,
      workspaceId: 'ws-new', slug: 'local/user/my-docs',
    })

    consoleSpy.mockRestore()
  })

  it('does not include workspace metadata in push result JSON when --workspace', async () => {
    mockPost.mockResolvedValueOnce({ added: 1, changed: 0, skipped: 0 })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await handlePush(makeConfig({ json: true }), {
      workspace: 'ws-existing',
      dir: `${import.meta.dirname}/fixtures/docs`,
    })

    const output = JSON.parse(consoleSpy.mock.calls[0][0])
    expect(output).toEqual({ added: 1, changed: 0, skipped: 0 })
    expect(output).not.toHaveProperty('workspaceId')
    expect(output).not.toHaveProperty('slug')

    consoleSpy.mockRestore()
  })

  it('keeps human-readable output unchanged for --project without --json', async () => {
    mockPost
      .mockResolvedValueOnce({ workspace: { id: 'ws-new', slug: 'local/user/my-docs' } })
      .mockResolvedValueOnce({ added: 2, changed: 0, skipped: 0 })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await handlePush(makeConfig({ json: false }), {
      project: 'my-docs',
      dir: `${import.meta.dirname}/fixtures/docs`,
    })

    // Human output: creation info then push summary
    expect(consoleSpy.mock.calls[0][0]).toBe('Created workspace: local/user/my-docs')
    expect(consoleSpy.mock.calls[1][0]).toBe('Workspace ID: ws-new')
    expect(consoleSpy.mock.calls[2][0]).toBe('Pushed: 2 added, 0 changed, 0 skipped')

    consoleSpy.mockRestore()
  })

  it('passes anchor lifecycle counts through unchanged in JSON output', async () => {
    mockPost.mockResolvedValueOnce({
      added: 0,
      changed: 1,
      skipped: 0,
      addressed: 2,
      orphaned: 0,
      moved: 1,
    })

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await handlePush(makeConfig({ json: true }), {
      workspace: 'ws-1',
      dir: `${import.meta.dirname}/fixtures/docs`,
    })

    const output = consoleSpy.mock.calls[0][0]
    expect(JSON.parse(output)).toEqual({
      added: 0,
      changed: 1,
      skipped: 0,
      addressed: 2,
      orphaned: 0,
      moved: 1,
    })

    consoleSpy.mockRestore()
  })

  // ─── D-007: error-path tests at handlePush level ────────────────────────────

  it('propagates AuthExpired when workspace creation returns 401', async () => {
    const { AuthExpired } = await import('../src/lib/errors.js')
    mockPost.mockRejectedValueOnce(new AuthExpired())

    await expect(
      handlePush(makeConfig(), { project: 'my-docs', dir: `${import.meta.dirname}/fixtures/docs` })
    ).rejects.toThrow('API key expired')
  })

  it('propagates ConflictError when workspace name already taken', async () => {
    const { ConflictError } = await import('../src/lib/errors.js')
    mockPost.mockRejectedValueOnce(new ConflictError('Conflict while calling /api/workspaces'))

    await expect(
      handlePush(makeConfig(), { project: 'my-docs', dir: `${import.meta.dirname}/fixtures/docs` })
    ).rejects.toThrow('Conflict')
  })

  it('propagates ServerError when ingest returns 413', async () => {
    const { ServerError } = await import('../src/lib/errors.js')
    mockPost
      .mockResolvedValueOnce({ workspace: { id: 'ws-1', slug: 'local/user/my-docs' } })
      .mockRejectedValueOnce(new ServerError(413))

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(
      handlePush(makeConfig(), { project: 'my-docs', dir: `${import.meta.dirname}/fixtures/docs` })
    ).rejects.toThrow('Server error')

    consoleSpy.mockRestore()
  })

  it('propagates TimeoutError when ingest times out', async () => {
    const { TimeoutError } = await import('../src/lib/errors.js')
    mockPost
      .mockResolvedValueOnce({ workspace: { id: 'ws-1', slug: 'local/user/my-docs' } })
      .mockRejectedValueOnce(new TimeoutError())

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(
      handlePush(makeConfig(), { project: 'my-docs', dir: `${import.meta.dirname}/fixtures/docs` })
    ).rejects.toThrow('Request timed out')

    consoleSpy.mockRestore()
  })
})
