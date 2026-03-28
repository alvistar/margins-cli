import type { ResolvedConfig } from '../../lib/config.js'
import { readLocalConfig } from '../../lib/config.js'
import { createApiClient } from '../../lib/api-client.js'
import { formatJson, formatTable } from '../../lib/output.js'
import { ValidationError } from '../../lib/errors.js'
import { resolveWorkspaceBySlug } from '../../lib/resolve-workspace.js'

interface Discussion {
  id: string
  path?: string
  anchorHeadingText?: string
  anchorSelectedText?: string
  body: string
  authorName?: string
  status: string
}

export async function handleDiscussList(
  cfg: ResolvedConfig,
  slug: string | undefined,
  opts: { path?: string; status?: string },
): Promise<void> {
  const resolvedSlug = slug ?? readLocalConfig()?.workspace_slug
  if (!resolvedSlug) {
    throw new ValidationError('No workspace specified. Pass a slug or create .margins.json')
  }

  const client = createApiClient(cfg)
  const workspace = await resolveWorkspaceBySlug(client, resolvedSlug)

  const query: Record<string, string> = { discussions: 'true' }
  if (opts.path) query['path'] = opts.path
  if (opts.status) query['status'] = opts.status

  const discussions = await client.get(`/api/workspaces/${workspace.id}/artifacts`, query) as Discussion[]

  if (cfg.json) {
    console.log(formatJson(discussions))
    return
  }

  if (!discussions.length) {
    console.log('No discussions found.')
    return
  }

  console.log(formatTable(
    ['ID', 'Path', 'Anchor', 'Author', 'Status', 'Body preview'],
    discussions.map((d) => [
      d.id.slice(0, 8),
      d.path ?? '(unknown)',
      d.anchorHeadingText ?? d.anchorSelectedText ?? '(doc)',
      d.authorName ?? 'unknown',
      d.status,
      d.body.slice(0, 60) + (d.body.length > 60 ? '…' : ''),
    ]),
  ))
}
