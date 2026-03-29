import { execSync } from 'node:child_process'
import type { ResolvedConfig } from '../../lib/config.js'
import { readLocalConfig } from '../../lib/config.js'
import { createApiClient } from '../../lib/api-client.js'
import { formatJson } from '../../lib/output.js'
import { ValidationError } from '../../lib/errors.js'
import { resolveWorkspaceBySlug } from '../../lib/resolve-workspace.js'

function detectGitBranch(): string | undefined {
  try {
    const branch = execSync('git branch --show-current', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return branch || undefined
  } catch {
    return undefined
  }
}

interface Discussion {
  id: string
}

export async function handleDiscussCreate(
  cfg: ResolvedConfig,
  slug: string | undefined,
  opts: { path: string; body: string; anchorHeading?: string; anchorText?: string; branch?: string },
): Promise<void> {
  const resolvedSlug = slug ?? readLocalConfig()?.workspace_slug
  if (!resolvedSlug) {
    throw new ValidationError('No workspace specified. Pass a slug or create .margins.json')
  }

  const client = createApiClient(cfg)
  const workspace = await resolveWorkspaceBySlug(client, resolvedSlug)

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

  const branch = opts.branch ?? detectGitBranch() ?? workspace.defaultBranch ?? 'main'

  console.log(`Discussion created: ${discussion.id}`)
  console.log(`View at: ${cfg.serverUrl}/w/${resolvedSlug}/-/${branch}/${opts.path}#discussion-${discussion.id}`)
}
