import type { ResolvedConfig } from '../../lib/config.js'
import { readLocalConfig } from '../../lib/config.js'
import { createApiClient } from '../../lib/api-client.js'
import { formatJson } from '../../lib/output.js'
import { ValidationError, ConflictError, NotFoundError, DiscussionNotFoundError } from '../../lib/errors.js'
import { resolveWorkspaceBySlug } from '../../lib/resolve-workspace.js'

export async function handleDiscussResolve(
  cfg: ResolvedConfig,
  discussionId: string,
  opts: { summary?: string; workspace?: string },
): Promise<void> {
  const resolvedSlug = opts.workspace ?? readLocalConfig()?.workspace_slug
  if (!resolvedSlug) {
    throw new ValidationError('No workspace specified. Pass --workspace <slug> or create .margins.json')
  }

  const client = createApiClient(cfg)
  const workspace = await resolveWorkspaceBySlug(client, resolvedSlug)

  let updated: unknown
  try {
    updated = await client.patch(
      `/api/workspaces/${workspace.id}/discussions/${discussionId}`,
      { status: 'resolved', resolutionSummary: opts.summary ?? '' },
    )
  } catch (err) {
    if (err instanceof ConflictError) {
      console.log(`Discussion ${discussionId} is already resolved.`)
      return
    }
    if (err instanceof NotFoundError) throw new DiscussionNotFoundError(discussionId)
    throw err
  }

  if (cfg.json) {
    console.log(formatJson(updated))
    return
  }

  console.log(`Discussion ${discussionId} resolved.`)
}
