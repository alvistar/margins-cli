/**
 * `margins audit` — org-wide coverage and staleness report.
 *
 * Per repo (or across an org): is the sync workflow installed? Is the action
 * pin current against the latest released margins-sync-action? Has the bound
 * GitHub repo drifted from the workspace trust binding (rename / transfer /
 * default-branch change)? Is the repo over the server caps?
 *
 * GitHub access uses the operator's ambient `gh` auth only. Margins auth is
 * OPTIONAL: without it the binding-drift check is skipped (and noted), but
 * missing/stale-pin/over-cap still report — gh-only mode is a supported path.
 */
import type { ResolvedConfig } from '../lib/config.js'
import { createApiClient, type ApiClient } from '../lib/api-client.js'
import { formatJson, formatTable } from '../lib/output.js'
import {
  checkRepoCaps, findWorkspaceByRepoUrl, type WorkspaceListItem, type Binding,
} from '../lib/audit-checks.js'
import { resolveRepoTargets } from '../lib/repo-targets.js'
import { poolMap } from '../lib/pool.js'
import { WORKFLOW_PATH } from '../templates/margins-sync.js'
import * as gh from '../lib/gh.js'
import { GhError } from '../lib/gh.js'

/** The public action repo whose releases define "latest". */
export const ACTION_REPO = 'alvistar/margins-sync-action'

/** Repos audited concurrently per run (reads only — no write-safety concern). */
const AUDIT_CONCURRENCY = 5

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuditOpts {
  org?: string
  include?: string[]
  exclude?: string[]
  csv?: boolean
}

export type AuditStatus = 'ok' | 'missing' | 'stale-pin' | 'binding-drift' | 'over-cap' | 'error'

export interface AuditRow {
  repo: string
  status: AuditStatus
  detail: string
}

/** Margins-side drift-check context; null when running gh-only (no margins auth). */
interface DriftContext {
  client: ApiClient
  workspaces: WorkspaceListItem[]
}

interface LatestAction {
  tag: string
  /** SHA the latest tag points at; null when it couldn't be resolved. */
  sha: string | null
}

// ─── Action pin parsing + staleness ───────────────────────────────────────────

/** Extract the `uses: alvistar/margins-sync-action@<ref>` ref from a workflow. */
export function parseActionPin(workflow: string): string | null {
  const re = new RegExp(`uses:\\s*${ACTION_REPO.replace('/', '\\/')}@([^\\s'"#]+)`)
  return re.exec(workflow)?.[1] ?? null
}

const SHA_RE = /^[0-9a-f]{40}$/i
const TAG_RE = /^v\d+(\.\d+){0,2}$/

/**
 * Latest released action version: GitHub release first, tags-list fallback.
 * Any gh failure → null ("unknown latest"; pins are then reported as-is).
 */
async function resolveLatestAction(): Promise<LatestAction | null> {
  let tag: string | null = null
  try {
    tag = await gh.getLatestReleaseTag(ACTION_REPO)
    if (!tag) {
      tag = (await gh.listTags(ACTION_REPO)).find((t) => TAG_RE.test(t)) ?? null
    }
  } catch {
    return null
  }
  if (!tag) return null

  let sha: string | null = null
  try {
    sha = await gh.getTagSha(ACTION_REPO, tag)
  } catch {
    sha = null
  }
  return { tag, sha }
}

const majorOf = (tag: string): string => tag.replace(/^v/, '').split('.')[0]!

