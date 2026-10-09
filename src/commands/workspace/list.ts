import type { ResolvedConfig } from '../../lib/config.js'
import { createApiClient } from '../../lib/api-client.js'
import { formatJson, formatTable } from '../../lib/output.js'
import { fromApiSyncMode } from '../../lib/sync-mode.js'

interface Workspace {
  id: string
  slug: string
  name: string
  syncStatus: string
  lastSyncedAt: string | null
  documentCount?: string | number
  openDiscussionCount?: string | number
  /** The API value (client/server); translated before any output. */
  syncMode?: unknown
}

function formatDate(iso: string | null): string {
  if (!iso) return 'never'
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export async function handleList(cfg: ResolvedConfig): Promise<void> {
  const client = createApiClient(cfg)
  const workspaces = await client.get('/api/workspaces') as Workspace[]

  if (cfg.json) {
    // --json says push/pull, never the API's client/server.
    console.log(formatJson(workspaces.map((w) =>
      w.syncMode === undefined ? w : { ...w, syncMode: fromApiSyncMode(w.syncMode) ?? w.syncMode })))
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
