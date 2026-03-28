import { describe, it, expect, vi } from 'vitest'
import type { ApiClient } from '../src/lib/api-client.js'
import { NotFoundError, WorkspaceNotFoundError } from '../src/lib/errors.js'

// Import the helper that doesn't exist yet — tests should FAIL until implemented
import { resolveWorkspaceBySlug } from '../src/lib/resolve-workspace.js'

function makeClient(getImpl: (path: string) => Promise<unknown>): ApiClient {
  return {
    get: vi.fn().mockImplementation(getImpl),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }
}

describe('resolveWorkspaceBySlug', () => {
  it('returns the workspace id when the server returns a flat { id } shape', async () => {
    const client = makeClient(async () => ({ id: 'ws-flat-123', slug: 'gh/owner/repo' }))

    const workspace = await resolveWorkspaceBySlug(client, 'gh/owner/repo')

    expect(workspace.id).toBe('ws-flat-123')
  })

  it('returns the workspace id when the server wraps the response in { workspace: { id } }', async () => {
    const client = makeClient(async () => ({
      workspace: { id: 'ws-wrapped-456', slug: 'gh/owner/repo' },
    }))

    const workspace = await resolveWorkspaceBySlug(client, 'gh/owner/repo')

    expect(workspace.id).toBe('ws-wrapped-456')
  })

  it('calls GET /api/workspaces/by-slug/:slug with the provided slug', async () => {
    const mockGet = vi.fn().mockResolvedValue({ id: 'ws-xyz' })
    const client = makeClient(mockGet)

    await resolveWorkspaceBySlug(client, 'gh/myorg/myrepo')

    expect(mockGet).toHaveBeenCalledWith('/api/workspaces/by-slug/gh/myorg/myrepo')
  })

  it('throws WorkspaceNotFoundError when the server returns 404', async () => {
    const client = makeClient(async () => { throw new NotFoundError('/api/workspaces/by-slug/gh/x/y') })

    await expect(resolveWorkspaceBySlug(client, 'gh/x/y')).rejects.toThrow(WorkspaceNotFoundError)
  })

  it('throws WorkspaceNotFoundError when the response has no id field', async () => {
    // Unexpected shape — server changed the response format again
    const client = makeClient(async () => ({ slug: 'gh/owner/repo' }))

    await expect(resolveWorkspaceBySlug(client, 'gh/owner/repo')).rejects.toThrow(
      WorkspaceNotFoundError
    )
  })

  it('rethrows non-NotFound errors as-is', async () => {
    const client = makeClient(async () => { throw new Error('Network failure') })

    await expect(resolveWorkspaceBySlug(client, 'gh/owner/repo')).rejects.toThrow('Network failure')
  })
})
