import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync, type StdioOptions } from 'node:child_process'
import type { ResolvedConfig, LocalConfig } from '../../lib/config.js'
import { createApiClient } from '../../lib/api-client.js'
import { formatJson } from '../../lib/output.js'
import { ValidationError } from '../../lib/errors.js'
import { resolveSyncMode } from '../../lib/resolve-sync-mode.js'
import { casSync, type CasSyncResult } from '../../lib/cas-sync.js'
import { scanImagesInMarkdown, mimeFromPath } from '../../lib/image-scanner.js'
import { loadIgnoreFilter } from '../../lib/marginsignore.js'

/** Recursively find all .md files in a directory, skipping symlinks. */
export function globMarkdown(dir: string, base: string = ''): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    if (entry.isSymbolicLink()) continue
    const rel = base ? join(base, entry.name) : entry.name
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...globMarkdown(full, rel))
    } else if (entry.name.endsWith('.md')) {
      results.push(rel.replace(/\\/g, '/'))
    }
  }
  return results.sort()
}

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

function gitCommitSha(cwd: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8', stdio: GIT_STDIO }).trim()
  } catch {
    return 'unknown'
  }
}

function gitParentSha(cwd: string): string | null {
  try {
    return execSync('git rev-parse HEAD~1', { cwd, encoding: 'utf-8', stdio: GIT_STDIO }).trim()
  } catch {
    return null  // first commit or not a git repo
  }
}

// ─── Push handler ────────────────────────────────────────────────────────────

export async function handlePush(
  cfg: ResolvedConfig,
  opts: { workspace?: string; project?: string; dir?: string }
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

  // Glob markdown files and apply .marginsignore filter
  const allMdFiles = globMarkdown(cwd)
  const ignoreFilter = loadIgnoreFilter(cwd)
  const mdFiles = allMdFiles.filter(ignoreFilter)
  if (mdFiles.length === 0) {
    throw new ValidationError(`No .md files found in ${cwd}`)
  }

  // Build file list: markdown files + referenced images
  const syncFiles: Array<{ path: string; content: Buffer; contentType: string }> = []
  const seenPaths = new Set<string>()

  for (const relPath of mdFiles) {
    const content = readFileSync(join(cwd, relPath))
    syncFiles.push({ path: relPath, content, contentType: 'text/markdown' })
    seenPaths.add(relPath)

    // Scan for image references
    const mdText = content.toString('utf-8')
    const imagePaths = scanImagesInMarkdown(mdText, relPath, cwd)
    for (const imgPath of imagePaths) {
      if (seenPaths.has(imgPath)) continue
      const imgFull = join(cwd, imgPath)
      if (!existsSync(imgFull)) continue
      const mime = mimeFromPath(imgPath)
      if (!mime) continue
      try {
        const imgContent = readFileSync(imgFull)
        syncFiles.push({ path: imgPath, content: imgContent, contentType: mime })
        seenPaths.add(imgPath)
      } catch {
        // Skip unreadable images
      }
    }
  }

  // Detect git info
  const branch = gitBranch(cwd)
  const commitSha = gitCommitSha(cwd)
  const parentSha = gitParentSha(cwd)

  // Sync via CAS protocol
  const result: CasSyncResult = await casSync(
    client,
    workspaceId,
    branch,
    commitSha,
    parentSha,
    syncFiles,
  )

  if (cfg.json) {
    console.log(formatJson({
      ...result,
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
    console.log(line)
  }
}
