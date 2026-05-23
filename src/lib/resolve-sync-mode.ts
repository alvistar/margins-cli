import * as fs from 'node:fs'
import * as path from 'node:path'
import type { LocalConfig } from './config.js'
import type { ApiClient } from './api-client.js'

/**
 * Resolve the workspace's syncMode from .margins.json, handling legacy
 * `mode: "overlay"` by querying the server.
 *
 * Priority:
 * 1. syncMode field (new format) -> return directly
 * 2. mode: "local" (legacy) -> always "client"
 * 3. mode: "overlay" (legacy, ambiguous) -> query server, upgrade file in-place
 * 4. Missing both -> default to "client" (safe fallback)
 */
export async function resolveSyncMode(
  config: LocalConfig,
  client: ApiClient,
  configDir?: string,
): Promise<'server' | 'client'> {
  if (config.syncMode === 'server' || config.syncMode === 'client') {
    return config.syncMode
  }

  if (config.mode === 'local') return 'client'

  if (config.mode === 'overlay' && config.workspace_id) {
    try {
      const workspace = await client.get(`/api/workspaces/${config.workspace_id}`) as {
        syncMode: 'server' | 'client'
      }
      const resolved = workspace.syncMode === 'server' ? 'server' as const : 'client' as const

      upgradeMarginsJson(config, resolved, configDir)
      return resolved
    } catch {
      console.error(
        'Cannot determine sync mode: server unreachable.\n' +
        'Run again with network access, or manually add "syncMode": "client" ' +
        '(or "server") to .margins.json'
      )
      process.exit(1)
    }
  }

  return 'client'
}

function upgradeMarginsJson(
  config: LocalConfig,
  syncMode: 'server' | 'client',
  configDir?: string,
): void {
  const dir = configDir ?? process.cwd()
  const configPath = path.join(dir, '.margins.json')
  if (!fs.existsSync(configPath)) return

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    raw.syncMode = syncMode
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8')
  } catch {
    // Non-fatal: upgrade is best-effort
  }
}
