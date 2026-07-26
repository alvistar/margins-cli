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
      // Keep the server's own message and its code.
      //
      // This used to rethrow a bare `Workspace already exists for <url>`, which
      // dropped both. Two costs. The 409 is now two different causes —
      // SLUG_CONFLICT ("a workspace exists and you are not a member; ask an
      // editor for an invite link") and SYNC_MODE_CONFLICT ("it exists and uses
      // a different sync mode") — and a generic string collapses them into one
      // indistinguishable failure with two different fixes. And SLUG_CONFLICT's
      // message is written by the server for exactly this reader; replacing it
      // throws away the only thing that tells them what to do next.
      //
      // The repo URL is still useful context in a multi-repo session, so it is
      // added AROUND the server's text rather than instead of it.
      // `serverMessage`, not `userMessage`: the latter is a transport placeholder
      // (`Conflict while calling <path>`) when the body carried no message, and
      // wrapping that would be strictly worse than the generic line it replaced.
      throw new ConflictError(
        err.serverMessage ? `${err.serverMessage} (${repoUrl})` : `Workspace already exists for ${repoUrl}`,
        err.code,
        err.serverMessage,
      )
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
