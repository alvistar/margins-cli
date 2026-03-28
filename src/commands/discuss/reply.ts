import type { ResolvedConfig } from '../../lib/config.js'
import { readLocalConfig } from '../../lib/config.js'
import { createApiClient } from '../../lib/api-client.js'
import { formatJson } from '../../lib/output.js'
import { ValidationError, NotFoundError, WorkspaceNotFoundError, DiscussionNotFoundError } from '../../lib/errors.js'

export async function handleDiscussReply(
  cfg: ResolvedConfig,
  discussionId: string,
  opts: { body: string; workspace?: string },
): Promise<void> {
  const resolvedSlug = opts.workspace ?? readLocalConfig()?.workspace_slug
  if (!resolvedSlug) {
    throw new ValidationError('No workspace specified. Pass --workspace <slug> or create .margins.json')
  }

  const client = createApiClient(cfg)
  let workspace: { id: string }
  try {
    workspace = await client.get(`/api/workspaces/by-slug/${resolvedSlug}`) as { id: string }
  } catch (err) {
    if (err instanceof NotFoundError) throw new WorkspaceNotFoundError(resolvedSlug)
    throw err
  }

  let reply: unknown
  try {
    reply = await client.post(
      `/api/workspaces/${workspace.id}/discussions/${discussionId}/reply`,
      { body: opts.body },
    )
  } catch (err) {
    if (err instanceof NotFoundError) throw new DiscussionNotFoundError(discussionId)
    throw err
  }

  if (cfg.json) {
    console.log(formatJson(reply))
    return
  }

  console.log(`Reply added to discussion ${discussionId}.`)
}
