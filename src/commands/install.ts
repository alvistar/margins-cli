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
import type { ResolvedConfig } from '../lib/config.js'
import { createApiClient, type ApiClient } from '../lib/api-client.js'
import { ConflictError, ValidationError } from '../lib/errors.js'
import { formatJson, formatTable } from '../lib/output.js'
import { checkRepoCaps } from '../lib/audit-checks.js'
import { stampTemplate, WORKFLOW_PATH } from '../templates/margins-sync.js'
import * as gh from '../lib/gh.js'
import { GhError } from '../lib/gh.js'

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
  /** Injectable for tests — defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>
}

type RepoStatus = 'installed' | 'skipped' | 'failed'

interface RepoResult {
  repo: string
  status: RepoStatus
  /** Human-readable per-step actions taken (or intended, under --dry-run). */
  actions: string[]
  reason?: string
}

interface WorkspaceListItem {
  id: string
  slug: string
  name: string
  repoUrl: string | null
  syncMode: 'server' | 'client'
}

interface Binding {
  githubRepoId: number
  repositoryOwnerId: number
  boundRepoName: string
  enforcedAt: string | null
  override: boolean
}

// ─── Target normalization ─────────────────────────────────────────────────────

/** Normalize "owner/repo", https URL, or ssh remote to "owner/repo". */
export function normalizeTarget(target: string): string {
  let t = target.trim().replace(/\.git$/, '')
  const httpsMatch = /^https?:\/\/github\.com\/([^/]+\/[^/]+)/.exec(t)
  if (httpsMatch) t = httpsMatch[1]!
  const sshMatch = /^git@github\.com:([^/]+\/[^/]+)$/.exec(t)
  if (sshMatch) t = sshMatch[1]!
  if (!/^[^/\s]+\/[^/\s]+$/.test(t)) {
    throw new ValidationError(`Invalid repository target: ${target} (expected owner/repo or a GitHub URL)`)
  }
  return t
}

// ─── Glob filtering (--include / --exclude) ───────────────────────────────────

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

/** Match against both the full name ("owner/repo") and the bare repo name. */
function matchesAny(fullName: string, globs: string[]): boolean {
  const short = fullName.split('/')[1] ?? fullName
  return globs.some((g) => {
    const re = globToRegex(g)
    return re.test(fullName) || re.test(short)
  })
}

export function filterRepos(repos: string[], include?: string[], exclude?: string[]): string[] {
  let result = repos
  if (include && include.length > 0) result = result.filter((r) => matchesAny(r, include))
  if (exclude && exclude.length > 0) result = result.filter((r) => !matchesAny(r, exclude))
  return result
}

// ─── PR body ──────────────────────────────────────────────────────────────────

