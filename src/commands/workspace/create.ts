import type { ResolvedConfig } from '../../lib/config.js'
import { createApiClient } from '../../lib/api-client.js'
import { formatJson } from '../../lib/output.js'
import { ValidationError, ConflictError } from '../../lib/errors.js'

interface CreatedWorkspace {
  id: string
  slug: string
  name: string
}

interface WorkspaceCreateResponse {
  workspace: CreatedWorkspace
  autoJoined?: boolean
}

export async function handleCreate(cfg: ResolvedConfig, repoUrl: string): Promise<void> {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(repoUrl)
  } catch {
    throw new ValidationError(`Invalid repository URL: ${repoUrl}`)
  }

  // Derive name from the last path segment of the URL (e.g. "ai-review" from ".../ai-review")
  const name = parsedUrl.pathname.split('/').filter(Boolean).pop()?.replace(/\.git$/, '') ?? repoUrl

  const client = createApiClient(cfg)
  let workspace: CreatedWorkspace
  try {
    const result = await client.post('/api/workspaces', { repoUrl, name }) as CreatedWorkspace | WorkspaceCreateResponse
    workspace = 'workspace' in result ? result.workspace : result
  } catch (err) {
    if (err instanceof ConflictError) {
      throw new ConflictError(`Workspace already exists for ${repoUrl}`)
    }
    throw err
  }

  if (cfg.json) {
    console.log(formatJson(workspace))
    return
  }

  console.log(`Workspace created: ${workspace.slug} (${workspace.name})`)
  console.log(`Open in browser: margins workspace open ${workspace.slug}`)
}