/** Evaluate a pin ref against the latest release; never throws. */
export function evaluatePin(ref: string, latest: LatestAction | null): { stale: boolean; detail: string } {
  if (SHA_RE.test(ref)) {
    const short = ref.slice(0, 12)
    if (latest?.sha && ref.toLowerCase() === latest.sha.toLowerCase()) {
      return { stale: false, detail: `pinned to latest (${latest.tag} via SHA ${short})` }
    }
    if (latest?.sha) {
      return { stale: true, detail: `stale pin: SHA ${short} (latest ${latest.tag} = ${latest.sha.slice(0, 12)})` }
    }
    return { stale: false, detail: `sha-pinned ${short} (cannot compare locally)` }
  }

  if (TAG_RE.test(ref)) {
    if (!latest) return { stale: false, detail: `pinned to ${ref} (latest unknown)` }
    if (ref === latest.tag) return { stale: false, detail: `pinned to ${ref} (latest)` }
    // Floating major tag (the recommended channel): current iff majors match.
    if (!ref.includes('.') && majorOf(ref) === majorOf(latest.tag)) {
      return { stale: false, detail: `pinned to ${ref} (floating, latest ${latest.tag})` }
    }
    return { stale: true, detail: `stale pin: ${ref} (latest ${latest.tag})` }
  }

  return { stale: false, detail: `unrecognized ref ${ref} (expected a tag or 40-hex SHA)` }
}

// ─── Binding drift ────────────────────────────────────────────────────────────

/**
 * Compare the workspace trust binding (+ default branch) against live gh
 * values. Returns drift descriptions (empty = no drift) and side notes.
 */
async function checkBindingDrift(
  { client, workspaces }: DriftContext,
  repo: gh.RepoInfo,
): Promise<{ drifts: string[]; notes: string[] }> {
  const workspace = findWorkspaceByRepoUrl(workspaces, repo.fullName)
  if (!workspace) return { drifts: [], notes: ['no margins workspace found for repo'] }

  let binding: Binding | null
  try {
    binding = (await client.get(`/api/workspaces/${workspace.id}/binding`) as { binding: Binding | null }).binding
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { drifts: [], notes: [`binding check failed: ${message}`] }
  }
  if (binding === null) return { drifts: [], notes: ['workspace has no trust binding'] }

  const drifts: string[] = []
  if (binding.boundRepoName !== repo.fullName) {
    drifts.push(`renamed: bound ${binding.boundRepoName}, now ${repo.fullName}`)
  }
  if (binding.repositoryOwnerId !== repo.ownerId) {
    drifts.push(`transferred: owner id changed (bound ${binding.repositoryOwnerId}, now ${repo.ownerId})`)
  }
  if (binding.githubRepoId !== repo.id) {
    drifts.push(`repo id changed (bound ${binding.githubRepoId}, now ${repo.id})`)
  }
  if (workspace.branch && workspace.branch !== repo.defaultBranch) {
    drifts.push(`default branch changed: ${workspace.branch} → ${repo.defaultBranch}`)
  }
  return { drifts, notes: [] }
}

// ─── Per-repo audit ───────────────────────────────────────────────────────────

async function auditRepo(
  drift: DriftContext | null,
  target: string,
  latest: LatestAction | null,
): Promise<AuditRow> {
  let repo: gh.RepoInfo
  try {
    repo = await gh.getRepo(target)
  } catch (err) {
    if (err instanceof GhError) return { repo: target, status: 'error', detail: `gh: ${err.message}` }
    throw err
  }

  // Drift and cap checks are independent — run them concurrently.
  const [driftResult, caps] = await Promise.all([
    drift ? checkBindingDrift(drift, repo) : null,
    checkRepoCaps(repo.fullName, repo.defaultBranch),
  ])

  // Workflow content is only fetched when the tree listing shows the file —
  // repos without it skip the contents call entirely.
  const workflow = caps.paths.has(WORKFLOW_PATH)
    ? await gh.getFileContent(repo.fullName, WORKFLOW_PATH, repo.defaultBranch)
    : null
  if (workflow === null) {
    return { repo: repo.fullName, status: 'missing', detail: `no ${WORKFLOW_PATH} on ${repo.defaultBranch}` }
  }

  // Findings carry a status; notes are informational and shown on "ok" rows.
  const findings: Array<{ status: AuditStatus; detail: string }> = []
  const notes: string[] = []

  // ── Action pin staleness ──
  const ref = parseActionPin(workflow)
  if (ref === null) {
    findings.push({ status: 'error', detail: `workflow present but no ${ACTION_REPO} pin found` })
  } else {
    const pin = evaluatePin(ref, latest)
    if (pin.stale) findings.push({ status: 'stale-pin', detail: pin.detail })
    else notes.push(pin.detail)
  }

  // ── Binding drift (margins auth only) ──
  if (driftResult) {
    for (const d of driftResult.drifts) findings.push({ status: 'binding-drift', detail: d })
    notes.push(...driftResult.notes)
  }

  // ── Server caps ──
  if (caps.ok) notes.push(`${caps.syncableCount} syncable files`)
  else findings.push({ status: 'over-cap', detail: caps.reason! })

  const precedence: AuditStatus[] = ['binding-drift', 'over-cap', 'stale-pin', 'error']
  const status = precedence.find((s) => findings.some((f) => f.status === s)) ?? 'ok'
  const detail = status === 'ok'
    ? notes.join('; ')
    : findings.map((f) => f.detail).join('; ')
  return { repo: repo.fullName, status, detail }
}

