import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { ResolvedConfig } from '../lib/config.js'
import { createApiClient } from '../lib/api-client.js'
import { formatJson } from '../lib/output.js'
import { ValidationError, ConflictError, ServerError, NotFoundError } from '../lib/errors.js'

// The stash's single document lives at this fixed path on the local "main"
// branch (mirrors the web app's stash-constants). The reader deep-link is
// /w/<slug>/-/<branch>/<path> — kept here as the one place that shape lives.
const STASH_DOC_BRANCH = 'main'
const STASH_DOC_PATH = 'document.md'

interface StashResponse {
  workspace: { id: string; slug: string; name: string }
}

export interface StashOptions {
  title?: string
  /** Also mint a shareable /s/<slug> link for the new stash and print it. */
  share?: boolean
}

/**
 * Publish a single markdown document to a Margins stash (a one-off, single-doc
 * workspace) and print its review URL. Content comes from a file argument,
 * an explicit `-`, or piped stdin. POSTs to /api/stash with the CLI's bearer.
 */
export async function handleStash(
  cfg: ResolvedConfig,
  file: string | undefined,
  opts: StashOptions = {},
): Promise<void> {
  const { content, fileName } = readDocument(file)
  if (!content.trim()) {
    throw new ValidationError('A stash document needs content.')
  }

  const title =
    opts.title?.trim() ||
    deriveHeadingTitle(content) ||
    (fileName ? basename(fileName, extname(fileName)) : undefined)

  const client = createApiClient(cfg)
  let workspace: StashResponse['workspace']
  try {
    const result = (await client.post('/api/stash', {
      content,
      ...(title ? { title } : {}),
    })) as StashResponse
    workspace = result.workspace
  } catch (err) {
    if (err instanceof ConflictError) {
      throw new ConflictError('Could not allocate a stash slug — please retry.')
    }
    // The API client collapses a 400 to a generic ServerError (its human
    // message isn't preserved); give a clearer, actionable line for the
    // validation cases the stash route rejects.
    if (err instanceof ServerError && err.status === 400) {
      throw new ValidationError(
        'The stash was rejected (content empty/too large, or title too long). Use --verbose for the server response.',
      )
    }
    throw err
  }

  const url = buildReviewUrl(cfg.serverUrl, workspace.slug)

  // --share: mint the stable /s/<slug> link in the same step (opt-in). The stash
  // is already created, so a share failure reports clearly without losing it.
  let shareUrl: string | undefined
  if (opts.share) {
    try {
      const shareRes = (await client.post('/api/stash/share', { slug: workspace.slug })) as {
        shareUrl: string
      }
      shareUrl = shareRes.shareUrl
    } catch (err) {
      if (err instanceof NotFoundError && !err.code) {
        throw new ValidationError(
          `Stashed for review: ${url}\nBut this Margins server does not support share links yet — update the server to use --share.`,
        )
      }
      throw err
    }
  }

  if (cfg.json) {
    console.log(formatJson({ id: workspace.id, slug: workspace.slug, url, ...(shareUrl ? { shareUrl } : {}) }))
    return
  }

  console.log(`Stashed for review: ${url}`)
  if (shareUrl) console.log(`Share link: ${shareUrl}`)
}

/**
 * Resolve the document content. With no file argument (or an explicit `-`),
 * read piped stdin; refuse if stdin is an interactive TTY (nothing to read).
 */
function readDocument(file: string | undefined): { content: string; fileName?: string } {
  const useStdin = file === undefined || file === '-'
  if (useStdin) {
    if (process.stdin.isTTY) {
      throw new ValidationError(
        'No document given. Pass a file path, or pipe markdown via stdin.',
      )
    }
    return { content: readFileSync(0, 'utf8') } // fd 0 = stdin
  }
  try {
    return { content: readFileSync(file, 'utf8'), fileName: file }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ValidationError(`File not found: ${file}`)
    }
    throw err
  }
}

/** First level-1 (`# `) heading's text, if the document has one. */
function deriveHeadingTitle(content: string): string | undefined {
  const m = /^#[ \t]+(.+?)[ \t]*$/m.exec(content)
  return m?.[1]
}

function buildReviewUrl(serverUrl: string, slug: string): string {
  const base = serverUrl.replace(/\/$/, '')
  return `${base}/w/${slug}/-/${STASH_DOC_BRANCH}/${STASH_DOC_PATH}`
}
