/**
 * Server-cap pre-checks and workspace-lookup helpers shared by
 * `margins install` and `margins audit`.
 *
 * Both commands run the same shallow-tree detection (file count + blob size
 * against the server caps) so a repo flagged "over-cap" by audit is exactly
 * a repo install would skip — one implementation, one verdict.
 */
import { MAX_BLOB_SIZE } from './collect-sync-files.js'
import { SYNCABLE_IMAGE_EXTENSIONS } from './image-scanner.js'
import { parseGithubUrl } from './detect-git-remote.js'
import * as gh from './gh.js'

/** Server MAX_MANIFEST_FILES default — repos over this are skipped/flagged. */
export const MAX_MANIFEST_FILES = 1000

/**
 * Extensions the sync workflow pushes: markdown plus every image type the
 * collector uploads (derived from image-scanner's MIME table, the single
 * source of truth — keeps this cap pre-check aligned with what push sends).
 */
export const SYNC_EXTENSIONS = new RegExp(`\\.(md|${SYNCABLE_IMAGE_EXTENSIONS.join('|')})$`, 'i')

// ─── Shared workspace types + repo-URL lookup ─────────────────────────────────

export interface WorkspaceListItem {
  id: string
  slug: string
  name: string
  repoUrl: string | null
  syncMode: 'server' | 'client'
  /**
   * Default branch the workspace syncs from (when the server reports it).
   * Field name matches the server's list serialization (`defaultBranch`).
   */
  defaultBranch?: string | null
}

export interface Binding {
  githubRepoId: number
  repositoryOwnerId: number
  boundRepoName: string
  enforcedAt: string | null
  override: boolean
}

/**
 * Find the workspace bound to a GitHub repo by its "owner/repo" full name.
 * URL normalization rule (one place only): parse the stored repoUrl with
 * parseGithubUrl (handles https, .git suffix, trailing slash, and ssh forms)
 * and compare owner/repo pairs case-insensitively.
 */
export function findWorkspaceByRepoUrl(
  workspaces: WorkspaceListItem[],
  fullName: string,
): WorkspaceListItem | undefined {
  const want = fullName.toLowerCase()
  return workspaces.find((w) => {
    if (!w.repoUrl) return false
    const parsed = parseGithubUrl(w.repoUrl.trim().replace(/\/+$/, ''))
    return parsed.type === 'github' &&
      `${parsed.owner}/${parsed.repo}`.toLowerCase() === want
  })
}

// ─── Server-cap pre-check ─────────────────────────────────────────────────────

export interface CapCheckResult {
  ok: boolean
  /** Number of syncable files found on the branch. */
  syncableCount: number
  /** Every blob path on the branch — lets callers probe file existence without extra API calls. */
  paths: Set<string>
  /** Human-readable over-cap reason; set only when `ok` is false. */
  reason?: string
}

/**
 * Shallow tree listing of `branch`, counting syncable files and oversized
 * blobs against the server caps. gh errors propagate to the caller.
 */
export async function checkRepoCaps(fullName: string, branch: string): Promise<CapCheckResult> {
  const tree = await gh.listTree(fullName, branch)
  const paths = new Set(tree.entries.map((e) => e.path))
  const syncable = tree.entries.filter((e) => SYNC_EXTENSIONS.test(e.path))
  if (syncable.length > MAX_MANIFEST_FILES || tree.truncated) {
    return {
      ok: false,
      syncableCount: syncable.length,
      paths,
      reason: `over server cap: ${tree.truncated ? 'tree listing truncated' : `${syncable.length} syncable files`} (max ${MAX_MANIFEST_FILES})`,
    }
  }
  const oversized = syncable.filter((e) => (e.size ?? 0) > MAX_BLOB_SIZE)
  if (oversized.length > 0) {
    return {
      ok: false,
      syncableCount: syncable.length,
      paths,
      reason: `over server cap: ${oversized.length} blob(s) over ${MAX_BLOB_SIZE} bytes (e.g. ${oversized[0]!.path})`,
    }
  }
  return { ok: true, syncableCount: syncable.length, paths }
}
