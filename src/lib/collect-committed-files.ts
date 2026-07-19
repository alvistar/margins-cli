/**
 * Committed-mode file source: read the markdown (and the images it references)
 * out of a git commit rather than off disk, so a sync sends content that matches
 * a real point in git history and git's ignore rules govern what leaves the
 * machine.
 *
 * NOT IMPLEMENTED YET — this module is the seam U4 dispatches to and U5 fills
 * in. It returns the same {@link CollectedSyncFiles} shape as the working-tree
 * collector on purpose: the filter, the image scan, the oversized skip, the sort
 * order and the hashing must stay a single downstream path (KTD6), so the two
 * modes differ only in where the bytes came from.
 *
 * Until U5 lands, a workspace the server reports as `committed` refuses rather
 * than silently falling back to the working tree — falling back is precisely the
 * unenforced push this feature exists to prevent.
 */
import { ValidationError } from './errors.js'
import type { CollectedSyncFiles } from './collect-sync-files.js'

export interface CollectCommittedOptions {
  /** The revision to collect. Defaults to `HEAD`; hooks pass an exact object id. */
  rev?: string
  /** Overridable for tests; defaults to the server blob cap. */
  maxBlobSize?: number
}

export function collectCommittedFiles(
  _dir: string,
  _opts: CollectCommittedOptions = {},
): CollectedSyncFiles {
  throw new ValidationError(
    'This workspace is in committed content mode, which this version of the Margins CLI ' +
    'cannot collect yet — nothing was sent. Upgrade the CLI (`npm i -g margins-cli`), or ' +
    'switch the workspace back to working-tree mode.',
  )
}