// ─── CSV output ───────────────────────────────────────────────────────────────

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function toCsv(rows: AuditRow[]): string {
  return [
    'repo,status,detail',
    ...rows.map((r) => [r.repo, r.status, r.detail].map(csvField).join(',')),
  ].join('\n')
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function handleAudit(
  cfg: ResolvedConfig,
  target: string | undefined,
  opts: AuditOpts,
): Promise<void> {
  // Margins auth is optional: without it, drift checks are skipped (noted).
  const hasMarginsAuth = Boolean(cfg.apiKey || (cfg.refreshToken && cfg.keycloakIssuer))
  const client = hasMarginsAuth ? createApiClient(cfg) : null

  // Workspace-list failures degrade to gh-only mode (drift skipped) rather
  // than aborting the report.
  let driftSkippedReason: string | null = hasMarginsAuth ? null : 'no margins auth'
  const fetchWorkspaces = async (): Promise<WorkspaceListItem[] | null> => {
    if (!client) return null
    try {
      return await client.get('/api/workspaces') as WorkspaceListItem[]
    } catch (err) {
      driftSkippedReason = err instanceof Error ? err.message : String(err)
      return null
    }
  }

  // The three startup lookups are independent — run them concurrently.
  const [latest, workspaces, repos] = await Promise.all([
    resolveLatestAction(),
    fetchWorkspaces(),
    resolveRepoTargets(target, opts),
  ])

  if (repos.length === 0) {
    console.log(`No repos matched in ${opts.org}.`)
    return
  }

  const drift: DriftContext | null = client && workspaces ? { client, workspaces } : null

  // Bounded concurrency (reads only) — per-repo failures become "error" rows;
  // the run continues, and rows stay in input order.
  const rows: AuditRow[] = await poolMap(repos, AUDIT_CONCURRENCY, async (repo) => {
    try {
      return await auditRepo(drift, repo, latest)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { repo, status: 'error' as const, detail: message }
    }
  })

  const driftNote = driftSkippedReason ? `binding checks skipped (${driftSkippedReason})` : null

  // ── Output: --csv → CSV; --json → JSON; otherwise human table + summary ──
  if (opts.csv) {
    console.log(toCsv(rows))
  } else if (cfg.json) {
    console.log(formatJson({
      latestAction: latest?.tag ?? null,
      ...(driftNote ? { note: driftNote } : {}),
      results: rows,
    }))
  } else {
    console.log(formatTable(
      ['Repo', 'Status', 'Detail'],
      rows.map((r) => [r.repo, r.status, r.detail]),
    ))
    const counts = new Map<AuditStatus, number>()
    for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
    const summary = (['ok', 'missing', 'stale-pin', 'binding-drift', 'over-cap', 'error'] as const)
      .filter((s) => counts.has(s))
      .map((s) => `${counts.get(s)} ${s}`)
      .join(', ')
    console.log(`\n${summary} (latest action: ${latest?.tag ?? 'unknown'})`)
    if (driftNote) console.log(driftNote)
  }

  if (rows.some((r) => r.status === 'error')) {
    process.exitCode = 1
  }
}
