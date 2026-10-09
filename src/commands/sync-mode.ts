/**
 * `margins sync-mode push [workspace]` — switch a GitHub workspace from
 * pulling to push, with no trust binding and no workflow (ai-review#282, user
 * story 6). For people who push from the desktop app or `margins workspace push`; the
 * workflow path is `margins install`, which switches the same way first.
 *
 * Same gate as install: the consequences are printed, then `--yes` accepts, a
 * terminal prompts, and a session that cannot ask is refused — nothing is
 * switched silently. Idempotent: an already-pushed workspace reports so.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { LocalConfig, ResolvedConfig } from '../lib/config.js'
import { readLocalConfig } from '../lib/config.js'
import { createApiClient, type ApiClient } from '../lib/api-client.js'
import { ValidationError } from '../lib/errors.js'
import { formatJson } from '../lib/output.js'
import { detectGitRemote, parseGithubUrl } from '../lib/detect-git-remote.js'
import { fetchWorkspaceList, findWorkspaceByRepoUrl } from '../lib/audit-checks.js'
import { resolveWorkspaceBySlug } from '../lib/resolve-workspace.js'
import { upgradeMarginsJson } from '../lib/resolve-sync-mode.js'
import { parseFileSyncMode } from '../lib/sync-mode.js'
import {
  acceptSwitch, fetchSyncStatus, switchConsequences, switchToPush,
} from '../lib/sync-mode-switch.js'

export interface SyncModeOpts {
  yes?: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `push` is the only switch. `client` — the API value, accepted before 0.23.0 —
 * is refused with the command that replaced it; `pull` (and `server`) is a
 * switch that does not exist yet.
 */
function parseMode(raw: string): 'push' {
  if (raw === 'push') return 'push'
  if (raw === 'server' || raw === 'pull') {
    throw new ValidationError('Switching a workspace back to pull from GitHub is not available yet.')
  }
  throw new ValidationError(`Unknown sync mode "${raw}". Use: margins sync-mode push`)
}

async function findByRepo(client: ApiClient, fullName: string): Promise<{ id: string; label: string }> {
  const workspaces = await fetchWorkspaceList(client)
  const found = findWorkspaceByRepoUrl(workspaces, fullName)
  if (!found) throw new ValidationError(`No workspace you are a member of is connected to ${fullName}.`)
  return { id: found.id, label: found.slug }
}

/**
 * The workspace to switch: a UUID, an `owner/repo` or GitHub URL, or a slug;
 * with no argument, `.margins.json`, then the folder's GitHub origin.
 */
async function resolveTarget(
  client: ApiClient,
  arg: string | undefined,
): Promise<{ id: string; label: string }> {
  if (arg) {
    if (UUID.test(arg)) return { id: arg, label: arg }
    // Slugs have three segments (`gh/owner/repo`); `owner/repo` has two.
    if (arg.includes('github.com') || /^[^/\s]+\/[^/\s]+$/.test(arg)) {
      const repo = parseGithubUrl(arg.includes('github.com') ? arg : `https://github.com/${arg}`)
      if (repo.type !== 'github') throw new ValidationError(`Not a GitHub repository: ${arg}`)
      return findByRepo(client, `${repo.owner}/${repo.repo}`)
    }
    const ws = await resolveWorkspaceBySlug(client, arg)
    return { id: ws.id, label: arg }
  }
  // No rewrite here: if this file still says "server", `updateLocalConfig`
  // rewrites it once, to "push", after the switch.
  const local = readLocalConfig({ upgradeDeprecated: false })
  if (local?.workspace_id) return { id: local.workspace_id, label: local.workspace_slug ?? local.workspace_id }
  const remote = detectGitRemote(process.cwd())
  if (remote.type === 'github') return findByRepo(client, `${remote.owner}/${remote.repo}`)
  throw new ValidationError(
    'No workspace to switch. Pass one (owner/repo, a workspace slug or id), or run this ' +
    'inside the repository.',
  )
}

export async function handleSyncMode(
  cfg: ResolvedConfig,
  mode: string,
  workspaceArg: string | undefined,
  opts: SyncModeOpts,
): Promise<void> {
  parseMode(mode) // local, pre-network: a typo must not cost a request
  const client = createApiClient(cfg)
  const target = await resolveTarget(client, workspaceArg)

  const status = await fetchSyncStatus(client, target.id)
  const repository = status?.repository ?? target.label

  // Known to push already: no consequences to accept. The POST still goes out —
  // it is idempotent, and the server, not this read, has the last word.
  if (status?.syncMode !== 'push') {
    if (!cfg.json) console.error(switchConsequences(repository, status, 'anything').join('\n'))
    const acceptance = await acceptSwitch({ yes: opts.yes, json: cfg.json })
    if (acceptance === 'not-interactive') {
      throw new ValidationError(
        'This session is not interactive, so the switch cannot be confirmed here — ' +
        'nothing was changed. Re-run with --yes to accept it.',
      )
    }
    if (acceptance === 'declined' || acceptance === 'cancelled') {
      console.error('Cancelled — nothing was changed.')
      return
    }
  }

  const result = await switchToPush(client, target.id)
  updateLocalConfig(target.id)

  if (cfg.json) {
    console.log(formatJson({ workspaceId: target.id, repository, ...result }))
    return
  }
  if (result.switched) {
    console.log(
      `Switched ${repository} to push. Margins no longer pulls it from GitHub; ` +
      'content stays as it is until the first push.',
    )
  } else {
    const repaired = repairedBranchNames(result.repairedBranches)
    console.log(repaired.length > 0
      ? `${repository} is already pushed to Margins. ${repairedSentence(repaired)}`
      : `${repository} is already pushed to Margins — nothing was changed.`)
  }
}

/** The branch names in a `repairedBranches` answer (Margins 0.77.1+); [] when absent. */
function repairedBranchNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((b): b is string => typeof b === 'string' && b !== '') : []
}

function repairedSentence(branches: string[]): string {
  if (branches.length === 1) {
    return `Repaired the head of ${branches[0]} so pushes to it are accepted again.`
  }
  const list = `${branches.slice(0, -1).join(', ')} and ${branches[branches.length - 1]}`
  return `Repaired the heads of ${list} so pushes to them are accepted again.`
}

/**
 * After a switch, the folder's own .margins.json must say "push" (it may say
 * "pull", or a deprecated "server" / "client"):
 * `install-hook` and `margins sync` read that field directly, and would keep
 * refusing a workspace that now takes pushes. Only the file bound to the
 * workspace just switched is touched. Best effort; `margins workspace push`
 * re-checks with the server anyway.
 */
function updateLocalConfig(workspaceId: string): void {
  let dir = process.cwd()
  for (;;) {
    const candidate = path.join(dir, '.margins.json')
    if (fs.existsSync(candidate)) {
      try {
        const local = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as LocalConfig
        // One rewrite, one line — even from a deprecated "server", which is
        // not first rewritten to "pull" on the way.
        const fileMode = parseFileSyncMode(local.syncMode)
        const stale = fileMode?.mode === 'pull' || fileMode?.deprecated !== undefined
        if (local.workspace_id === workspaceId && stale && upgradeMarginsJson(local, 'push', dir)) {
          console.error(`Updated ${candidate} to "syncMode": "push" — commit it.`)
        }
      } catch {
        // Malformed file: leave it alone.
      }
      return
    }
    const parent = path.dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}
