/**
 * `margins workspace content-mode [mode]` — change what a sync of this
 * workspace sends, with the cost shown first (U8, R13/R14).
 *
 * ─── Why the preview is a local diff, not a dry-run sync (KTD16) ─────────────
 *
 * The preflight the client already makes carries the branch's full path→hash
 * map. Collecting locally in the TARGET mode and taking the set difference
 * names every path the switch would stop sending. That is the entire preview:
 * no writes, no extra round trip beyond the preflight, and nothing uploaded to
 * find out what a push would do.
 *
 * ─── Why it names one branch (KTD16) ────────────────────────────────────────
 *
 * The mode is workspace-wide, but the manifest GET is branch-scoped and a local
 * collection can only resolve what THIS checkout can reach. So the preview says
 * which branch it inspected and lists the workspace's other branches as
 * uninspected, rather than implying a coverage it cannot deliver. Each of those
 * reconciles on its next push (KTD5).
 *
 * ─── What the switch does NOT do (KTD15) ────────────────────────────────────
 *
 * It does not reset the branch head. A mode change alters which files are in
 * the manifest, not the parent pointer, so the first push afterwards is an
 * ordinary fast-forward that happens to delete many paths. Naming those
 * deletions is this preview's whole job — there is no divergence to repair.
 *
 * ─── Ordering ───────────────────────────────────────────────────────────────
 *
 * The preview is built BEFORE the mutation, always, so a wrong preview cannot
 * ship behind a working switch. The non-interactive refusal still prints it
 * first: a refusal whose reason the user cannot see is worse than the prompt it
 * replaces.
 */
import * as p from '@clack/prompts'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync, type StdioOptions } from 'node:child_process'
import { join } from 'node:path'
import type { ResolvedConfig, LocalConfig } from '../../lib/config.js'
import { createApiClient, type ApiClient } from '../../lib/api-client.js'
import { formatJson } from '../../lib/output.js'
import { ConflictError, ForbiddenError, ServerError, ValidationError } from '../../lib/errors.js'
import { fetchSyncPreflight, isContentMode, type ContentMode } from '../../lib/cas-sync.js'
import { collectForMode, isInsideGitRepo } from '../../lib/collect-sync-files.js'

const GIT_STDIO: StdioOptions = ['ignore', 'pipe', 'ignore']

export interface ContentModeOpts {
  /** The target mode. Omitted → report the current mode and change nothing. */
  mode?: string
  workspace?: string
  dir?: string
  /** Branch to inspect for the preview. Default: the current git branch. */
  branch?: string
  /** Accept the preview without prompting — required in a non-interactive run. */
  yes?: boolean
  json?: boolean
}

function gitBranch(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, encoding: 'utf-8', stdio: GIT_STDIO,
    }).trim() || 'main'
  } catch {
    return 'main'
  }
}

/**
 * Parse the positional mode. Deliberately parallel to
 * {@link parseContentModeFlag}'s wording rather than reusing it verbatim: this
 * value arrives as an argument, not as `--content-mode`, and naming the wrong
 * spelling would send the user looking for a flag they did not type.
 */
function parseTargetMode(raw: string): ContentMode {
  if (isContentMode(raw)) return raw
  throw new ValidationError(
    `Unknown content mode "${raw}". Use "working-tree" or "committed".`,
  )
}

/** `--workspace` wins, else `.margins.json` beside the folder being migrated. */
function resolveWorkspaceId(dir: string, explicit: string | undefined): string {
  if (explicit) return explicit
  const cfgPath = join(dir, '.margins.json')
  if (existsSync(cfgPath)) {
    try {
      const local = JSON.parse(readFileSync(cfgPath, 'utf-8')) as LocalConfig
      if (local.workspace_id) return local.workspace_id
    } catch {
      // Malformed .margins.json — fall through to the explicit-flag demand.
    }
  }
  throw new ValidationError(
    'No workspace to change. Pass --workspace <id>, or run this from a folder ' +
    'with a .margins.json (created by `margins sync`).',
  )
}

/**
 * The branches this preview did NOT inspect.
 *
 * A READ (`GET .../branches`), and a best-effort one: a workspace whose branch
 * list cannot be fetched still gets a migration, it just gets an honest "could
 * not be listed" instead of a list. Failing the whole command on a decorative
 * read would be a worse trade than the missing sentence.
 */
async function otherBranches(
  client: ApiClient,
  workspaceId: string,
  inspected: string,
): Promise<{ names: string[]; listed: boolean }> {
  try {
    const resp = await client.get(`/api/workspaces/${workspaceId}/branches`) as {
      branches?: unknown
    } | null
    const all = Array.isArray(resp?.branches)
      ? resp.branches.filter((b): b is string => typeof b === 'string')
      : []
    return { names: all.filter((b) => b !== inspected).sort(), listed: true }
  } catch {
    return { names: [], listed: false }
  }
}

