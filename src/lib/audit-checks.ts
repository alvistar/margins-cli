/**
 * Server-cap pre-checks shared by `margins install` and `margins audit`.
 *
 * Both commands run the same shallow-tree detection (file count + blob size
 * against the server caps) so a repo flagged "over-cap" by audit is exactly
 * a repo install would skip — one implementation, one verdict.
 */
import { MAX_BLOB_SIZE } from './collect-sync-files.js'
import * as gh from './gh.js'

/** Server MAX_MANIFEST_FILES default — repos over this are skipped/flagged. */
export const MAX_MANIFEST_FILES = 1000

/** Extensions the sync workflow pushes (md + referenced-image types). */
export const SYNC_EXTENSIONS = /\.(md|png|jpg|jpeg|svg|gif|webp)$/i

export interface CapCheckResult {
  ok: boolean
  /** Number of syncable files found on the branch. */
  syncableCount: number
  /** Human-readable over-cap reason; set only when `ok` is false. */
  reason?: string
}

/**
 * Shallow tree listing of `branch`, counting syncable files and oversized
 * blobs against the server caps. gh errors propagate to the caller.
 */
export async function checkRepoCaps(fullName: string, branch: string): Promise<CapCheckResult> {
  const tree = await gh.listTree(fullName, branch)
  const syncable = tree.entries.filter((e) => SYNC_EXTENSIONS.test(e.path))
  if (syncable.length > MAX_MANIFEST_FILES || tree.truncated) {
    return {
      ok: false,
      syncableCount: syncable.length,
      reason: `over server cap: ${tree.truncated ? 'tree listing truncated' : `${syncable.length} syncable files`} (max ${MAX_MANIFEST_FILES})`,
    }
  }
  const oversized = syncable.filter((e) => (e.size ?? 0) > MAX_BLOB_SIZE)
  if (oversized.length > 0) {
    return {
      ok: false,
      syncableCount: syncable.length,
      reason: `over server cap: ${oversized.length} blob(s) over ${MAX_BLOB_SIZE} bytes (e.g. ${oversized[0]!.path})`,
    }
  }
  return { ok: true, syncableCount: syncable.length }
}
