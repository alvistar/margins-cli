import type { ResolvedConfig } from '../../lib/config.js'
import { readLocalConfig } from '../../lib/config.js'
import { createApiClient } from '../../lib/api-client.js'
import { formatJson } from '../../lib/output.js'
import { ValidationError, NotFoundError, WorkspaceNotFoundError } from '../../lib/errors.js'

interface Discussion {
  id: string
}

export async function handleDiscussCreate(
  cfg: ResolvedConfig,
  slug: string | undefined,
  opts: { path: string; body: string; anchorHeading?: string; anchorText?: string },
): Promise<void> {
  const resolvedSlug = slug ?? readLocalConfig()?.workspace_slug
  if (!resolvedSlug) {
    throw new ValidationError('No workspace specified. Pass a slug or create .margins.json')
  }

  const client = createApiClient(cfg)
  let workspace: { id: string }
  try {
    workspace = await client.get(`/api/workspaces/by-slug/${resolvedSlug}`) as { id: string }
  } catch (err) {
    if (err instanceof NotFoundError) throw new WorkspaceNotFoundError(resolvedSlug)
    throw err
  }

  const payload: Record<string, string> = { body: opts.body }
  if (opts.anchorHeading) {
    payload['anchorType'] = 'heading'
    payload['anchorHeadingText'] = opts.anchorHeading
  } else if (opts.anchorText) {
    payload['anchorType'] = 'text'
    payload['anchorSelectedText'] = opts.anchorText
  }

  const discussion = await client.post(
    `/api/workspaces/${workspace.id}/artifacts?path=${encodeURIComponent(opts.path)}`,
    payload,
  ) as Discussion

  if (cfg.json) {
    console.log(formatJson(discussion))
    return
  }

  console.log(`Discussion created: ${discussion.id}`)
  console.log(`View at: ${cfg.serverUrl}/w/${resolvedSlug}`)
}
