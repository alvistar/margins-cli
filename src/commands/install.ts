/**
 * `margins install` — one command takes a repo from zero to synced:
 * workspace lookup-or-create, OIDC trust-binding setup, workflow PR.
 *
 * The per-repo pipeline is STEP-WISE IDEMPOTENT: each step independently
 * checks-then-acts, so a rerun resumes wherever the previous run stopped
 * (workspace exists → reuse; binding set → verify IDs match; workflow file
 * absent → open PR). A binding-enabled-but-PR-failed repo is never skipped
 * forever as "installed".
 *
 * GitHub access uses the operator's ambient `gh` auth (src/lib/gh.ts);
 * Margins auth uses the existing CLI config.
 */
import * as p from '@clack/prompts'
import type { ResolvedConfig } from '../lib/config.js'
import { createApiClient, type ApiClient } from '../lib/api-client.js'
import { ConflictError, MarginsError, ValidationError } from '../lib/errors.js'
import { formatJson, formatTable } from '../lib/output.js'
import {
  checkRepoCaps, findWorkspaceByRepoUrl, type WorkspaceListItem, type Binding,
} from '../lib/audit-checks.js'
import { resolveRepoTargets } from '../lib/repo-targets.js'
import { stampTemplate, WORKFLOW_PATH } from '../templates/margins-sync.js'
import * as gh from '../lib/gh.js'
import { GhError } from '../lib/gh.js'
import {
  acceptSwitch, fetchSyncStatus, switchConsequences, switchToPush,
} from '../lib/sync-mode-switch.js'

/** Branch the workflow PR is opened from. */
const INSTALL_BRANCH = 'margins/install-sync'

