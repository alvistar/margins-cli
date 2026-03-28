import type { ResolvedConfig } from '../../lib/config.js'
import { createApiClient } from '../../lib/api-client.js'
import { formatJson, formatTable } from '../../lib/output.js'

interface Workspace {
  id: string
  slug: string
  name: string
  syncStatus: string
  lastSyncedAt: string | null
  documentCount?: string | number
  openDiscussionCount?: string | number
}

function formatDate(iso: string | null): string {
  if (!iso) return 'never'
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export async function handleList(cfg: ResolvedConfig): Promise<void> {
  const client = createApiClient(cfg)
  const workspaces = await client.get('/api/workspaces') as Workspace[]

  if (cfg.json) {
    console.log(formatJson(workspaces))
    return
  }

  if (!workspaces.length) {
    console.log('No workspaces found. Create one: margins workspace create <repo-url>')
    return
  }

  console.log(formatTable(
    ['Slug', 'Name', 'Status', 'Last synced'],
    workspaces.map((w) => [
      w.slug,
      w.name,
      w.syncStatus ?? 'idle',
      formatDate(w.lastSyncedAt),
    ]),
  ))
}
