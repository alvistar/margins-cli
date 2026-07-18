/**
 * `margins sync [dir]` — Set up a folder for continuous sync with Margins.
 *
 * This is a top-level command distinct from `margins workspace sync` (which
 * triggers server-side git sync). This command:
 * 1. Creates a workspace (GitHub overlay or local)
 * 2. Pushes all .md files
 * 3. Writes .margins.json + repos.json entry
 * 4. The running tray app picks up the new entry within 5 seconds
 */
import * as p from '@clack/prompts'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ResolvedConfig } from '../lib/config.js'
import { createApiClient } from '../lib/api-client.js'
import { ConflictError } from '../lib/errors.js'
import { formatJson } from '../lib/output.js'
import { detectGitRemote, sanitizeProjectName } from '../lib/detect-git-remote.js'
import { readRegistry, writeRegistry, addRepo, normalize } from '../lib/registry.js'
import { casSync } from '../lib/cas-sync.js'
import { collectSyncFiles, skipOversized } from '../lib/collect-sync-files.js'

interface MarginsJson {
  workspace_slug: string
  workspace_id?: string
  default_branch?: string
  server_url?: string
  syncMode?: 'server' | 'client'
  mode?: string // Legacy field, replaced by syncMode
}

interface SyncOpts {
  dir?: string
  json?: boolean
  confirmFullDelete?: boolean
}