/** Max seconds we honor from a rate-limit Retry-After before capping. */
const MAX_RETRY_AFTER_S = 300

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InstallOpts {
  org?: string
  include?: string[]
  exclude?: string[]
  dryRun?: boolean
  /**
   * Accept without a prompt: the auto-detected origin repo, and the switch to
   * push of a workspace that pulls from GitHub.
   */
  yes?: boolean
  /** Injectable for tests — defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>
}

type RepoStatus = 'installed' | 'skipped' | 'failed'

/** Ctrl-C at a switch prompt: stop the whole run, not just this repo. */
class InstallCancelled extends Error {}

/** What a switched workspace looks like until something pushes. */
const FROZEN = 'the workspace was already switched to push; its content stays as it is until a push lands'

function bindingMatches(binding: Binding, repo: gh.RepoInfo): boolean {
  return binding.githubRepoId === repo.id &&
    binding.repositoryOwnerId === repo.ownerId &&
    binding.boundRepoName === repo.fullName
}

interface RepoResult {
  repo: string
  status: RepoStatus
  /** Human-readable per-step actions taken (or intended, under --dry-run). */
  actions: string[]
  reason?: string
}

// ─── PR body ──────────────────────────────────────────────────────────────────

function prBody(fullName: string, workspaceId: string, serverUrl: string, switched: boolean): string {
  const frozen = switched
    ? `
This workspace used to pull from GitHub. \`margins install\` switched it to push:
Margins no longer reads this repo, and its content stays as it was until this
workflow's first push.
`
    : ''
  return `## Margins sync — credentialless setup

This PR adds a workflow that syncs this repo's markdown (and referenced images)
to its Margins workspace on every merge to the default branch.

**No secrets are stored anywhere.** The workflow authenticates with a
short-lived GitHub OIDC token (\`permissions: id-token: write\`): GitHub signs a
~5-minute JWT proving this repo's identity, and the Margins server verifies it
against a trust binding pinned to this repo's immutable GitHub IDs. There is no
Margins API key in this repo, and Margins holds no GitHub credential.

- Workspace: \`${workspaceId}\` on ${serverUrl}
- Trust binding: ${fullName} (already enabled server-side by \`margins install\`)
- How it works: https://github.com/alvistar/margins-sync-action#readme

Merging this PR activates sync. Until the first workflow push succeeds, manual
\`margins workspace push\` still works.
${frozen}`
}

// ─── Per-repo pipeline ────────────────────────────────────────────────────────

async function processRepo(
  client: ApiClient,
  cfg: ResolvedConfig,
  /** Workspace list snapshot, fetched once per run; created workspaces are appended. */
  workspaces: WorkspaceListItem[],
  target: string,
  dryRun: boolean,
  opts: { yes?: boolean; json?: boolean },
  /**
   * Repos whose workspace this run switched to push. Owned by the caller so the
   * fact survives a throw and a rate-limit retry of this function: the switch
   * cannot be undone, so no later outcome may hide it.
   */
  switchedInRun: Set<string>,
  /** This attempt's actions, owned by the caller so a throw keeps them. */
  actions: string[],
): Promise<RepoResult> {
  const result = (status: RepoStatus, reason?: string): RepoResult => {
    // Anything short of installed after a switch leaves the workspace frozen:
    // that is a failure whatever the step said, and the reason must say why.
    if (switchedInRun.has(target) && status !== 'installed') {
      return { repo: target, status: 'failed', actions, reason: `${reason ?? 'not installed'} — ${FROZEN}` }
    }
    return { repo: target, status, actions, ...(reason ? { reason } : {}) }
  }

  // ── a. Repo facts from gh (id, owner id, canonical name, default branch) ──
  let repo: gh.RepoInfo
  try {
    repo = await gh.getRepo(target)
  } catch (err) {
    // 403 propagates to the caller's rate-limit handler (wait + retry once).
    if (err instanceof GhError && err.status !== 403) {
      return result('failed', `gh: ${err.message}`)
    }
    throw err
  }
  const fullName = repo.fullName
  const repoUrl = `https://github.com/${fullName}`

  // ── b. Cap pre-check: shared with `margins audit` (src/lib/audit-checks) ──
  const caps = await checkRepoCaps(fullName, repo.defaultBranch)
  if (!caps.ok) {
    return result('skipped', caps.reason)
  }
  actions.push(`pre-check ok (${caps.syncableCount} syncable files)`)

  // ── c. Workspace: look up by repo URL, create if absent ───────────────────
  const workspace = findWorkspaceByRepoUrl(workspaces, fullName)
  if (workspace && workspace.syncMode !== 'client' && workspace.syncMode !== 'server') {
    // Never read an unknown mode as push: binding a workspace that still pulls
    // is exactly what the switch below exists to do on purpose.
    return result('skipped',
      `workspace ${workspace.slug} reports an unknown sync mode (${JSON.stringify(workspace.syncMode)}) — not installed`)
  }

  // ── c'. A workspace that pulls from GitHub: switch it to push first ────────
  // In this order: switch, bind, PR. The switch cannot be undone, so every
  // read-only check that could still stop the install runs BEFORE it: the
  // caller's right to switch (GET /sync) and the trust binding. A failed,
  // declined or refused switch stops here, so a workspace is never bound — and
  // no workflow is opened — while it pulls.
  if (workspace?.syncMode === 'server') {
    try {
      const status = await fetchSyncStatus(client, workspace.id)
      const { binding } = await client.get(`/api/workspaces/${encodeURIComponent(workspace.id)}/binding`) as
        { binding: Binding | null }
      if (binding !== null && !bindingMatches(binding, repo)) {
        return result('failed',
          `binding mismatch: workspace is bound to ${binding.boundRepoName} (repoId ${binding.githubRepoId}) — ` +
          'reset the binding before reinstalling; not switched, nothing was changed')
      }
      if (dryRun) {
        actions.push(`would switch ${workspace.slug} to push (Margins stops pulling from GitHub)`)
      } else {
        if (!opts.json) console.error(switchConsequences(fullName, status, 'the workflow').join('\n'))
        const acceptance = await acceptSwitch(opts)
        if (acceptance === 'cancelled') throw new InstallCancelled()
        if (acceptance === 'not-interactive') {
          // `failed`, not `skipped`: nobody chose this outcome. A script that
          // forgot `--yes` must not exit 0 having installed nothing. A person who
          // answers no at the prompt DID choose, and that stays a skip.
          return result('failed',
            `workspace ${workspace.slug} pulls from GitHub; switching it to push needs confirmation: ` +
            're-run with --yes — nothing was changed')
        }
        if (acceptance === 'declined') {
          return result('skipped', `switch to push declined — ${workspace.slug} still pulls from GitHub, nothing was changed`)
        }
        const { switched } = await switchToPush(client, workspace.id)
        if (switched) switchedInRun.add(target)
        workspace.syncMode = 'client'
        actions.push(switched
          ? `switched ${workspace.slug} to push (Margins no longer pulls from GitHub)`
          : `${workspace.slug} already pushed to Margins`)
      }
    } catch (err) {
      // A refused switch is this repo's outcome, not the run's: the binding
      // and the PR below never happen, and an `--org` run moves on.
      if (err instanceof MarginsError) return result('failed', dryRun ? `would fail: ${err.userMessage}` : err.userMessage)
      throw err
    }
  } else if (workspace && switchedInRun.has(target)) {
    // A rate-limit retry of this repo: the switch happened on the first attempt.
    actions.push(`switched ${workspace.slug} to push earlier in this run`)
  }

  let workspaceId: string
  if (workspace) {
    workspaceId = workspace.id
    actions.push(`workspace exists (${workspace.slug})`)
  } else if (dryRun) {
    actions.push(`would create workspace (source: github, syncMode: client, repoUrl: ${repoUrl})`)
    workspaceId = '<new-workspace-id>'
  } else {
    const name = fullName.split('/')[1]!
    let created: { workspace: { id: string; slug: string } } | { id: string; slug: string }
    try {
      created = await client.post('/api/workspaces', {
        name,
        source: 'github',
        repoUrl,
        branch: repo.defaultBranch,
        syncMode: 'client',
      }) as { workspace: { id: string; slug: string } } | { id: string; slug: string }
    } catch (err) {
      // A workspace exists for this repo and this caller is not a member of it
      // (Margins 0.60.0 removed auto-join). That is a per-repo outcome with an
      // action attached — ask an editor for an invite — not a broken install.
      //
      // It matters which of the two this becomes. `failed` conflates "you need
      // an invite" with "the install broke", and without `--org` an uncaught
      // error reaches `throw err` in the caller and **aborts every remaining
      // repo** over one inaccessible workspace. `skipped` is the status this
      // pipeline already uses for "correct, but not installable as-is", and it
      // is what the CI docs describe.
      //
      // Only SLUG_CONFLICT. A codeless 409 from an older server, or any other
      // conflict, keeps propagating to the outer handler untouched — including
      // the binding conflict raised further down, which has its own message.
      if (err instanceof ConflictError && err.code === 'SLUG_CONFLICT') {
        return result('skipped', err.serverMessage
          ?? 'a workspace exists for this repo and you are not a member — ask an editor for an invite link')
      }
      throw err
    }
    const ws = 'workspace' in created ? created.workspace : created
    workspaceId = ws.id
    // Keep the per-run snapshot current so a later repo (or rerun logic)
    // sees the workspace we just created.
    workspaces.push({ id: ws.id, slug: ws.slug, name, repoUrl, syncMode: 'client', defaultBranch: repo.defaultBranch })
    actions.push(`workspace created (${ws.slug})`)
  }

  // ── d. Trust binding: GET, then PUT if absent; verify if present ──────────
  const wouldEnableBinding = `would enable binding (repoId ${repo.id}, ownerId ${repo.ownerId}, ${fullName})`
  if (workspace || !dryRun) {
    const { binding } = await client.get(`/api/workspaces/${encodeURIComponent(workspaceId)}/binding`) as { binding: Binding | null }
    if (binding === null) {
      if (dryRun) {
        actions.push(wouldEnableBinding)
      } else {
        try {
          await client.put(`/api/workspaces/${encodeURIComponent(workspaceId)}/binding`, {
            githubRepoId: repo.id,
            repositoryOwnerId: repo.ownerId,
            boundRepoName: fullName,
          })
          actions.push('binding enabled')
        } catch (err) {
          if (err instanceof ConflictError) {
            return result('failed', 'binding conflict (BINDING_CONFLICT) — another repo is bound; run audit / reset the binding first')
          }
          throw err
        }
      }
    } else if (bindingMatches(binding, repo)) {
      actions.push('binding already enabled (matches)')
    } else {
      return result('failed',
        `binding mismatch: workspace is bound to ${binding.boundRepoName} (repoId ${binding.githubRepoId}) — reset the binding before reinstalling`)
    }
  } else {
    // dry-run with no existing workspace: binding GET would 404 on the
    // not-yet-created workspace — report intent only, zero reads on fakes.
    actions.push(wouldEnableBinding)
  }

  // ── e. Workflow PR: skip if the file is already on the default branch ─────
  // The cap pre-check's tree listing already tells us — no extra contents call.
  if (caps.paths.has(WORKFLOW_PATH)) {
    actions.push('workflow already present')
    return result('installed')
  }

  const stamped = stampTemplate({
    serverUrl: cfg.serverUrl,
    workspaceId,
  })

  if (dryRun) {
    actions.push(`would open PR adding ${WORKFLOW_PATH} (branch ${INSTALL_BRANCH}, base ${repo.defaultBranch})`)
    return result('installed')
  }

  try {
    let branchCreated = false
    if (!(await gh.branchExists(fullName, INSTALL_BRANCH))) {
      const baseSha = await gh.getBranchSha(fullName, repo.defaultBranch)
      await gh.createBranch(fullName, INSTALL_BRANCH, baseSha)
      actions.push(`branch ${INSTALL_BRANCH} created`)
      branchCreated = true
    }
    // Idempotent commit: only write the file if it's not already on the branch.
    // A branch created this run was cut from a default branch without the file
    // (step e), so the existence probe is skipped.
    const existingSha = branchCreated
      ? null
      : await gh.getFileSha(fullName, WORKFLOW_PATH, INSTALL_BRANCH)
    if (existingSha === null) {
      await gh.putFile(fullName, {
        path: WORKFLOW_PATH,
        branch: INSTALL_BRANCH,
        message: 'ci: add Margins credentialless sync workflow',
        contentBase64: Buffer.from(stamped, 'utf-8').toString('base64'),
      })
      actions.push('workflow file committed')
    }
    const pr = await gh.createPullRequest(fullName, {
      title: 'Add Margins credentialless sync workflow',
      head: INSTALL_BRANCH,
      base: repo.defaultBranch,
      body: prBody(fullName, workspaceId, new URL(cfg.serverUrl).origin, switchedInRun.has(target)),
    })
    actions.push(`PR opened: ${pr.url}`)
    return result('installed')
  } catch (err) {
    if (err instanceof GhError) {
      if (err.status === 422 && /already exists/i.test(err.message)) {
        actions.push('PR already open')
        return result('installed')
      }
      // Rate-limit 403 (Retry-After present): propagate to handleInstall's
      // wait-and-retry handler — this is NOT a permissions problem.
      if (err.status === 403 && err.retryAfter != null) {
        throw err
      }
      // Protected branch / insufficient permissions: not a failure — the
      // binding is in place; the PR just needs someone with access.
      if (err.status === 403 || err.status === 404) {
        return result('skipped', 'PR creation blocked, awaiting permissions')
      }
      return result('failed', `gh: ${err.message}`)
    }
    throw err
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function handleInstall(
  cfg: ResolvedConfig,
  target: string | undefined,
  opts: InstallOpts,
): Promise<void> {
  const dryRun = opts.dryRun ?? false
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const client = createApiClient(cfg)

  // Resolve the repo list: single target, org listing, or the current repo's
  // origin remote when neither was given.
  const { targets: repos, autoDetected } = await resolveRepoTargets(target, opts)
  if (repos.length === 0) {
    console.log(`No repos matched in ${opts.org}.`)
    return
  }

  // Auto-detected origin (no target given): confirm the guessed repo before
  // opening any PR. `--yes` accepts it; a non-interactive context (no TTY or
  // --json) has no way to prompt, so it must pass --yes or an explicit target.
  // Dry-run writes nothing, so it skips the gate.
  if (autoDetected && !dryRun) {
    const label = `${autoDetected.owner}/${autoDetected.repo}`
    if (opts.yes) {
      if (!cfg.json) console.error(`Using detected repo: ${label}`)
    } else if (!process.stdin.isTTY || cfg.json) {
      throw new ValidationError(
        `No repo specified and stdin isn't a TTY. ` +
          `Pass owner/repo, or --yes to use the detected origin (${label}).`,
      )
    } else {
      const ok = await p.confirm({ message: `Install Margins sync for ${label}?` })
      if (p.isCancel(ok) || !ok) {
        console.error('Cancelled — no changes made.')
        return
      }
    }
  }

  // Workspace list fetched once per run; processRepo appends what it creates.
  const workspaces = await client.get('/api/workspaces') as WorkspaceListItem[]

  // SERIALIZED processing — no concurrency, so PR creation honors rate limits
  // and per-repo failures never interleave.
  const results: RepoResult[] = []
  const switchedInRun = new Set<string>()
  // A repo whose processing threw keeps the steps it got through — after a
  // switch, those are what the user needs to recover — and never goes silent
  // about the switch itself.
  const thrown = (repo: string, actions: string[], reason: string): RepoResult => switchedInRun.has(repo)
    ? { repo, status: 'failed', actions, reason: `${reason} — ${FROZEN}` }
    : { repo, status: 'failed', actions, reason }
  repoLoop: for (const [index, repo] of repos.entries()) {
    let rateLimitRetried = false
    for (;;) {
      const actions: string[] = []
      try {
        results.push(await processRepo(
          client, cfg, workspaces, repo, dryRun, { yes: opts.yes, json: cfg.json }, switchedInRun, actions,
        ))
      } catch (err) {
        if (err instanceof InstallCancelled) {
          const notStarted = repos.length - index - 1
          console.error(`Cancelled — stopping the run${notStarted ? `; ${notStarted} repo(s) not started` : ''}.`)
          results.push({ repo, status: 'skipped', actions, reason: 'cancelled — nothing was changed for this repo' })
          for (const rest of repos.slice(index + 1)) {
            results.push({ repo: rest, status: 'skipped', actions: [], reason: 'not started (cancelled)' })
          }
          process.exitCode = 130
          break repoLoop
        }
        // 403 rate limit from gh: wait out Retry-After once, then retry the repo.
        if (err instanceof GhError && err.status === 403 && !rateLimitRetried) {
          rateLimitRetried = true
          const waitS = Math.min(err.retryAfter ?? 60, MAX_RETRY_AFTER_S)
          console.error(`Rate limited on ${repo} — waiting ${waitS}s before retrying...`)
          await sleep(waitS * 1000)
          continue
        }
        if (err instanceof GhError) {
          results.push(thrown(repo, actions, `gh: ${err.message}`))
        } else if (opts.org || switchedInRun.has(repo)) {
          // --org: continue on per-repo failures of any kind. A single repo
          // whose workspace was already switched also gets its row, so the
          // summary — not a bare error — tells the user the switch happened.
          const message = err instanceof MarginsError ? err.userMessage
            : err instanceof Error ? err.message : String(err)
          results.push(thrown(repo, actions, message))
        } else {
          throw err
        }
      }
      break
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  if (cfg.json) {
    console.log(formatJson({ dryRun, results }))
  } else {
    if (dryRun) console.log('Dry run — no changes were made.\n')
    for (const r of results) {
      for (const a of r.actions) console.log(`  ${r.repo}: ${a}`)
    }
    console.log('')
    console.log(formatTable(
      ['Repo', 'Status', 'Reason'],
      results.map((r) => [r.repo, r.status, r.reason ?? '']),
    ))
    const counts = { installed: 0, skipped: 0, failed: 0 }
    for (const r of results) counts[r.status]++
    console.log(`\n${counts.installed} installed, ${counts.skipped} skipped, ${counts.failed} failed`)
  }

  if (results.some((r) => r.status === 'failed')) {
    process.exitCode = 1
  }
}
