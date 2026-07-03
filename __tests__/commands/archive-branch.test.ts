import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ResolvedConfig } from '../../src/lib/config.js'
import { handleArchiveBranch } from '../../src/commands/workspace/archive-branch.js'
import { ValidationError } from '../../src/lib/errors.js'

const mockPost = vi.fn()
vi.mock('../../src/lib/api-client.js', () => ({
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

describe('handleArchiveBranch', () => {
  beforeEach(() => {
    mockPost.mockReset()
    vi.restoreAllMocks()
  })

  it('posts the branch to the archive endpoint and reports success', async () => {
    mockPost.mockResolvedValue({ branch: 'feat/x', archived: true })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await handleArchiveBranch(makeConfig(), { workspace: 'ws-1', branch: 'feat/x' })
    expect(mockPost).toHaveBeenCalledWith('/api/workspaces/ws-1/branches/archive', { branch: 'feat/x' })
    expect(log).toHaveBeenCalledWith('Archived branch: feat/x')
  })

  it('reports a no-op when the branch was unknown or already archived', async () => {
    mockPost.mockResolvedValue({ branch: 'feat/gone', archived: false })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await handleArchiveBranch(makeConfig(), { workspace: 'ws-1', branch: 'feat/gone' })
    expect(log).toHaveBeenCalledWith('Branch not found or already archived: feat/gone (no-op)')
  })

  it('prints the raw result in json mode', async () => {
    mockPost.mockResolvedValue({ branch: 'feat/x', archived: true })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await handleArchiveBranch(makeConfig({ json: true }), { workspace: 'ws-1', branch: 'feat/x' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"archived": true'))
  })

  it('prints the no-op result in json mode (archived:false)', async () => {
    mockPost.mockResolvedValue({ branch: 'feat/gone', archived: false })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await handleArchiveBranch(makeConfig({ json: true }), { workspace: 'ws-1', branch: 'feat/gone' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"archived": false'))
  })

  it('throws ValidationError when --workspace is missing (no request sent)', async () => {
    await expect(handleArchiveBranch(makeConfig(), { branch: 'feat/x' })).rejects.toThrow(ValidationError)
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('throws ValidationError when --branch is missing (no request sent)', async () => {
    await expect(handleArchiveBranch(makeConfig(), { workspace: 'ws-1' })).rejects.toThrow(ValidationError)
    expect(mockPost).not.toHaveBeenCalled()
  })
})
