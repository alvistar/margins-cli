import type { ApiClient } from './api-client.js'
import { NotFoundError, WorkspaceNotFoundError } from './errors.js'

interface WorkspaceRef {
  id: string
  defaultBranch?: string
}

/**
 * Resolve a workspace slug to its { id } by calling GET /api/workspaces/by-slug/:slug.
 *
 * Handles both response shapes the server has returned:
 *   - flat:    { id, slug, ... }
 *   - wrapped: { workspace: { id, slug, ... } }
 *
 * Throws WorkspaceNotFoundError if:
 *   - the server returns 404
 *   - the response is present but contains no id (unexpected shape)
 */
export async function resolveWorkspaceBySlug(
  client: ApiClient,
  slug: string,
): Promise<WorkspaceRef> {
  let raw: unknown
  try {
    raw = await client.get(`/api/workspaces/by-slug/${slug}`)
  } catch (err) {
    if (err instanceof NotFoundError) throw new WorkspaceNotFoundError(slug)
    throw err
  }

  // Unwrap either response shape
  const workspace =
    raw !== null &&
    typeof raw === 'object' &&
    'workspace' in (raw as object) &&
    typeof (raw as { workspace: unknown }).workspace === 'object'
      ? (raw as { workspace: WorkspaceRef }).workspace
      : (raw as WorkspaceRef)

  // Validate: if id is missing the shape changed again — fail loudly
  if (!workspace?.id) {
    throw new WorkspaceNotFoundError(slug)
  }

  return workspace
}
