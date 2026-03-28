import type { ResolvedConfig } from '../lib/config.js'
import { createApiClient } from '../lib/api-client.js'
import { resolveWorkspaceBySlug } from '../lib/resolve-workspace.js'

interface Workspace { slug: string }
interface Discussion { id: string }

export async function handleDynamicCompletions(cfg: ResolvedConfig, type: string, opts: { workspace?: string } = {}): Promise<void> {
  try {
    const client = createApiClient(cfg)

    if (type === 'workspace-slugs') {
      const workspaces = await client.get('/api/workspaces') as Workspace[]
      process.stdout.write(workspaces.map((w) => w.slug).join('\n') + '\n')
      return
    }

    if (type === 'discussion-ids') {
      if (!opts.workspace) return
      const workspace = await resolveWorkspaceBySlug(client, opts.workspace)
      const discussions = await client.get(
        `/api/workspaces/${workspace.id}/artifacts`,
        { discussions: 'true' },
      ) as Discussion[]
      process.stdout.write(discussions.map((d) => d.id).join('\n') + '\n')
      return
    }
  } catch {
    // Silent exit — completions must never show errors in the terminal
    process.exit(0)
  }
}