function prBody(fullName: string, workspaceId: string, serverUrl: string): string {
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
`
}

// ─── Per-repo pipeline ────────────────────────────────────────────────────────

async function processRepo(
  client: ApiClient,
  cfg: ResolvedConfig,
  target: string,
  dryRun: boolean,
): Promise<RepoResult> {
  const actions: string[] = []
  const result = (status: RepoStatus, reason?: string): RepoResult =>
    ({ repo: target, status, actions, ...(reason ? { reason } : {}) })

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
  const workspaces = await client.get('/api/workspaces') as WorkspaceListItem[]
  let workspace = workspaces.find(
    (w) => w.repoUrl?.replace(/\.git$/, '').toLowerCase() === repoUrl.toLowerCase(),
  )
  if (workspace && workspace.syncMode !== 'client') {
    return result('skipped',
      `workspace ${workspace.slug} uses syncMode "${workspace.syncMode}" — migrate it to client sync first (never silently bound)`)
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
    const created = await client.post('/api/workspaces', {
      name,
      source: 'github',
      repoUrl,
      branch: repo.defaultBranch,
      syncMode: 'client',
    }) as { workspace: { id: string; slug: string } } | { id: string; slug: string }
    const ws = 'workspace' in created ? created.workspace : created
    workspaceId = ws.id
    actions.push(`workspace created (${ws.slug})`)
  }

  // ── d. Trust binding: GET, then PUT if absent; verify if present ──────────
  if (workspace || !dryRun) {
    const { binding } = await client.get(`/api/workspaces/${workspaceId}/binding`) as { binding: Binding | null }
    if (binding === null) {
      if (dryRun) {
        actions.push(`would enable binding (repoId ${repo.id}, ownerId ${repo.ownerId}, ${fullName})`)
      } else {
        try {
          await client.put(`/api/workspaces/${workspaceId}/binding`, {
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
    } else if (
      binding.githubRepoId === repo.id &&
      binding.repositoryOwnerId === repo.ownerId &&
      binding.boundRepoName === fullName
    ) {
      actions.push('binding already enabled (matches)')
    } else {
      return result('failed',
        `binding mismatch: workspace is bound to ${binding.boundRepoName} (repoId ${binding.githubRepoId}) — reset the binding before reinstalling`)
    }
  } else {
    // dry-run with no existing workspace: binding GET would 404 on the
    // not-yet-created workspace — report intent only, zero reads on fakes.
    actions.push(`would enable binding (repoId ${repo.id}, ownerId ${repo.ownerId}, ${fullName})`)
  }

  // ── e. Workflow PR: skip if the file is already on the default branch ─────
  if (await gh.fileExists(fullName, WORKFLOW_PATH, repo.defaultBranch)) {
    actions.push('workflow already present')
    return result('installed')
  }

  const stamped = stampTemplate({
    defaultBranch: repo.defaultBranch,
    serverUrl: cfg.serverUrl,
    workspaceId,
  })

  if (dryRun) {
    actions.push(`would open PR adding ${WORKFLOW_PATH} (branch ${INSTALL_BRANCH}, base ${repo.defaultBranch})`)
    return result('installed')
  }

  try {
    if (!(await gh.branchExists(fullName, INSTALL_BRANCH))) {
      const baseSha = await gh.getBranchSha(fullName, repo.defaultBranch)
      await gh.createBranch(fullName, INSTALL_BRANCH, baseSha)
      actions.push(`branch ${INSTALL_BRANCH} created`)
    }
    // Idempotent commit: only write the file if it's not already on the branch.
    const existingSha = await gh.getFileSha(fullName, WORKFLOW_PATH, INSTALL_BRANCH)
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
      body: prBody(fullName, workspaceId, new URL(cfg.serverUrl).origin),
    })
    actions.push(`PR opened: ${pr.url}`)
    return result('installed')
  } catch (err) {
    if (err instanceof GhError) {
      if (err.status === 422 && /already exists/i.test(err.message)) {
        actions.push('PR already open')
        return result('installed')
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
  if (!target && !opts.org) {
    throw new ValidationError('Specify a repo (owner/repo or GitHub URL) or --org <org>')
  }

  const dryRun = opts.dryRun ?? false
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const client = createApiClient(cfg)

  // Resolve the repo list: single target, or org listing with include/exclude.
  let repos: string[]
  if (opts.org) {
    repos = filterRepos(await gh.listOrgRepos(opts.org), opts.include, opts.exclude)
    if (repos.length === 0) {
      console.log(`No repos matched in ${opts.org}.`)
      return
    }
  } else {
    repos = [normalizeTarget(target!)]
  }

  // SERIALIZED processing — no concurrency, so PR creation honors rate limits
  // and per-repo failures never interleave.
  const results: RepoResult[] = []
  for (const repo of repos) {
    let rateLimitRetried = false
    for (;;) {
      try {
        results.push(await processRepo(client, cfg, repo, dryRun))
      } catch (err) {
        // 403 rate limit from gh: wait out Retry-After once, then retry the repo.
        if (err instanceof GhError && err.status === 403 && !rateLimitRetried) {
          rateLimitRetried = true
          const waitS = Math.min(err.retryAfter ?? 60, MAX_RETRY_AFTER_S)
          console.error(`Rate limited on ${repo} — waiting ${waitS}s before retrying...`)
          await sleep(waitS * 1000)
          continue
        }
        if (err instanceof GhError) {
          results.push({ repo, status: 'failed', actions: [], reason: `gh: ${err.message}` })
        } else if (opts.org) {
          // --org: continue on per-repo failures of any kind
          const message = err instanceof Error ? err.message : String(err)
          results.push({ repo, status: 'failed', actions: [], reason: message })
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
