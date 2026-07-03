import type { ResolvedConfig } from '../../lib/config.js'
import { createApiClient } from '../../lib/api-client.js'
import { formatJson } from '../../lib/output.js'
import { ValidationError } from '../../lib/errors.js'

interface ArchiveResult {
  branch?: string
  archived?: boolean
}

/**
 * Archive a workspace branch. Used by the sync Action's `delete`-event path to
 * hide a workspace branch when its git branch is deleted. The request goes through
 * the shared ApiClient (which sends the GitHub OIDC bearer + re-mints on 401 in
 * CI), but the server's archive endpoint is OIDC-only — a stored API key is
 * rejected with 403, so this is effectively a CI-only command. Idempotent: an
 * unknown or already-archived branch returns archived:false with no error, and
 * the default branch is a no-op.
 */
export async function handleArchiveBranch(
  cfg: ResolvedConfig,
  opts: { workspace?: string; branch?: string }
): Promise<void> {
  if (!opts.workspace) {
    throw new ValidationError('Specify --workspace <id>')
  }
  if (!opts.branch) {
    throw new ValidationError('Specify --branch <name>')
  }

  const client = createApiClient(cfg)
  const result = (await client.post(
    `/api/workspaces/${opts.workspace}/branches/archive`,
    { branch: opts.branch }
  )) as ArchiveResult

  if (cfg.json) {
    console.log(formatJson(result))
    return
  }

  const branch = result.branch ?? opts.branch
  if (result.archived) {
    console.log(`Archived branch: ${branch}`)
  } else {
    console.log(`Branch not found or already archived: ${branch} (no-op)`)
  }
}
