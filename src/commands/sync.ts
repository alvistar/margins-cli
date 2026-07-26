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
import { ConflictError, ValidationError } from '../lib/errors.js'
import { formatJson } from '../lib/output.js'
import { detectGitRemote, sanitizeProjectName } from '../lib/detect-git-remote.js'
import { readRegistry, writeRegistry, addRepo, normalize } from '../lib/registry.js'
import {
  casSync, emptyCollectionMessage, fetchSyncPreflight, parseContentModeFlag,
  resolveContentMode, type ContentMode,
} from '../lib/cas-sync.js'
import {
  collectForMode, isInsideGitRepo, probeSyncSource, skipOversized,
} from '../lib/collect-sync-files.js'

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
  contentMode?: string
}

/**
 * R2: the first sync of a git repository asks what a sync should send, and the
 * answer goes to the SERVER — nothing is cached locally, so no copy can go
 * stale after a migration. A non-interactive session has no way to ask, so it
 * requires the choice to be stated rather than guessing one.
 */
async function chooseContentMode(dir: string, isJson: boolean): Promise<ContentMode> {
  if (!process.stdin.isTTY || isJson) {
    throw new ValidationError(
      `${dir} is a git repository and this session is not interactive, so the content mode ` +
      'cannot be chosen here — nothing was synced. Re-run with ' +
      '`--content-mode committed` or `--content-mode working-tree`.',
    )
  }
  const choice = await p.select({
    message: 'What should a sync of this git repository send?',
    options: [
      {
        value: 'working-tree' as const,
        label: 'Working tree — every .md file on disk, committed or not',
      },
      {
        value: 'committed' as const,
        label: 'Committed — only files tracked at the last commit (git ignore rules apply)',
      },
    ],
  })
  if (p.isCancel(choice)) {
    throw new ValidationError('Cancelled — nothing was synced.')
  }
  return choice
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

  // Local, pre-network: a wrong directory fails here rather than as a network error.
  const requestedMode = parseContentModeFlag(opts.contentMode)
  probeSyncSource(dir)

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

  const isFirstSync = !workspaceId

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
        // A REFUSAL, not a "you already have this". Margins 0.60.0 removed
        // auto-join: a caller who is not a member of the workspace holding this
        // repo's slug is refused rather than silently granted `comment` on it.
        //
        // Stop here. The lookup below is backed by the membership-scoped
        // workspace listing, so a non-member matches nothing by construction and
        // control used to fall through to `createLocalWorkspace` — pushing this
        // repo's markdown into a private workspace nobody asked for and pointing
        // `.margins.json` at it. Under `--json` even the warning was suppressed,
        // so CI saw a successful sync into the wrong place.
        //
        // The server words this refusal for a human (it names the invite link),
        // so surface it verbatim — same opt-in as `mapSetModeError` in
        // workspace/content-mode.ts. Throwing is also what makes it visible in
        // JSON mode: the top-level handler in index.ts renders any thrown error
        // through `formatError(err, json)` and exits non-zero.
        if (err instanceof ConflictError && err.code === 'SLUG_CONFLICT') {
          throw new ValidationError(err.userMessage)
        }
        if (err instanceof ConflictError) {
          // Any OTHER 409 — including a codeless one from an older server, where
          // assuming a refusal would send the user to ask for an invite they do
          // not need. Unchanged: the workspace probably does exist for them.
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

  // Step 5: Settle the content mode BEFORE collecting anything (KTD3).
  const pushBranch = branch === '@local' ? 'main' : branch
  const preflight = await fetchSyncPreflight(client, workspaceId, pushBranch)

  let contentMode: ContentMode
  if (isFirstSync && preflight.contentMode !== undefined && isInsideGitRepo(dir)) {
    // R2: first sync of a git repository — ask, then tell the server. The
    // preflight reporting a mode at all is what proves the server can store one.
    contentMode = requestedMode ?? await chooseContentMode(dir, isJson === true)
    if (contentMode !== preflight.contentMode) {
      // PUT, and `hasGitRepo` — the server exports only PUT here, and it fails
      // closed on committed mode unless `hasGitRepo === true`, so the wrong
      // field name reports "no git repository" from inside a git repository.
      await client.put(`/api/workspaces/${workspaceId}/content-mode`, {
        mode: contentMode,
        expectedMode: preflight.contentMode,
        hasGitRepo: true,
      })
    }
  } else {
    contentMode = resolveContentMode(preflight, requestedMode)
  }

  // Step 6: Collect and push .md files (+ referenced images) via CAS protocol
  const collected = collectForMode(dir, contentMode)
  const { mdCount, mdPaths: mdFiles, oversized } = collected

  // R8: identical wording to `workspace push`, and identically non-fatal — an
  // empty push against a populated branch must reach the full-delete guard
  // rather than being reported as a silent success.
  if (mdCount === 0) {
    process.stderr.write(`${emptyCollectionMessage(dir, contentMode)}\n`)
  }

  // Oversized blobs are skipped (excluded from upload AND manifest) — one
  // >2 MB file must not 413-abort the whole push. Reported on stderr.
  const syncFiles = skipOversized(collected)

  let pushResult = { added: 0, changed: 0, skipped: 0, merged: false }

  // The push runs unconditionally. It used to be gated on `mdCount > 0`, which
  // reported an empty collection as a silent success and kept casSync's
  // full-delete guard unreachable from this caller — the same early exit
  // `workspace push` carried, with the opposite (and equally wrong) outcome.
  if (!isJson && mdCount > 0) {
    p.log.info(`Pushing ${mdCount} .md file(s) via CAS...`)
  }

  const casResult = await casSync(
    client,
    workspaceId,
    pushBranch,
    syncFiles,
    {
      preflight,
      contentMode,
      confirmFullDelete: opts.confirmFullDelete,
      // Committed mode only — see the note at `workspace push`'s call site.
      gitProvenance: collected.gitProvenance,
    },
  )

  pushResult.added = casResult.added
  pushResult.changed = casResult.changed
  pushResult.skipped = casResult.skipped
  pushResult.merged = casResult.merged // surface auto-merge in --json (parity with `workspace push`)

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
