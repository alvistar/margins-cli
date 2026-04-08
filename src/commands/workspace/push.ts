import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ResolvedConfig } from '../../lib/config.js'
import { createApiClient } from '../../lib/api-client.js'
import { formatJson } from '../../lib/output.js'
import { ValidationError } from '../../lib/errors.js'

interface IngestResult {
  added: number
  changed: number
  skipped: number
  // D-023: discussion anchor lifecycle counts (only present for workspaces
  // with prior discussions on changed files; zero otherwise).
  addressed?: number
  orphaned?: number
  moved?: number
}

interface IngestFile {
  path: string
  content: string
}

/** Recursively find all .md files in a directory, skipping symlinks. */
function globMarkdown(dir: string, base: string = ''): string[] {
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

export async function handlePush(
  cfg: ResolvedConfig,
  opts: { workspace?: string; project?: string; dir?: string }
): Promise<void> {
  const client = createApiClient(cfg)
  const cwd = opts.dir ?? process.cwd()

  // Resolve workspace ID
  let workspaceId = opts.workspace
  if (!workspaceId && opts.project) {
    // Create local workspace on first push
    const result = await client.post('/api/workspaces', {
      name: opts.project,
      source: 'local',
      projectName: opts.project,
    }) as { workspace: { id: string; slug: string } }
    workspaceId = result.workspace.id
    if (cfg.json) {
      console.log(formatJson({ created: true, workspaceId, slug: result.workspace.slug }))
    } else {
      console.log(`Created workspace: ${result.workspace.slug}`)
      console.log(`Workspace ID: ${workspaceId}`)
    }
  }

  if (!workspaceId) {
    throw new ValidationError('Specify --workspace <id> or --project <name> to create a new workspace')
  }

  // Glob markdown files
  const mdFiles = globMarkdown(cwd)
  if (mdFiles.length === 0) {
    throw new ValidationError(`No .md files found in ${cwd}`)
  }

  // Read files
  const files: IngestFile[] = mdFiles.map((relPath) => ({
    path: relPath,
    content: readFileSync(join(cwd, relPath), 'utf-8'),
  }))

  // Push to ingest endpoint
  const result = await client.post(
    `/api/workspaces/${workspaceId}/ingest`,
    { files }
  ) as IngestResult

  if (cfg.json) {
    console.log(formatJson(result))
  } else {
    let line = `Pushed: ${result.added} added, ${result.changed} changed, ${result.skipped} skipped`
    // D-023: append anchor lifecycle counts only when something actually transitioned.
    const addressed = result.addressed ?? 0
    const orphaned = result.orphaned ?? 0
    const moved = result.moved ?? 0
    if (addressed > 0 || orphaned > 0 || moved > 0) {
      line += ` (${addressed} addressed, ${orphaned} orphaned, ${moved} moved)`
    }
    console.log(line)
  }
}