/** What the switch would stop sending on the inspected branch. */
interface Preview {
  branch: string
  from: ContentMode
  to: ContentMode
  /** Paths Margins holds on this branch that the target mode would not send. */
  removed: string[]
  /** Paths the target mode sends that are not on the branch yet. */
  added: string[]
  other: { names: string[]; listed: boolean }
}

function buildPreviewLines(pv: Preview): string[] {
  const lines: string[] = []
  lines.push(`Content mode: ${pv.from} → ${pv.to}`)
  lines.push(`Inspected branch: ${pv.branch}`)
  lines.push('')

  if (pv.removed.length === 0) {
    lines.push(
      `No file currently in Margins on ${pv.branch} would stop being sent — ` +
      `${pv.to} mode collects everything ${pv.from} mode does, on this branch.`,
    )
  } else {
    lines.push(
      `Switching to ${pv.to} mode would stop sending ${pv.removed.length} ` +
      `file(s) currently in Margins on ${pv.branch}:`,
    )
    for (const path of pv.removed) lines.push(`  ${path}`)
    lines.push(
      `They stay in Margins until the next push on ${pv.branch}, which deletes them there. ` +
      'Your local files are never touched.',
    )
  }

  if (pv.added.length > 0) {
    lines.push('')
    lines.push(`${pv.added.length} file(s) not yet in Margins would start being sent.`)
  }

  lines.push('')
  lines.push('This change is workspace-wide, but only ' +
    `${pv.branch} was inspected — the preview above covers that branch alone.`)
  if (!pv.other.listed) {
    lines.push('  The workspace\'s other branches could not be listed, so they are uninspected too.')
  } else if (pv.other.names.length === 0) {
    lines.push('  No other branch is known for this workspace.')
  } else {
    lines.push(`  Not inspected (uninspected): ${pv.other.names.join(', ')}`)
  }
  lines.push('  Every branch reconciles on its next push.')

  return lines
}

