/**
 * Repo-target resolution shared by `margins install` and `margins audit`:
 * normalize a single target (owner/repo or GitHub URL), or list an org's
 * repos and apply --include/--exclude glob filters.
 */
import { ValidationError } from './errors.js'
import { detectGitRemote, parseGithubUrl } from './detect-git-remote.js'
import * as gh from './gh.js'

// ─── Target normalization ─────────────────────────────────────────────────────

/** Normalize "owner/repo", https URL, or ssh remote to "owner/repo". */
export function normalizeTarget(target: string): string {
  const trimmed = target.trim()
  const parsed = parseGithubUrl(trimmed)
  if (parsed.type === 'github') return `${parsed.owner}/${parsed.repo}`
  // Bare owner/repo (optionally with a .git suffix) — not URL-shaped.
  const bare = trimmed.replace(/\.git$/, '')
  if (/^[^/\s]+\/[^/\s]+$/.test(bare)) return bare
  throw new ValidationError(`Invalid repository target: ${target} (expected owner/repo or a GitHub URL)`)
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

// ─── Repo-list resolution ─────────────────────────────────────────────────────

export interface RepoTargetOpts {
  org?: string
  include?: string[]
  exclude?: string[]
}

export interface ResolvedTargets {
  /** Normalized "owner/repo" targets to act on. */
  targets: string[]
  /**
   * Set only when `targets` was resolved by auto-detecting the current repo's
   * `origin` remote (no target and no `--org` given). Callers use it to confirm
   * (write commands) or announce (read commands) the guessed repo before acting.
   */
  autoDetected: { owner: string; repo: string } | null
}

/**
 * Resolve the repo list for a run: an explicit target, an org listing with
 * include/exclude filters, or — when neither is given — the current repo's
 * GitHub `origin` remote. A non-GitHub or absent origin throws with guidance
 * rather than guessing. Empty `targets` means an org filter matched nothing —
 * callers report and bail.
 */
export async function resolveRepoTargets(
  target: string | undefined,
  opts: RepoTargetOpts,
): Promise<ResolvedTargets> {
  // Ambiguous: --org would silently win and write across the whole org.
  if (target && opts.org) {
    throw new ValidationError('Specify a repo OR --org, not both')
  }
  if (opts.org) {
    return {
      targets: filterRepos(await gh.listOrgRepos(opts.org), opts.include, opts.exclude),
      autoDetected: null,
    }
  }
  if (target) {
    return { targets: [normalizeTarget(target)], autoDetected: null }
  }
  // Neither a target nor --org: fall back to the current repo's origin remote.
  const remote = detectGitRemote(process.cwd())
  if (remote.type === 'github') {
    return {
      targets: [`${remote.owner}/${remote.repo}`],
      autoDetected: { owner: remote.owner, repo: remote.repo },
    }
  }
  if (remote.type === 'other') {
    throw new ValidationError(
      `No repo specified and origin (${remote.url}) is not a GitHub repo. ` +
        'Margins sync requires GitHub — pass owner/repo or a GitHub URL, or --org <org>.',
    )
  }
  throw new ValidationError('Specify a repo (owner/repo or GitHub URL) or --org <org>')
}
