import { createHash } from 'node:crypto'
import type { ApiClient } from './api-client.js'
import {
  ConflictError, MergeConflictError, ServerError, ValidationError,
  type SyncConflictEntry,
} from './errors.js'
import { poolMap } from './pool.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CasSyncResult {
  added: number
  changed: number
  deleted: number
  uploaded: number   // blobs actually transferred
  skipped: number    // blobs already on server
}

interface ManifestResponse {
  files: Record<string, string>  // path → sha256 hash
  headSha: string | null
}

interface SyncFile {
  path: string
  content: Buffer
  contentType: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Compute a deterministic synthetic commit SHA from a path→hash manifest:
 * sha256 over sorted entries of `path\thash\n` (sorted by path, plain byte
 * order). Byte-identical to the desktop implementation
 * (margins-desktop src-tauri/src/sync/cas_sync.rs `synthetic_commit_sha`) —
 * the shared test vector lives in `__tests__/fixtures/synthetic-sha-vector.json`.
 *
 * Same input manifest → same SHA, so retries produce the same value and the
 * server's headSha-match idempotency path (D-019) short-circuits cleanly.
 * Output is a 64-char lowercase hex string satisfying ManifestPushSchema's
 * `^[a-f0-9]{64}$` validation.
 */
export function syntheticCommitSha(manifest: Record<string, string>): string {
  const paths = Object.keys(manifest)
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8')))
  let buf = ''
  for (const path of paths) {
    buf += `${path}\t${manifest[path]}\n`
  }
  return sha256(Buffer.from(buf, 'utf-8'))
}

/** Count paths whose hash differs (or exists on only one side) between two manifests. */
function countManifestDiff(a: Record<string, string>, b: Record<string, string>): number {
  let diff = 0
  for (const [path, hash] of Object.entries(a)) {
    if (b[path] !== hash) diff++
  }
  for (const path of Object.keys(b)) {
    if (!(path in a)) diff++
  }
  return diff
}

/** Map a 422 PUSH_SYNC_NOT_SUPPORTED server error to an actionable message. */
function mapSyncError(err: unknown): never {
  if (err instanceof ServerError && err.code === 'PUSH_SYNC_NOT_SUPPORTED') {
    throw new ValidationError(
      "This workspace does not support client push sync (its syncMode is not 'client'). " +
      'Server-managed workspaces sync via GitHub — use `margins workspace sync` instead, ' +
      'or recreate the workspace with client sync enabled.',
    )
  }
  throw err
}

/**
 * Build the user-facing message for a server-side merge conflict: name the
 * conflicting file(s) and the reconcile next step. A whole-tree conflict
 * (path `"*"`, e.g. an unreconstructable base) gets a generic phrasing.
 */
function formatMergeConflictMessage(conflicts: SyncConflictEntry[]): string {
  const next = 'Pull the latest, reconcile, and push again.'
  const paths = conflicts.map((c) => c.path).filter((p) => p !== '*')
  if (paths.length === 0) {
    return `Your push conflicts with a newer change and was not applied. ${next}`
  }
  const verb = paths.length === 1 ? 'conflicts' : 'conflict'
  return `${paths.join(', ')} ${verb} with a newer change — your push did not land. ${next}`
}

// ─── CAS sync ────────────────────────────────────────────────────────────────

const UPLOAD_CONCURRENCY = 5

/**
 * Content-addressable sync protocol.
 *
 * 1. Fetch the server manifest for the branch
 * 2. Compute SHA-256 of each local file, diff against manifest
 * 3. Upload new/changed blobs (up to 5 concurrent)
 * 4. Commit the new manifest with a synthetic commitSha (derived from the
 *    local manifest, see {@link syntheticCommitSha}) and parentSha = the
 *    server's headSha from step 1. SHAs are computed here — callers never
 *    supply them (git SHAs are the wrong shape AND the wrong semantics).
 *
 * On a 409 (headSha moved under us): refetch the manifest once, log loudly
 * what we're replacing, and retry with the fresh headSha. A second 409 is a
 * hard error. The retry is skipped if the process received SIGINT/SIGTERM
 * (e.g. a cancelled CI run must not overwrite a newer run's tree).
 */
export async function casSync(
  client: ApiClient,
  workspaceId: string,
  branch: string,
  files: SyncFile[],
): Promise<CasSyncResult> {
  const basePath = `/api/workspaces/${workspaceId}/sync`

  // Signal handling: record the signal for the 409-retry guard, then remove
  // ourselves and RE-RAISE so Node's default disposition proceeds (a handler
  // that only sets a flag would swallow Ctrl-C for the whole push, and a
  // cancelled CI run would still POST its manifest on the non-409 path).
  // throwIfInterrupted stays as the guard for the 409-retry path, which can
  // run before the re-raised signal actually terminates the process.
  let interrupted: string | null = null
  const makeHandler = (signal: NodeJS.Signals): (() => void) => {
    const handler = (): void => {
      interrupted = signal
      process.off(signal, handler)
      process.kill(process.pid, signal)
    }
    return handler
  }
  const onSigint = makeHandler('SIGINT')
  const onSigterm = makeHandler('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  /** Abort instead of retrying once a termination signal has been received. */
  const throwIfInterrupted = (): void => {
    if (interrupted) {
      throw new ConflictError(
        `Manifest push conflicted (409) but the process received ${interrupted} — ` +
        'aborting without retrying. Re-run the push to sync.',
      )
    }
  }

  try {
    // Step 1: Fetch current server manifest
    const manifest = await client.get(
      `${basePath}/manifest`,
      { branch },
    ).catch(mapSyncError) as ManifestResponse

    const serverFiles = manifest.files ?? {}

    // Step 2: Compute local hashes and diff
    const localFiles: Record<string, string> = {}
    const localByHash = new Map<string, SyncFile>()

    for (const file of files) {
      const hash = sha256(file.content)
      localFiles[file.path] = hash
      localByHash.set(hash, file)
    }

    // Determine what changed
    let added = 0
    let changed = 0
    const deleted = Object.keys(serverFiles).filter(p => !(p in localFiles)).length

    // Collect hashes that need uploading (new or changed content)
    const hashesOnServer = new Set(Object.values(serverFiles))
    const hashesToUpload = new Set<string>()

    for (const [filePath, hash] of Object.entries(localFiles)) {
      const serverHash = serverFiles[filePath]
      if (serverHash === undefined) {
        added++
        if (!hashesOnServer.has(hash)) {
          hashesToUpload.add(hash)
        }
      } else if (serverHash !== hash) {
        changed++
        if (!hashesOnServer.has(hash)) {
          hashesToUpload.add(hash)
        }
      }
    }

    // Step 3: Upload blobs concurrently
    const toUpload = [...hashesToUpload]

    await poolMap(toUpload, UPLOAD_CONCURRENCY, async (hash) => {
      const file = localByHash.get(hash)!
      await client.putRaw(
        `${basePath}/objects/${hash}`,
        file.content,
        file.contentType,
      )
    })

    const uploaded = toUpload.length

    // Step 4: Commit the new manifest. commitSha is synthetic and derived
    // from localFiles; parentSha is the server's headSha (CAS swap contract).
    const commitSha = syntheticCommitSha(localFiles)
    const commitBody = (parentSha: string | null) => ({
      branch,
      commitSha,
      parentSha,
      files: localFiles,
    })

    try {
      await client.post(`${basePath}/manifest`, commitBody(manifest.headSha))
    } catch (err) {
      // Post-PR2 a SYNC_MERGE_CONFLICT is ALWAYS a real content conflict: the
      // server already 3-way-merges head-moves, so refetch-and-repush would
      // clobber the other writer. Surface the conflicting files + next step and
      // STOP — never re-push. The CLI writes no local files, so the user's
      // working copy is preserved for free. (R1/R2/R3, KTD2)
      if (err instanceof MergeConflictError) {
        throw new MergeConflictError(
          err.conflicts, err.head, formatMergeConflictMessage(err.conflicts),
        )
      }

      if (!(err instanceof ConflictError)) mapSyncError(err)

      // Legacy / non-merge 409 (stale headSha): the server no longer emits this
      // post-PR2, but keep the refetch-and-retry-once path defensively. Git is
      // the source of truth — refetch the headSha and retry ONCE (the local
      // manifest and commitSha are unchanged), overwriting the concurrent write.
      throwIfInterrupted()

      const fresh = await client.get(
        `${basePath}/manifest`,
        { branch },
      ).catch(mapSyncError) as ManifestResponse

      const differing = countManifestDiff(localFiles, fresh.files ?? {})
      process.stderr.write(
        `[margins] Manifest conflict (409): another writer moved headSha to ` +
        `${fresh.headSha ?? '(none)'}. Retrying once — this push will replace that ` +
        `manifest (${differing} file(s) differ vs the server manifest).\n`,
      )

      throwIfInterrupted()

      try {
        await client.post(`${basePath}/manifest`, commitBody(fresh.headSha))
      } catch (retryErr) {
        if (retryErr instanceof ConflictError) {
          throw new ConflictError(
            'Manifest push conflicted twice (server headSha keeps moving). ' +
            'Another writer is actively pushing to this workspace — wait for it ' +
            'to finish and re-run the push.',
          )
        }
        mapSyncError(retryErr)
      }
    }

    return {
      added,
      changed,
      deleted,
      uploaded,
      skipped: files.length - added - changed,
    }
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}