export async function handleContentMode(
  cfg: ResolvedConfig,
  opts: ContentModeOpts,
): Promise<void> {
  const isJson = cfg.json || opts.json === true
  const dir = opts.dir ?? process.cwd()

  // Local, pre-network: an unusable mode is a typo and must not cost a request.
  const target = opts.mode === undefined ? undefined : parseTargetMode(opts.mode)

  const workspaceId = resolveWorkspaceId(dir, opts.workspace)
  const hasGitRepo = isInsideGitRepo(dir)

  // R15, locally: committed mode reads from git, so a folder with no repository
  // can never be in it. Refused here rather than as a server 422 — this is a
  // fact about the caller's own filesystem, and refusing it costs no request.
  if (target === 'committed' && !hasGitRepo) {
    throw new ValidationError(
      `Committed mode syncs the tree of a commit, and ${dir} has no git repository — ` +
      'nothing was changed. Keep working-tree mode, or run `git init` and commit first.',
    )
  }

  const client = createApiClient(cfg)
  const branch = opts.branch ?? (hasGitRepo ? gitBranch(dir) : 'main')

  // ─── Read 1 of 2: the preflight the client already makes ───────────────────
  const preflight = await fetchSyncPreflight(client, workspaceId, branch)
  const current = preflight.contentMode

  // KTD2: the mode's ABSENCE is the capability signal. A server that predates
  // this feature strips the field rather than rejecting it, so a migration sent
  // there would report success and store nothing.
  if (current === undefined) {
    throw new ValidationError(
      'This Margins server does not support content mode — it reports none for this ' +
      'workspace, so there is nothing to change. Upgrade the server, then retry.',
    )
  }

  if (target === undefined) {
    // Pure read: report and stop.
    if (isJson) {
      console.log(formatJson({ workspaceId, branch, contentMode: current }))
    } else {
      console.log(`Content mode: ${current}`)
    }
    return
  }

  if (target === current) {
    // Idempotent by construction: the server treats a re-stated mode as a
    // no-op, and there is no reason to spend the request to learn that.
    if (isJson) {
      console.log(formatJson({ workspaceId, contentMode: current, changed: false }))
    } else {
      console.log(`This workspace is already in ${current} mode — nothing was changed.`)
    }
    return
  }

  // ─── The preview, built before anything is mutated ─────────────────────────
  //
  // The local collection in the TARGET mode. Reads the filesystem or a git
  // commit; sends nothing.
  const collected = collectForMode(dir, target)
  const localPaths = new Set(collected.files.map((f) => f.path))
  const serverPaths = Object.keys(preflight.files)

  const preview: Preview = {
    branch,
    from: current,
    to: target,
    removed: serverPaths.filter((path) => !localPaths.has(path)).sort(),
    added: [...localPaths].filter((path) => !(path in preflight.files)).sort(),
    // ─── Read 2 of 2: the branches this preview could not cover ──────────────
    other: await otherBranches(client, workspaceId, branch),
  }

  // The preview payload, shared by both output shapes so the JSON a script
  // reads and the text a human reads can never describe different diffs.
  const previewJson = {
    workspaceId,
    branch,
    from: preview.from,
    to: preview.to,
    wouldStopSending: preview.removed,
    wouldStartSending: preview.added,
    uninspectedBranches: preview.other.names,
    uninspectedBranchesListed: preview.other.listed,
  }

  // Text prints the preview NOW — a human decides against what is on screen.
  // JSON holds it back so exactly one object is emitted per run: a refusal
  // prints the preview alone, a success prints the preview and the result
  // together. Two objects on stdout is not JSON a script can parse.
  if (!isJson) console.log(buildPreviewLines(preview).join('\n'))

  // ─── Acceptance ───────────────────────────────────────────────────────────
  //
  // The flag/non-TTY/prompt triad, in `margins install`'s order: an explicit
  // acceptance wins; a session that cannot ask must be told to state one; only
  // a real terminal prompts.
  if (!opts.yes) {
    if (!process.stdin.isTTY || isJson) {
      // The cost is shown even though the answer is no: a refusal whose reason
      // the caller cannot see is worse than the prompt it replaces.
      if (isJson) console.log(formatJson({ ...previewJson, changed: false }))
      throw new ValidationError(
        'This session is not interactive, so the change above cannot be confirmed here — ' +
        'nothing was changed. Re-run with `--yes` to accept it.',
      )
    }
    const ok = await p.confirm({
      message: `Switch this workspace to ${target} mode?`,
    })
    if (p.isCancel(ok) || !ok) {
      // R13: declining touches nothing — no write went out, and the local files
      // were never candidates for modification in the first place.
      console.log('Content mode unchanged — nothing was changed.')
      return
    }
  }

  // ─── The mutation: one compare-and-swap (KTD5) ────────────────────────────
  //
  // PUT, and `hasGitRepo`. The route exports only PUT (a POST is a 405) and it
  // fails closed unless `hasGitRepo === true`, so the wrong field name reports
  // "no git repository" from inside a git repository.
  //
  // `expectedMode` is the mode the PREVIEW was built against. If someone else
  // moved it in between, the swap loses and the migration is refused rather
  // than silently overwriting a decision the preview never described.
  try {
    const result = await client.put(`/api/workspaces/${workspaceId}/content-mode`, {
      mode: target,
      expectedMode: current,
      hasGitRepo,
    }) as { contentMode?: string; previousMode?: string } | null

    if (isJson) {
      console.log(formatJson({
        ...previewJson,
        contentMode: result?.contentMode ?? target,
        previousMode: result?.previousMode ?? current,
        changed: true,
      }))
    } else {
      console.log(
        `Content mode is now ${result?.contentMode ?? target} ` +
        `(was ${result?.previousMode ?? current}). ` +
        'Every branch reconciles on its next push.',
      )
    }
  } catch (err) {
    throw mapSetModeError(err, current)
  }
}

/**
 * Turn the set-mode route's refusals into something a human can act on.
 *
 * The 403 and 422 cases SURFACE THE SERVER'S OWN MESSAGE rather than replacing
 * it. The action-managed refusal names the bound repo, the workspace creator,
 * and the exact `override-on` call — the CLI does not know the binding state
 * and cannot reconstruct any of that. The override is not one-shot: it persists
 * until the next successful CI push that observed it, which is what makes the
 * recovery work, so paraphrasing it as a single-use escape hatch would be
 * actively wrong.
 */
function mapSetModeError(err: unknown, expected: ContentMode): Error {
  if (err instanceof ConflictError && err.code === 'CONTENT_MODE_CONFLICT') {
    // KTD5: a concurrent change, refused rather than overwritten. The preview
    // the user just accepted described a switch FROM `expected`; it no longer
    // describes reality, so re-previewing is the only honest next step.
    return new ValidationError(
      `${err.userMessage} The preview you accepted was built against ` +
      `${expected} mode, so it no longer describes this workspace — re-run to see the ` +
      'current cost.',
    )
  }
  if (err instanceof ForbiddenError && err.serverMessage) {
    // WORKSPACE_ACTION_MANAGED, or the creator-only gate. Both are worded by
    // the server for exactly this reader.
    return new ValidationError(err.serverMessage)
  }
  if (err instanceof ServerError && err.status === 422 && err.serverMessage) {
    // CONTENT_MODE_NOT_APPLICABLE — server-sync workspace, or committed mode
    // without a git repository.
    return new ValidationError(err.serverMessage)
  }
  return err as Error
}
