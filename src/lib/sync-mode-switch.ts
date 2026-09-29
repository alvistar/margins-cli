/**
 * The sync mode switch (ai-review#282): move a GitHub workspace from pulling
 * (Margins reads the repo) to pushing (a workflow or a person sends content).
 *
 * Shared by `margins install`, which switches before it binds and opens the
 * workflow PR, and `margins sync-mode client`, which only switches. One owner
 * for three things both need:
 *
 *   - the consequences, stated before anything changes (U7's four points);
 *   - the acceptance gate: `--yes`, else a prompt, else a refusal — a session
 *     that cannot ask must never switch silently;
 *   - the error mapping, so a 409/403/422 reads the same from either command.
 *
 * Words (U11): output says "pull" and "push", never `server` / `client`. The
 * API values stay in the request body and in `--json`.
 */
import * as p from '@clack/prompts'
import type { ApiClient } from './api-client.js'
import {
  ConflictError, ForbiddenError, NotFoundError, ServerError, ValidationError,
} from './errors.js'

// ─── Server shapes (margins/src/lib/services/workspace-sync-status.ts) ────────

export interface SyncStatus {
  syncMode: 'server' | 'client'
  /** `owner/repo`, or null for a workspace with no GitHub side. */
  repository: string | null
  credential: {
    source: 'installation' | 'oauth' | 'none'
    installationAccount: string | null
    holder: { id: string; name: string | null; githubLogin: string | null } | null
  }
  canManagePolicy: boolean
}

export interface SwitchResult {
  syncMode: 'client'
  switched: boolean
  checkpoints?: unknown
  prunedBranches?: unknown
}

/** The refusal a non-creator gets, in the server's words (route 403). */
const NOT_CREATOR =
  'Only the workspace creator can change how it syncs. It decides what the workspace accepts for everyone.'

// ─── Status read ──────────────────────────────────────────────────────────────

/**
 * `GET /api/workspaces/:id/sync`, used to NAME the access the switch removes.
 *
 * Best effort for every failure except a 403: the endpoint is edit-only, and
 * so is the switch, so a caller refused here would be refused by the switch
 * too — telling them now beats a prompt they cannot act on. Anything else
 * (network, an unexpected shape) drops the access line and carries on; the
 * switch itself stays the authority on whether it is allowed.
 */
export async function fetchSyncStatus(
  client: ApiClient,
  workspaceId: string,
): Promise<SyncStatus | null> {
  let raw: unknown
  try {
    raw = await client.get(`/api/workspaces/${encodeURIComponent(workspaceId)}/sync`)
  } catch (err) {
    if (err instanceof ForbiddenError) throw new ValidationError(err.serverMessage ?? NOT_CREATOR)
    return null
  }
  const s = raw as Partial<SyncStatus> | null
  if (!s || (s.syncMode !== 'server' && s.syncMode !== 'client') || !s.credential) return null
  if (s.canManagePolicy === false) throw new ValidationError(NOT_CREATOR)
  return s as SyncStatus
}

// ─── Consequences ─────────────────────────────────────────────────────────────

/** The access line (U7 point 2), or null when there is no access to remove. */
function accessLine(status: SyncStatus | null): string | null {
  if (!status) {
    return 'The GitHub access Margins uses for this workspace is removed from it.'
  }
  const { source, installationAccount, holder } = status.credential
  if (source === 'installation' && installationAccount) {
    return `The GitHub access it uses, the Margins GitHub App on ${installationAccount}, is removed from this workspace.`
  }
  if (holder) {
    const who = holder.name ?? holder.githubLogin ?? 'a member'
    return `The GitHub access it uses, ${who}'s account, is removed from this workspace.`
  }
  return null
}

/**
 * What the switch changes, as the lines printed before it runs.
 *
 * `firstPush` says what will push: install names the workflow, the standalone
 * command does not know (the desktop app, `margins workspace push`, a workflow later).
 */
