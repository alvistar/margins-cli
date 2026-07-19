import * as fs from 'node:fs'
import * as path from 'node:path'
import type { LocalConfig } from './config.js'
import type { ApiClient } from './api-client.js'
import { ValidationError } from './errors.js'

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
      // THROWS; this used to `console.error` + `process.exit(1)`.
      //
      // Exiting is right for a human at a terminal and wrong for every other
      // caller — and there is another caller: the background hook orchestrator
      // reaches here once per branch (`handleHookSync` → `handlePush`). A
      // `process.exit` there does not refuse ONE branch, it kills the process,
      // so the branches queued behind it never sync and no failure is recorded
      // for any of them, which is exactly what R17 forbids. Worse, `process.exit`
      // skips pending `finally` blocks, so the per-branch lock directory
      // `withBranchLock` holds is never removed and the next sync of that branch
      // waits out the full stale-lock timeout.
      //
      // The top-level CLI handler turns this back into the same message on
      // stderr and the same non-zero exit, so the human case is unchanged.
      // (This is the same treatment already applied to the server-sync gate in
      // `push.ts`; that fix missed this site.)
      throw new ValidationError(
        'Cannot determine sync mode: server unreachable.\n' +
        'Run again with network access, or manually add "syncMode": "client" ' +
        '(or "server") to .margins.json'
      )
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