export async function handleSync(cfg: ResolvedConfig, opts: SyncOpts): Promise<void> {
  const dir = path.resolve(opts.dir ?? '.')
  const isJson = cfg.json || opts.json

  if (!fs.existsSync(dir)) {
    if (isJson) {
      console.log(formatJson({ error: `Directory does not exist: ${dir}` }))
    } else {
      console.error(`Directory does not exist: ${dir}`)
    }
    process.exit(1)
  }

  const client = createApiClient(cfg)
  const configPath = path.join(dir, '.margins.json')

  // Step 1: Check .margins.json state
  let marginsJson: MarginsJson | null = null
  if (fs.existsSync(configPath)) {
    try {
      marginsJson = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    } catch {
      // Invalid JSON, treat as fresh setup
    }
  }

  if (marginsJson?.workspace_id) {
    // Check if already in registry
    const registry = readRegistry()
    const normalizedDir = normalize(dir)
    const existing = registry.repos.find(r => normalize(r.path) === normalizedDir)

    if (existing) {
      // Fully synced — print status and exit
      const url = `${cfg.serverUrl.replace(/\/$/, '')}/w/${marginsJson.workspace_slug}`
      if (isJson) {
        console.log(formatJson({
          status: 'already_synced',
          workspaceId: marginsJson.workspace_id,
          slug: marginsJson.workspace_slug,
          url,
        }))
      } else {
        p.log.info(`Already synced: ${marginsJson.workspace_slug}`)
        p.log.info(url)
      }
      return
    }

    // Half-configured: .margins.json exists but not in repos.json
    // Resume from push + registry write (skip workspace creation)
    if (!isJson) {
      p.log.info(`Found .margins.json (workspace: ${marginsJson.workspace_slug}), resuming setup...`)
    }
  }

  // Step 2-3: Create workspace if needed
  let workspaceId = marginsJson?.workspace_id ?? ''
  let slug = marginsJson?.workspace_slug ?? ''
  let syncMode: 'server' | 'client' = marginsJson?.syncMode ?? 'client'
  // Legacy: infer syncMode from mode field
  if (!marginsJson?.syncMode && marginsJson?.mode === 'overlay') {
    syncMode = 'client'
  }
  let branch = (marginsJson?.mode === 'overlay' || syncMode === 'server')
    ? '@local'
    : (marginsJson?.default_branch ?? 'main')

  if (!workspaceId) {
    const remote = detectGitRemote(dir)

    if (remote.type === 'github') {
      // Try overlay workspace
      const repoUrl = `https://github.com/${remote.owner}/${remote.repo}`
      const folderName = path.basename(dir) || remote.repo

      try {
        const result = await client.post('/api/workspaces', {
          name: folderName,
          source: 'github',
          repoUrl,
          // Must be explicit: the server defaults source:'github' to syncMode 'server'
          // (the clone-and-pull path), but everything below this point — the .margins.json
          // we write and the CAS push we run next — is client sync. Omitting it created a
          // server-sync workspace and the push then failed 422 PUSH_SYNC_NOT_SUPPORTED,
          // but ONLY for users with GitHub linked: without it the create throws
          // GITHUB_NOT_LINKED and the catch below quietly falls back to a local workspace.
          // `margins install` has always passed this (see commands/install.ts).
          syncMode: 'client',
        }) as { workspace: { id: string; slug: string } }

        workspaceId = result.workspace.id
        slug = result.workspace.slug
        branch = '@local'
        syncMode = 'client'
      } catch (err) {
        if (err instanceof ConflictError) {
          // 409: workspace exists, find it
          const found = await findExistingWorkspace(client, folderName)
          if (found) {
            workspaceId = found.id
            slug = found.slug
            branch = '@local'
            syncMode = 'client'
          } else {
            // Can't find it, fall back to local
            if (!isJson) {
              p.log.warn('GitHub workspace exists but not found in your list. Creating local workspace.')
            }
            const local = await createLocalWorkspace(client, dir)
            workspaceId = local.id
            slug = local.slug
          }
        } else {
          // Non-conflict error (e.g. GITHUB_NOT_LINKED) — fall back to local
          if (!isJson) {
            p.log.warn(`GitHub overlay failed, creating local workspace. (${(err as Error).message})`)
          }
          const local = await createLocalWorkspace(client, dir)
          workspaceId = local.id
          slug = local.slug
        }
      }
    } else {
      // No GitHub remote — create local workspace
      const local = await createLocalWorkspace(client, dir)
      workspaceId = local.id
      slug = local.slug
    }

    // Step 4: Write .margins.json
    const config: MarginsJson = {
      workspace_slug: slug,
      workspace_id: workspaceId,
      default_branch: syncMode === 'client' && branch !== '@local' ? 'main' : undefined,
      syncMode,
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  }

  // Step 5-6: Collect and push .md files (+ referenced images) via CAS protocol
  const collected = collectSyncFiles(dir)
  const { mdCount, mdPaths: mdFiles, oversized } = collected
  // Oversized blobs are skipped (excluded from upload AND manifest) — one
  // >2 MB file must not 413-abort the whole push. Reported on stderr.
  const syncFiles = skipOversized(collected)

  let pushResult = { added: 0, changed: 0, skipped: 0, merged: false }

  if (mdCount > 0) {
    if (!isJson) {
      p.log.info(`Pushing ${mdCount} .md file(s) via CAS...`)
    }

    const casResult = await casSync(
      client,
      workspaceId,
      branch === '@local' ? 'main' : branch,
      syncFiles,
      { confirmFullDelete: opts.confirmFullDelete },
    )

    pushResult.added = casResult.added
    pushResult.changed = casResult.changed
    pushResult.skipped = casResult.skipped
    pushResult.merged = casResult.merged // surface auto-merge in --json (parity with `workspace push`)
  }

  // Step 7: Write lastMtimes + add to repos.json
  const lastMtimes: Record<string, number> = {}
  for (const relPath of mdFiles) {
    try {
      const stat = fs.statSync(path.join(dir, relPath))
      lastMtimes[relPath] = stat.mtimeMs
    } catch { /* skip */ }
  }

  const registry = readRegistry()
  addRepo(registry, {
    path: dir,
    workspaceId,
    slug,
    branch,
    enabled: true,
    lastMtimes,
  })
  writeRegistry(registry)

  // Step 8: Output
  const url = `${cfg.serverUrl.replace(/\/$/, '')}/w/${slug}`

  if (isJson) {
    console.log(formatJson({
      status: 'synced',
      workspaceId,
      slug,
      branch,
      syncMode,
      files: mdFiles.length,
      ...pushResult,
      ...(oversized.length > 0
        ? { skippedOversized: oversized.length, oversizedPaths: oversized.map((f) => f.path) }
        : {}),
      url,
    }))
  } else {
    if (mdFiles.length > 0) {
      p.log.success(`Pushed: ${pushResult.added} added, ${pushResult.changed} changed, ${pushResult.skipped} skipped`)
    }
    if (oversized.length > 0) {
      p.log.warn(`${oversized.length} oversized file(s) skipped (over the 2MB server blob cap)`)
    }
    p.log.success(`Synced: ${slug}`)
    p.log.info(url)
  }
}

async function createLocalWorkspace(
  client: ReturnType<typeof createApiClient>,
  dir: string,
): Promise<{ id: string; slug: string }> {
  const folderName = path.basename(dir) || 'workspace'
  const projectName = sanitizeProjectName(folderName)

  try {
    const result = await client.post('/api/workspaces', {
      name: projectName,
      source: 'local',
      projectName,
    }) as { workspace: { id: string; slug: string } }

    return result.workspace
  } catch (err) {
    if (err instanceof ConflictError) {
      const found = await findExistingWorkspace(client, projectName)
      if (found) return found
      throw new Error(`Workspace '${projectName}' already exists but could not find it in your list.`)
    }
    throw err
  }
}

async function findExistingWorkspace(
  client: ReturnType<typeof createApiClient>,
  name: string,
): Promise<{ id: string; slug: string } | null> {
  const workspaces = await client.get('/api/workspaces') as Array<{ id: string; slug: string }>
  const nameLower = name.toLowerCase()
  const match = workspaces.find(w => w.slug.toLowerCase().endsWith(nameLower))
  return match ?? null
}