export function switchConsequences(
  repository: string,
  status: SyncStatus | null,
  firstPush: 'the workflow' | 'anything',
): string[] {
  const access = accessLine(status)
  return [
    `Switching ${repository} to push:`,
    `  - Margins stops pulling ${repository} from GitHub.`,
    ...(access ? [`  - ${access}`] : []),
    firstPush === 'the workflow'
      ? '  - Content stays as it is until the workflow\'s first push.'
      : '  - Content stays as it is until the first push.',
    '  - Discussions, documents and history are kept.',
    'There is no switch back to pull yet.',
  ]
}

// ─── Acceptance ───────────────────────────────────────────────────────────────

export type Acceptance = 'accepted' | 'declined' | 'cancelled' | 'not-interactive'

/**
 * `--yes` accepts; a session that cannot ask (no TTY, or `--json`) is
 * `not-interactive` and the CALLER refuses — install turns that into a per-repo
 * failure (exit 1) and an `--org` run continues, the standalone command into an
 * error. Only a real terminal prompts. Ctrl-C is `cancelled`, not `declined`:
 * the person meant to stop the whole run, not to skip one repo.
 */
export async function acceptSwitch(opts: { yes?: boolean; json?: boolean }): Promise<Acceptance> {
  if (opts.yes) return 'accepted'
  if (!process.stdin.isTTY || opts.json) return 'not-interactive'
  const ok = await p.confirm({ message: 'Switch to push?', initialValue: false })
  if (p.isCancel(ok)) return 'cancelled'
  return ok ? 'accepted' : 'declined'
}

// ─── The switch ───────────────────────────────────────────────────────────────

/** `POST /api/workspaces/:id/sync-mode`. Throws a mapped, user-facing error. */
export async function switchToPush(client: ApiClient, workspaceId: string): Promise<SwitchResult> {
  try {
    const res = await client.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/sync-mode`, { syncMode: 'client' }) as
      Partial<SwitchResult> | null
    return {
      syncMode: 'client',
      switched: res?.switched === true,
      ...(res?.checkpoints !== undefined ? { checkpoints: res.checkpoints } : {}),
      ...(res?.prunedBranches !== undefined ? { prunedBranches: res.prunedBranches } : {}),
    }
  } catch (err) {
    throw mapSwitchError(err)
  }
}

/**
 * The route's refusals, each as a line a person can act on. Where the server
 * words its refusal for a human (403, both 422s, the 500) its message wins:
 * the blocked case names the exact file and branch, which the CLI cannot know.
 * Every fallback repeats the one fact that matters: nothing was changed.
 */
export function mapSwitchError(err: unknown): Error {
  if (err instanceof ConflictError && err.code === 'SYNC_IN_PROGRESS') {
    return new ValidationError(
      err.serverMessage ??
        'A sync is running on this workspace right now. Try again in a minute — nothing was changed.',
    )
  }
  if (err instanceof ForbiddenError) {
    return new ValidationError(err.serverMessage ?? NOT_CREATOR)
  }
  if (err instanceof NotFoundError) {
    // A 404 with no error body is a route this server does not have.
    return new ValidationError(
      err.code
        ? 'Workspace not found — nothing was changed.'
        : 'This Margins server cannot switch a workspace to push. Upgrade the server, then retry.',
    )
  }
  if (err instanceof ServerError && err.status === 422) {
    if (err.code === 'SYNC_MODE_SWITCH_BLOCKED') {
      return new ValidationError(
        err.serverMessage ?? 'This workspace holds content the switch cannot carry. Nothing was changed.',
      )
    }
    if (err.code === 'SYNC_MODE_SWITCH_NOT_APPLICABLE') {
      return new ValidationError(
        err.serverMessage ??
          'Only a workspace connected to a GitHub repository can switch to push. Nothing was changed.',
      )
    }
  }
  if (err instanceof ServerError && err.code === 'UPDATE_FAILED') {
    return new ValidationError(err.serverMessage ?? 'Failed to switch to push. Nothing was changed.')
  }
  return err as Error
}
