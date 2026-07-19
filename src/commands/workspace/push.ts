import { readFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { execSync, type StdioOptions } from 'node:child_process'
import { registryPath } from '../../lib/registry.js'
import type { ResolvedConfig, LocalConfig } from '../../lib/config.js'
import { createApiClient } from '../../lib/api-client.js'
import { formatJson } from '../../lib/output.js'
import { ValidationError } from '../../lib/errors.js'
import { resolveSyncMode } from '../../lib/resolve-sync-mode.js'
import {
  casSync, emptyCollectionMessage, fetchSyncPreflight, parseContentModeFlag,
  resolveContentMode, type CasSyncResult,
} from '../../lib/cas-sync.js'
import { collectForMode, probeSyncSource, skipOversized } from '../../lib/collect-sync-files.js'
import type { CollectedSyncFiles } from '../../lib/collect-sync-files.js'
import type { ContentMode } from '../../lib/cas-sync.js'

// Re-exported for backwards compatibility — implementation moved to lib.
export { globMarkdown } from '../../lib/collect-sync-files.js'

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

export type CollectForMode = (
  dir: string,
  mode: ContentMode,
  opts?: { maxBlobSize?: number; rev?: string },
) => CollectedSyncFiles

// ─── Push handler ────────────────────────────────────────────────────────────

export async function handlePush(
  cfg: ResolvedConfig,
  opts: {
    workspace?: string
    project?: string
    dir?: string
    branch?: string
    confirmFullDelete?: boolean
    contentMode?: string
    /**
     * Committed mode only: the exact commit to collect. Hooks resolve this to an
     * immutable object id BEFORE backgrounding, so it is never `HEAD` — a
     * symbolic ref handed to a background process resolves to whatever the
     * branch points at by the time that process gets around to it. Ignored in
     * working-tree mode, where the filesystem is the source of truth.
     */
    rev?: string
    /**
     * Collector seam. Defaults to {@link collectForMode}; the hook orchestrator
     * passes a memoized one so a multi-ref push at a single object id reads the
     * tree once rather than once per branch.
     */
    collect?: CollectForMode
  }
): Promise<void> {
  const client = createApiClient(cfg)
  const cwd = opts.dir ?? process.cwd()

  // Parsed first: an unusable flag value is a local mistake and costs no network.
  const requestedMode = parseContentModeFlag(opts.contentMode)

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

  // Gate: refuse to push to server-sync workspaces (they sync via webhook).
  //
  // This THROWS; it used to `console.error` + `process.exit(1)`. Exiting is
  // correct for a human at a terminal and wrong for every other caller: reached
  // from `handleHookSync`, it killed the whole background process, so the
  // branches queued behind this one never synced and no failure was recorded
  // for any of them — bypassing R17, which requires one failing branch not to
  // stop the others. The top-level CLI handler turns the throw back into the
  // same message on stderr and the same non-zero exit.
  //
  // The resolution runs inside the try (a malformed `.margins.json`, or an
  // unreachable server, must not be mistaken for a refusal) but the refusal
  // itself is raised OUTSIDE it — a throw from within would be swallowed by the
  // very catch that exists to tolerate those two cases.
  const localCfgForSync = join(cwd, '.margins.json')
  let resolvedSyncMode: 'server' | 'client' | undefined
  if (existsSync(localCfgForSync)) {
    try {
      const localCfg = JSON.parse(readFileSync(localCfgForSync, 'utf-8')) as LocalConfig
      resolvedSyncMode = await resolveSyncMode(localCfg, client, cwd)
    } catch {
      // Malformed .margins.json or server unreachable — resolveSyncMode handles exit
    }
  }
  if (resolvedSyncMode === 'server') {
    throw new ValidationError(
      'This workspace uses server-managed sync. Use `margins workspace sync` instead.',
    )
  }

  // Cheap local probe: a wrong directory fails here, before any network call.
  probeSyncSource(cwd)

  // Resolve the branch: an explicit --branch wins (CI often checks out a detached
  // HEAD, where git rev-parse yields "HEAD", and the delete-event path has no
  // checkout at all), else detect the current git branch. (SHAs are computed
  // inside casSync — synthetic manifest hash + server headSha, never git SHAs.)
  const branch = opts.branch ?? gitBranch(cwd)

  // Settle the content mode BEFORE collecting anything (KTD3): the workspace
  // decides, a contradicting flag is refused here, and a server that reports no
  // mode refuses a committed push rather than letting it apply unenforced.
  const preflight = await fetchSyncPreflight(client, workspaceId, branch)
  const contentMode = resolveContentMode(preflight, requestedMode)

  // Collect markdown files + referenced images (.marginsignore applied)
  const collected = (opts.collect ?? collectForMode)(
    cwd,
    contentMode,
    opts.rev ? { rev: opts.rev } : {},
  )
  const { mdCount, oversized } = collected

  // R8: say why nothing is going out — and keep going. This used to throw, which
  // meant the full-delete guard in casSync was unreachable from here: an empty
  // push against a POPULATED branch has to reach that guard, because refusing
  // the destructive case is its job, not this check's. Same wording as `sync`.
  if (mdCount === 0) {
    process.stderr.write(`${emptyCollectionMessage(cwd, contentMode)}\n`)
  }

  // Oversized blobs are skipped (excluded from upload AND manifest) — one
  // >2 MB file must not 413-abort the whole push. Reported on stderr.
  const syncFiles = skipOversized(collected)

  // Sync via CAS protocol
  const result: CasSyncResult = await casSync(
    client,
    workspaceId,
    branch,
    syncFiles,
    {
      preflight,
      contentMode,
      confirmFullDelete: opts.confirmFullDelete,
      // Committed mode only — the collector resolved the commit, so it is the
      // only thing that knows the sha and the repository's object format (R10).
      gitProvenance: collected.gitProvenance,
    },
  )

  if (cfg.json) {
    console.log(formatJson({
      ...result,
      ...(oversized.length > 0
        ? { skippedOversized: oversized.length, oversizedPaths: oversized.map((f) => f.path) }
        : {}),
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
    if (oversized.length > 0) {
      line += ` — ${oversized.length} oversized file(s) skipped`
    }
    console.log(line)
  }
}

// ─── Hook orchestration ──────────────────────────────────────────────────────
//
// Both installed git hooks invoke `margins workspace hook-sync`. The hook script
// itself does only what MUST happen synchronously — resolve git's state before
// the process backgrounds — and everything below runs in the background process.
//
// KTD7: a pre-push hook runs BEFORE the remote accepts the push. A rejected push
// leaves Margins ahead of the remote. These hooks mirror local intent; nothing
// here can, or claims to, guarantee otherwise.

/** One branch of a workspace, and the commit to put on it. */
export interface RefSync {
  rev: string
  branch: string
}

export interface HookSyncResult {
  branch: string
  rev: string
  ok: boolean
  error?: string
}

const ZERO_SHA = /^0+$/
const HEADS_PREFIX = 'refs/heads/'

/**
 * Parse the ref lines git feeds a `pre-push` hook on stdin.
 *
 * Each line is `<local ref> <local object id> <remote ref> <remote object id>`.
 * Two halves of that line matter and they are NOT the same half:
 *
 *  - the CONTENT comes from the **local** object id — the commit being sent;
 *  - the DESTINATION comes from the **remote** ref — so `git push origin
 *    local-name:remote-name` lands on `remote-name`, which is what the remote
 *    will actually hold.
 *
 * Neither is `HEAD`. The old hook asked `rev-parse --abbrev-ref HEAD`, which
 * answers "where are you standing", not "what did you push".
 *
 * Refs that are not branches produce no sync: a tag is not a workspace branch,
 * and a deletion (git names it with an all-zero local object id) has no tree to
 * collect.
 */
export function parsePrePushRefs(input: string): RefSync[] {
  const out: RefSync[] = []
  for (const raw of input.split('\n')) {
    const parts = raw.trim().split(/\s+/)
    if (parts.length < 3) continue
    const localSha = parts[1]!
    const remoteRef = parts[2]!
    if (ZERO_SHA.test(localSha)) continue          // deletion
    if (!remoteRef.startsWith(HEADS_PREFIX)) continue  // tag, note, anything else
    out.push({ rev: localSha, branch: remoteRef.slice(HEADS_PREFIX.length) })
  }
  return out
}

/**
 * One collection per (mode, rev). Two refs at one object id name one immutable
 * tree, so reading it twice is pure waste — but they are still two branches, and
 * each needs its own branch write. Dedupe the read, never the write.
 */
function memoCollect(): CollectForMode {
  const cache = new Map<string, CollectedSyncFiles>()
  return (dir, mode, o = {}) => {
    const key = `${dir}\0${mode}\0${o.rev ?? ''}`
    const hit = cache.get(key)
    if (hit) return hit
    const fresh = collectForMode(dir, mode, o)
    cache.set(key, fresh)
    return fresh
  }
}

// A lock older than this had its holder killed (a terminated `git push`, a
// reboot). Break it rather than blocking every future sync forever.
const LOCK_STALE_MS = 10 * 60 * 1000
// How long to wait for another sync of the SAME branch. Past this we proceed
// anyway: a hook that never syncs is worse than one that races.
const LOCK_WAIT_MS = 2 * 60 * 1000
const LOCK_POLL_MS = 25

function branchLockPath(dir: string, branch: string): string {
  const key = createHash('sha256').update(`${dir}\0${branch}`).digest('hex').slice(0, 32)
  return join(dirname(registryPath()), 'hook-locks', `${key}.lock`)
}

/**
 * Serialize syncs to one workspace branch, across processes.
 *
 * Two `git push`es in quick succession start two independent background syncs
 * against the same branch. Left to race, the slower one finishes last and the
 * branch ends up at whichever commit happened to be slower to upload — quite
 * possibly the older one. Serializing on (folder, branch) makes the later sync
 * apply after the earlier one, so completion order follows git's order.
 *
 * The lock is a directory: `mkdir` is atomic on every platform we run on, which
 * an "exists? then create" check is not.
 */
async function withBranchLock<T>(dir: string, branch: string, fn: () => Promise<T>): Promise<T> {
  const lock = branchLockPath(dir, branch)
  mkdirSync(dirname(lock), { recursive: true })

  let held = false
  const deadline = Date.now() + LOCK_WAIT_MS
  while (!held) {
    try {
      mkdirSync(lock)
      held = true
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        rmSync(lock, { recursive: true, force: true })
        continue
      }
    } catch {
      continue  // vanished between the mkdir and the stat — try to take it
    }
    if (Date.now() > deadline) break
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS))
  }

  try {
    return await fn()
  } finally {
    if (held) rmSync(lock, { recursive: true, force: true })
  }
}

function causeOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * One line per distinct cause, naming every branch it hit.
 *
 * The failures a hook actually produces are overwhelmingly shared: an
 * unreachable server, an expired key, a mode refusal. Repeating one identical
 * sentence once per branch buries the single thing worth reading.
 */
function reportHookFailures(results: HookSyncResult[]): void {
  const byCause = new Map<string, string[]>()
  for (const r of results) {
    if (r.ok) continue
    const branches = byCause.get(r.error!) ?? []
    branches.push(r.branch)
    byCause.set(r.error!, branches)
  }
  for (const [cause, branches] of byCause) {
    process.stderr.write(`margins: sync failed for ${branches.join(', ')} — ${cause}\n`)
  }
}

/**
 * The background half of both git hooks.
 *
 * `pre-push` supplies git's ref lines; `post-commit` supplies the object id it
 * resolved and the branch it was on. Every branch syncs independently: one
 * failure is recorded and the rest still go (R17).
 */
export async function handleHookSync(
  cfg: ResolvedConfig,
  opts: {
    event?: string
    /** pre-push: git's raw ref lines, read from the hook's stdin. */
    refs?: string
    /** post-commit: the object id the hook resolved before backgrounding. */
    rev?: string
    branch?: string
    dir?: string
  },
): Promise<HookSyncResult[]> {
  const cwd = opts.dir ?? process.cwd()

  const targets: Array<{ rev: string; branch?: string }> = opts.event === 'pre-push'
    ? parsePrePushRefs(opts.refs ?? '')
    // On a detached HEAD the hook's `symbolic-ref -q` prints nothing, so the
    // branch arrives empty. Drop it rather than pushing to a branch named "",
    // and let handlePush fall back to its own detection.
    : (opts.rev ? [{ rev: opts.rev, branch: opts.branch || undefined }] : [])

  // A tags-only push, a deletion, or a hook that could not resolve a commit:
  // nothing is collected and nothing is sent.
  if (targets.length === 0) return []

  const collect = memoCollect()
  const results: HookSyncResult[] = []

  for (const target of targets) {
    const branch = target.branch ?? gitBranch(cwd)
    try {
      await withBranchLock(cwd, branch, () =>
        handlePush(cfg, { dir: cwd, branch, rev: target.rev, collect }))
      results.push({ branch, rev: target.rev, ok: true })
    } catch (err) {
      // R17: this branch is done, the next one still runs.
      results.push({ branch, rev: target.rev, ok: false, error: causeOf(err) })
    }
  }

  reportHookFailures(results)
  return results
}
