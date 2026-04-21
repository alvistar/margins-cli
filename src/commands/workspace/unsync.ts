import * as p from '@clack/prompts'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { readRegistry, writeRegistry, normalize } from '../../lib/registry.js'

interface UnsyncOpts {
  path?: string
  deleteConfig?: boolean
  json?: boolean
}

/**
 * Remove a repo from the local sync registry.
 * This is a local-only operation — no server auth required.
 */
export async function handleUnsync(opts: UnsyncOpts): Promise<void> {
  // Resolve the repo path
  let repoPath: string | undefined = opts.path
  if (!repoPath) {
    // Try to read .margins.json from cwd
    const configPath = path.join(process.cwd(), '.margins.json')
    if (fs.existsSync(configPath)) {
      try {
        JSON.parse(fs.readFileSync(configPath, 'utf-8'))
        // Valid .margins.json found — use cwd as the repo path
        repoPath = process.cwd()
      } catch {
        // Fall through to error
      }
    }
  }

  if (!repoPath) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'Not in a synced workspace. Use --path <dir>.' }))
      process.exit(1)
    }
    console.error('Not in a synced workspace. Use --path <dir> to specify the folder.')
    process.exit(1)
  }

  // Resolve to absolute path
  repoPath = path.resolve(repoPath)
  const normalizedTarget = normalize(repoPath)

  const registry = readRegistry()
  const before = registry.repos.length
  registry.repos = registry.repos.filter(r => normalize(r.path) !== normalizedTarget)

  if (registry.repos.length === before) {
    if (opts.json) {
      console.log(JSON.stringify({ error: `Not synced: ${repoPath}` }))
      process.exit(1)
    }
    console.error(`Not synced: ${repoPath}`)
    process.exit(1)
  }

  // Optionally delete .margins.json
  if (opts.deleteConfig) {
    const configFile = path.join(repoPath, '.margins.json')
    if (fs.existsSync(configFile)) {
      fs.unlinkSync(configFile)
      if (!opts.json) {
        p.log.info(`Deleted ${configFile}`)
      }
    }
  }

  writeRegistry(registry)

  if (opts.json) {
    console.log(JSON.stringify({ status: 'removed', path: repoPath }))
  } else {
    p.log.success(`Removed ${repoPath} from sync.`)
  }
}
