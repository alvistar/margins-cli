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
import { globMarkdown } from './workspace/push.js'

interface MarginsJson {
  workspace_slug: string
  workspace_id?: string
  default_branch?: string
  server_url?: string
  mode?: string
}

interface SyncOpts {
  dir?: string
  json?: boolean
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
  let mode = marginsJson?.mode ?? 'local'
  let branch = mode === 'overlay' ? '@local' : (marginsJson?.default_branch ?? 'main')

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
        }) as { workspace: { id: string; slug: string } }

        workspaceId = result.workspace.id
        slug = result.workspace.slug
        branch = '@local'
        mode = 'overlay'
      } catch (err) {
        if (err instanceof ConflictError) {
          // 409: workspace exists, find it
          const found = await findExistingWorkspace(client, folderName)
          if (found) {
            workspaceId = found.id
            slug = found.slug
            branch = '@local'
            mode = 'overlay'
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
      default_branch: mode === 'local' ? 'main' : undefined,
      mode,
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  }

  // Step 5-6: Glob and push .md files
  const mdFiles = globMarkdown(dir)
  let pushResult = { added: 0, changed: 0, skipped: 0 }

  if (mdFiles.length > 0) {
    if (!isJson) {
      p.log.info(`Pushing ${mdFiles.length} .md file(s)...`)
    }

    // Push in batches of 50 (server limit)
    const BATCH_SIZE = 50
    for (let i = 0; i < mdFiles.length; i += BATCH_SIZE) {
      const batch = mdFiles.slice(i, i + BATCH_SIZE)
      const files = batch.map(relPath => ({
        path: relPath,
        content: fs.readFileSync(path.join(dir, relPath), 'utf-8'),
      }))

      const result = await client.post(
        `/api/workspaces/${workspaceId}/ingest`,
        { files }
      ) as { added: number; changed: number; skipped: number }

      pushResult.added += result.added
      pushResult.changed += result.changed
      pushResult.skipped += result.skipped
    }
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
      mode,
      files: mdFiles.length,
      ...pushResult,
      url,
    }))
  } else {
    if (mdFiles.length > 0) {
      p.log.success(`Pushed: ${pushResult.added} added, ${pushResult.changed} changed, ${pushResult.skipped} skipped`)
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
