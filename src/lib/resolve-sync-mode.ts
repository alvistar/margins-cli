import * as fs from 'node:fs'
import * as path from 'node:path'
import type { LocalConfig } from './config.js'
import type { ApiClient } from './api-client.js'
import { ValidationError } from './errors.js'
import {
  deprecatedRewriteLine, fromApiSyncMode, parseFileSyncMode, type SyncMode,
} from './sync-mode.js'

/**
 * Read a workspace's sync mode from the detail endpoint, `GET /api/workspaces/:id`.
 *
 * The route answers `{ workspace: { syncMode, ... }, tree, ... }`; the flat
 * shape is read too, for a server that ever answers it. A missing or unknown
 * value is `null` — NEVER push. Reading the top level of the nested shape is
 * how every workspace used to come back as push, including ones that pull
 * from GitHub (ai-review#282, user story 33).
 */
export async function fetchWorkspaceSyncMode(
  client: ApiClient,
  workspaceId: string,
): Promise<SyncMode | null> {
  const raw = await client.get(`/api/workspaces/${encodeURIComponent(workspaceId)}`) as {
    workspace?: { syncMode?: unknown }
    syncMode?: unknown
  } | null
  return fromApiSyncMode(raw?.workspace?.syncMode ?? raw?.syncMode)
}

/**
 * Resolve the workspace's sync mode from .margins.json, handling the
 * deprecated `client` / `server` values and the legacy `mode` field.
 *
 * Priority:
 * 1. syncMode "push" -> return directly
 * 2. syncMode "pull" -> confirm with the server: a workspace switched to push
 *    since the file was written answers push, and the file is upgraded.
 *    Any other answer, or none, keeps "pull" — the file's own claim.
 *    (`client` / `server` read as push / pull; the file is rewritten to the
 *    new word, with ONE line on stderr whichever rewrite happens.)
 * 3. mode: "local" (legacy) -> always push
 * 4. mode: "overlay" (legacy, ambiguous) -> query server, upgrade file in-place;
 *    a server that reports no mode is refused, never read as push
 * 5. Missing both -> default to push (safe fallback)
 */
export async function resolveSyncMode(
  config: LocalConfig,
  client: ApiClient,
  configDir?: string,
): Promise<SyncMode> {
  const fileMode = parseFileSyncMode(config.syncMode)

  if (fileMode?.mode === 'push') {
    if (fileMode.deprecated) rewriteAlias(config, fileMode.deprecated, 'push', configDir)
    return 'push'
  }

  if (fileMode?.mode === 'pull') {
    // The one way a file's "pull" goes stale is the sync mode switch — and
    // then the first push after it must not be refused on a local memory.
    if (config.workspace_id) {
      try {
        if (await fetchWorkspaceSyncMode(client, config.workspace_id) === 'push') {
          // .margins.json is usually committed, so this rewrite shows up as a
          // change in the working tree. Say so rather than dirtying it silently.
          if (upgradeMarginsJson(config, 'push', configDir)) {
            console.error(
              '.margins.json said this workspace pulls from GitHub; it has switched to push. ' +
              'Updated the file to "syncMode": "push" — commit it.',
            )
          }
          return 'push'
        }
      } catch {
        // Unreachable: keep the file's claim, which is what this returned before.
      }
    }
    if (fileMode.deprecated) rewriteAlias(config, fileMode.deprecated, 'pull', configDir)
    return 'pull'
  }

  if (config.mode === 'local') return 'push'

  if (config.mode === 'overlay' && config.workspace_id) {
    let resolved: SyncMode | null
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
        'Run again with network access, or manually add "syncMode": "push" ' +
        '(or "pull") to .margins.json'
      )
    }
    if (resolved === null) {
      throw new ValidationError(
        'Cannot determine sync mode: the server did not report one for this workspace.\n' +
        'Add "syncMode": "push" (pushed to Margins) or "pull" (pulled from GitHub) ' +
        'to .margins.json'
      )
    }
    upgradeMarginsJson(config, resolved, configDir)
    return resolved
  }

  return 'push'
}

/** A deprecated alias that still holds: rewrite it to the new word, with the alias line. */
function rewriteAlias(
  config: LocalConfig,
  from: 'client' | 'server',
  to: SyncMode,
  configDir?: string,
): void {
  // Only when the FILE still holds the alias: a caller that read it through
  // `readLocalConfig` has already rewritten it, and said so.
  const configPath = path.join(configDir ?? process.cwd(), '.margins.json')
  try {
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { syncMode?: unknown }
    if (onDisk?.syncMode !== from) return
  } catch {
    return
  }
  if (upgradeMarginsJson(config, to, configDir)) console.error(deprecatedRewriteLine(from, to))
}

/** Rewrite `syncMode` in the folder's .margins.json. True when the file was written. */
export function upgradeMarginsJson(
  config: LocalConfig,
  syncMode: SyncMode,
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
