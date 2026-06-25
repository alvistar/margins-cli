import type { ResolvedConfig } from '../lib/config.js'
import { createApiClient } from '../lib/api-client.js'
import { formatJson } from '../lib/output.js'
import { NotFoundError, ValidationError } from '../lib/errors.js'

interface ShareResponse {
  shareUrl: string
  slug: string
  created: boolean
}

/**
 * Resolve a stash slug from either a bare slug (`stash/alice/1a2b3c4d`) or a full
 * reader URL (`https://margins.sh/w/stash/alice/1a2b3c4d/-/main/document.md`).
 * The slug is everything after `/w/` up to the `/-/<branch>` separator.
 */
export function parseStashSlug(input: string): string {
  const trimmed = input.trim()
  const wIdx = trimmed.indexOf('/w/')
  if (wIdx !== -1) {
    let rest = trimmed.slice(wIdx + 3) // after '/w/'
    const dashIdx = rest.indexOf('/-/')
    if (dashIdx !== -1) rest = rest.slice(0, dashIdx)
    rest = rest.split(/[?#]/)[0]! // strip any query/hash
    return rest.replace(/\/+$/, '')
  }
  // Not a URL — strip any query/hash and surrounding slashes.
  return trimmed.split(/[?#]/)[0]!.replace(/^\/+|\/+$/g, '')
}

/**
 * Map an api-client error to an actionable share error. A 404 with no server
 * error code means the `/api/stash/share` route doesn't exist — the Margins
 * server predates share links and needs updating (R6: never a silent failure).
 * A 404 WITH a code is the endpoint reporting the stash itself wasn't found.
 */
function shareRequestError(err: unknown, slug: string): Error {
  if (err instanceof NotFoundError) {
    if (!err.code) {
      return new ValidationError(
        'This Margins server does not support share links yet. Update the server (or your CLI), then try again.',
      )
    }
    return new ValidationError(`Stash not found: ${slug}. Check the slug or URL.`)
  }
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Mint or return the stable `/s/<slug>` share link for an existing stash and
 * print it. Get-or-create on the server: re-running prints the same URL until
 * the link is revoked.
 */
export async function handleShare(cfg: ResolvedConfig, target: string): Promise<void> {
  const slug = parseStashSlug(target)
  if (!slug) {
    throw new ValidationError('A stash slug or URL is required.')
  }

  const client = createApiClient(cfg)
  let result: ShareResponse
  try {
    result = (await client.post('/api/stash/share', { slug })) as ShareResponse
  } catch (err) {
    throw shareRequestError(err, slug)
  }

  if (cfg.json) {
    console.log(formatJson({ slug: result.slug, shareUrl: result.shareUrl, created: result.created }))
    return
  }

  console.log(`Share link: ${result.shareUrl}`)
}
