import * as p from '@clack/prompts'
import type { ResolvedConfig } from '../../lib/config.js'
import { readLocalConfig } from '../../lib/config.js'
import { createApiClient } from '../../lib/api-client.js'
import { formatJson } from '../../lib/output.js'
import { ValidationError, NotFoundError, WorkspaceNotFoundError, ConflictError } from '../../lib/errors.js'

interface WorkspaceDetail {
  id: string
  slug: string
}

interface SyncResult {
  artifactsUpdated?: number
  status?: string
}

export async function handleSync(cfg: ResolvedConfig, slug: string | undefined, branch?: string): Promise<void> {
  const resolvedSlug = slug ?? readLocalConfig()?.workspace_slug
  if (!resolvedSlug) {
    throw new ValidationError('No workspace specified. Pass a slug or create .margins.json')
  }

  const client = createApiClient(cfg)

  // Resolve slug to UUID
  let workspace: WorkspaceDetail
  try {
    workspace = await client.get(`/api/workspaces/by-slug/${resolvedSlug}`) as WorkspaceDetail
  } catch (err) {
    if (err instanceof NotFoundError) throw new WorkspaceNotFoundError(resolvedSlug)
    throw err
  }

  if (!cfg.json) {
    const spinner = p.spinner()
    spinner.start(`Syncing ${resolvedSlug}...`)
    let result: SyncResult
    try {
      result = await client.post(`/api/workspaces/${workspace.id}/sync`, branch ? { branch } : {}) as SyncResult
    } catch (err) {
      if (err instanceof ConflictError) {
        spinner.stop(`Sync already in progress for ${resolvedSlug}.`)
        return
      }
      throw err
    }
    if (result.status === 'already_running' || result.status === 'syncing') {
      spinner.stop(`Sync already in progress for ${resolvedSlug}.`)
      return
    }
    spinner.stop(`Sync complete. ${result.artifactsUpdated ?? 0} artifacts updated.`)
  } else {
    try {
      const result = await client.post(`/api/workspaces/${workspace.id}/sync`, branch ? { branch } : {})
      console.log(formatJson(result))
    } catch (err) {
      if (err instanceof ConflictError) {
        console.log(formatJson({ status: 'already_running', message: `Sync already in progress for ${resolvedSlug}.` }))
        return
      }
      throw err
    }
  }
}
