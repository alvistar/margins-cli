import * as fs from 'node:fs'
import * as path from 'node:path'
import type { LocalConfig } from './config.js'
import type { ApiClient } from './api-client.js'
import { ValidationError } from './errors.js'

/**
 * Read a workspace's syncMode from the detail endpoint, `GET /api/workspaces/:id`.
 *
 * The route answers `{ workspace: { syncMode, ... }, tree, ... }`; the flat
 * shape is read too, for a server that ever answers it. A missing or unknown
 * value is `null` — NEVER client. Reading the top level of the nested shape is
 * how every workspace used to come back as client, including ones that pull
 * from GitHub (ai-review#282, user story 33).
 */
export async function fetchWorkspaceSyncMode(
  client: ApiClient,
  workspaceId: string,
): Promise<'server' | 'client' | null> {
  const raw = await client.get(`/api/workspaces/${encodeURIComponent(workspaceId)}`) as {
    workspace?: { syncMode?: unknown }
    syncMode?: unknown
  } | null
  const value = raw?.workspace?.syncMode ?? raw?.syncMode
  return value === 'server' || value === 'client' ? value : null
}

/**
 * Resolve the workspace's syncMode from .margins.json, handling legacy
 * `mode: "overlay"` by querying the server.
 *
 * Priority:
 * 1. syncMode "client" -> return directly
 * 2. syncMode "server" -> confirm with the server: a workspace switched to push
 *    since the file was written answers "client", and the file is upgraded.
 *    Any other answer, or none, keeps "server" — the file's own claim.
 * 3. mode: "local" (legacy) -> always "client"
 * 4. mode: "overlay" (legacy, ambiguous) -> query server, upgrade file in-place;
 *    a server that reports no mode is refused, never read as client
 * 5. Missing both -> default to "client" (safe fallback)
 */
export async function resolveSyncMode(
  config: LocalConfig,
  client: ApiClient,
  configDir?: string,
): Promise<'server' | 'client'> {
  if (config.syncMode === 'client') return 'client'

  if (config.syncMode === 'server') {
    // The one way a file's "server" goes stale is the sync mode switch — and
    // then the first push after it must not be refused on a local memory.
    if (!config.workspace_id) return 'server'
    try {
      if (await fetchWorkspaceSyncMode(client, config.workspace_id) === 'client') {
        // .margins.json is usually committed, so this rewrite shows up as a
        // change in the working tree. Say so rather than dirtying it silently.
        if (upgradeMarginsJson(config, 'client', configDir)) {
          console.error(
            '.margins.json said this workspace pulls from GitHub; it has switched to push. ' +
            'Updated the file to "syncMode": "client" — commit it.',
          )
        }
        return 'client'
      }
    } catch {
      // Unreachable: keep the file's claim, which is what this returned before.
    }
    return 'server'
  }

  if (config.mode === 'local') return 'client'

  if (config.mode === 'overlay' && config.workspace_id) {
    let resolved: 'server' | 'client' | null
    try {
      resolved = await fetchWorkspaceSyncMode(client, config.workspace_id)
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
    if (resolved === null) {
      throw new ValidationError(
        'Cannot determine sync mode: the server did not report one for this workspace.\n' +
        'Add "syncMode": "client" (pushed to Margins) or "server" (pulled from GitHub) ' +
        'to .margins.json'
      )
    }
    upgradeMarginsJson(config, resolved, configDir)
    return resolved
  }

  return 'client'
}

/** Rewrite `syncMode` in the folder's .margins.json. True when the file was written. */
export function upgradeMarginsJson(
  config: LocalConfig,
  syncMode: 'server' | 'client',
  configDir?: string,
): boolean {
  const dir = configDir ?? process.cwd()
  const configPath = path.join(dir, '.margins.json')
  if (!fs.existsSync(configPath)) return false

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    raw.syncMode = syncMode
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8')
    return true
  } catch {
    // Non-fatal: upgrade is best-effort
    return false
  }
}
