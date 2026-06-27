import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync, type StdioOptions } from 'node:child_process'
import type { ResolvedConfig, LocalConfig } from '../../lib/config.js'
import { createApiClient } from '../../lib/api-client.js'
import { formatJson } from '../../lib/output.js'
import { ValidationError } from '../../lib/errors.js'
import { resolveSyncMode } from '../../lib/resolve-sync-mode.js'
import { casSync, type CasSyncResult } from '../../lib/cas-sync.js'
import { collectSyncFiles, skipOversized } from '../../lib/collect-sync-files.js'

// Re-exported for backwards compatibility — implementation moved to lib.
export { globMarkdown } from '../../lib/collect-sync-files.js'

// ─── Git helpers ─────────────────────────────────────────────────────────────

// stdio: ['ignore', 'pipe', 'ignore'] — capture stdout, discard stderr so git's
// error output (e.g. 'fatal: ambiguous argument HEAD~1' on a first commit) doesn't
// leak past our try/catch into the user's terminal.
const GIT_STDIO: StdioOptions = ['ignore', 'pipe', 'ignore']

function gitBranch(cwd: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', stdio: GIT_STDIO }).trim()
  } catch {
    return 'main'
  }
}

// ─── Push handler ────────────────────────────────────────────────────────────

export async function handlePush(
  cfg: ResolvedConfig,
  opts: { workspace?: string; project?: string; dir?: string; confirmFullDelete?: boolean }
): Promise<void> {
  const client = createApiClient(cfg)
  const cwd = opts.dir ?? process.cwd()

  // Resolve workspace ID: --workspace flag → .margins.json → --project (create)
  let workspaceId = opts.workspace
  let createdSlug: string | undefined
  if (!workspaceId) {
    const localCfgPath = join(cwd, '.margins.json')
    if (existsSync(localCfgPath)) {
      try {
        const localCfg = JSON.parse(readFileSync(localCfgPath, 'utf-8')) as LocalConfig
        if (localCfg.workspace_id) workspaceId = localCfg.workspace_id
      } catch {
        // Malformed .margins.json — fall through; resolveConfig already warned.
      }
    }
  }
  if (!workspaceId && opts.project) {
    // Create local workspace on first push
    const result = await client.post('/api/workspaces', {
      name: opts.project,
      source: 'local',
      projectName: opts.project,
    }) as { workspace: { id: string; slug: string } }
    workspaceId = result.workspace.id
    createdSlug = result.workspace.slug
    if (cfg.json) {
      console.log(formatJson({ created: true, workspaceId, slug: createdSlug }))
    } else {
      console.log(`Created workspace: ${createdSlug}`)
      console.log(`Workspace ID: ${workspaceId}`)
    }
  }

  if (!workspaceId) {
    throw new ValidationError('Specify --workspace <id> or --project <name> to create a new workspace')
  }

  // Gate: refuse to push to server-sync workspaces (they sync via webhook)
  const localCfgForSync = join(cwd, '.margins.json')
  if (existsSync(localCfgForSync)) {
    try {
      const localCfg = JSON.parse(readFileSync(localCfgForSync, 'utf-8')) as LocalConfig
      const syncMode = await resolveSyncMode(localCfg, client, cwd)
      if (syncMode === 'server') {
        console.error('This workspace uses server-managed sync. Use `margins workspace sync` instead.')
        process.exit(1)
      }
    } catch {
      // Malformed .margins.json or server unreachable — resolveSyncMode handles exit
    }
  }

  // Collect markdown files + referenced images (.marginsignore applied)
  const collected = collectSyncFiles(cwd)
  const { mdCount, oversized } = collected
  if (mdCount === 0) {
    throw new ValidationError(`No .md files found in ${cwd}`)
  }

  // Oversized blobs are skipped (excluded from upload AND manifest) — one
  // >2 MB file must not 413-abort the whole push. Reported on stderr.
  const syncFiles = skipOversized(collected)

  // Detect git branch (SHAs are computed inside casSync — synthetic
  // manifest hash + server headSha, never git SHAs)
  const branch = gitBranch(cwd)

  // Sync via CAS protocol
  const result: CasSyncResult = await casSync(
    client,
    workspaceId,
    branch,
    syncFiles,
    { confirmFullDelete: opts.confirmFullDelete },
  )

  if (cfg.json) {
    console.log(formatJson({
      ...result,
      ...(oversized.length > 0
        ? { skippedOversized: oversized.length, oversizedPaths: oversized.map((f) => f.path) }
        : {}),
      ...(createdSlug ? { workspaceId, slug: createdSlug } : {}),
    }))
  } else {
    const parts = [
      `${result.added} added`,
      `${result.changed} changed`,
      `${result.deleted} deleted`,
    ]
    let line = `Pushed: ${parts.join(', ')}`
    if (result.uploaded > 0 || result.skipped > 0) {
      line += ` (${result.uploaded} uploaded, ${result.skipped} unchanged)`
    }
    if (oversized.length > 0) {
      line += ` — ${oversized.length} oversized file(s) skipped`
    }
    console.log(line)
  }
}
