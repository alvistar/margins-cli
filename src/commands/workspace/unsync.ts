import * as p from '@clack/prompts'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

interface RepoEntry {
  path: string
  workspaceId: string
  slug: string
  branch: string
  enabled: boolean
  lastMtimes?: Record<string, number>
}

interface RepoRegistry {
  repos: RepoEntry[]
}

/**
 * Resolve the registry path, matching the desktop app's logic:
 *   MARGINS_DATA_DIR env var → dirs::data_local_dir()/margins/repos.json
 *
 * Platform equivalents:
 *   macOS:   ~/Library/Application Support/margins/repos.json
 *   Linux:   ~/.local/share/margins/repos.json
 *   Windows: %LOCALAPPDATA%/margins/repos.json
 */
function registryPath(): string {
  const override = process.env['MARGINS_DATA_DIR']
  if (override) return path.join(override, 'repos.json')

  const platform = os.platform()
  let base: string
  if (platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support')
  } else if (platform === 'win32') {
    base = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local')
  } else {
    base = process.env['XDG_DATA_HOME'] || path.join(os.homedir(), '.local', 'share')
  }

  return path.join(base, 'margins', 'repos.json')
}

function readRegistry(): RepoRegistry {
  const regPath = registryPath()
  if (!fs.existsSync(regPath)) return { repos: [] }
  try {
    return JSON.parse(fs.readFileSync(regPath, 'utf-8')) as RepoRegistry
  } catch {
    return { repos: [] }
  }
}

function writeRegistry(registry: RepoRegistry): void {
  const regPath = registryPath()
  const dir = path.dirname(regPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(regPath, JSON.stringify(registry, null, 2), 'utf-8')
}

function normalize(p: string): string {
  return p.replace(/\/+$/, '')
}

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
