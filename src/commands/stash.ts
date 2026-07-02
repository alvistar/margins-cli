import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import * as p from '@clack/prompts'
import type { ResolvedConfig } from '../lib/config.js'
import { createApiClient, type ApiClient } from '../lib/api-client.js'
import { formatJson } from '../lib/output.js'
import {
  ValidationError,
  ConflictError,
  ServerError,
  NotFoundError,
  ForbiddenError,
} from '../lib/errors.js'
import {
  lookupBinding,
  recordBinding,
  isAccepted,
  recordAcceptance,
  type StashBinding,
  type ResolvedBindingStore,
} from '../lib/stash-bindings.js'

// The stash's single document lives at this fixed path on the local "main"
// branch (mirrors the web app's stash-constants). The reader deep-link is
// /w/<slug>/-/<branch>/<path> — kept here as the one place that shape lives.
const STASH_DOC_BRANCH = 'main'
const STASH_DOC_PATH = 'document.md'

interface StashResponse {
  workspace: { id: string; slug: string; name: string }
}

interface StashUpdateResponse {
  workspace: { id: string; slug: string; name: string }
  changed: boolean
  url: string
  head: string | null
}

export interface StashOptions {
  title?: string
  /** Also mint a shareable /s/<slug> link for the stash and print it. */
  share?: boolean
  /** Force a fresh stash even when a binding exists (deliberate fork). */
  new?: boolean
  /** Skip the first-use trust confirmation on a binding this CLI didn't write. */
  yes?: boolean
}

/**
 * Publish a single markdown document to a Margins stash (a one-off, single-doc
 * workspace) and print its review URL. Content comes from a file argument, an
 * explicit `-`, or piped stdin.
 *
 * Stash update path: a FILE that was stashed before (a recorded binding) is
 * UPDATED in place — same slug, same share link, reviewers' comments intact —
 * instead of forking a duplicate. Recovery matrix (R11):
 *
 *   PUT /api/stash ──▶ 2xx changed        → "Updated stash: <url>"
 *                  ──▶ 2xx unchanged      → "Already up to date — no new version."
 *                  ──▶ 404 (enveloped)    → stash gone → create fresh + rebind
 *                  ──▶ 403 NOT_A_MEMBER   → foreign binding → create fresh + rebind
 *                  ──▶ 403 INSUFFICIENT_ROLE → comment-only access → error (--new to fork)
 *                  ──▶ 405 / bare 404     → old server → error (upgrade or --new)
 *                  ──▶ 409                → conflict (e.g. REVERT_UNSUPPORTED) → error
 *
 * Trust (R13): a binding this machine didn't record (e.g. committed into a
 * cloned repo) is confirmed once — showing the target stash — before the CLI
 * will overwrite it. `--yes` skips the prompt; declining creates a fresh stash.
 * Stdin input has no file identity, so it always creates.
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

  // ── Update path: only a real file can be bound (stdin has no identity) ──
  if (fileName && !opts.new) {
    const hit = lookupBinding(fileName)
    if (hit) {
      // Updates send a title only from --title or the H1 (deliberate rename
      // signals). The filename-stem fallback stays create-only — on update it
      // would clobber a custom title the owner set (e.g. via --title or the
      // web UI) every time a heading-less doc is re-stashed.
      const updateTitle = opts.title?.trim() || deriveHeadingTitle(content)
      const done = await tryUpdate(cfg, client, hit.store, hit.binding, content, updateTitle, opts)
      if (done) return
      // Recoverable failure or declined trust → fall through to a fresh create
      // (which re-binds the file to the new stash).
    }
  }

  // ── Create path ──
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

  // Remember the identity so the next run updates instead of forking (R10).
  if (fileName) {
    recordBinding(fileName, { slug: workspace.slug, workspaceId: workspace.id })
  }

  const url = buildReviewUrl(cfg.serverUrl, workspace.slug)
  const shareUrl = opts.share ? await mintShareLink(client, workspace.slug, url, 'Stashed for review') : undefined

  if (cfg.json) {
    console.log(
      formatJson({ id: workspace.id, slug: workspace.slug, url, action: 'created', ...(shareUrl ? { shareUrl } : {}) }),
    )
    return
  }

  console.log(`Stashed for review: ${url}`)
  if (shareUrl) console.log(`Share link: ${shareUrl}`)
}

/**
 * Attempt the in-place update for a bound file. Returns true when the command
 * is DONE (success, or a hard error was thrown); false when the caller should
 * fall through to creating a fresh stash (stale/foreign binding, declined trust).
 */
async function tryUpdate(
  cfg: ResolvedConfig,
  client: ApiClient,
  store: ResolvedBindingStore,
  binding: StashBinding,
  content: string,
  title: string | undefined,
  opts: StashOptions,
): Promise<boolean> {
  const url = buildReviewUrl(cfg.serverUrl, binding.slug)

  // ── Trust gate (R13): confirm a binding this machine didn't record ──
  if (!isAccepted(store, binding)) {
    if (opts.yes) {
      recordAcceptance(store, binding)
    } else if (!process.stdin.isTTY) {
      throw new ValidationError(
        `This file is bound to an existing stash (${binding.slug}) but the binding was not created on this machine.\n` +
          `Re-run with --yes to update ${url}, or --new to create a fresh stash.`,
      )
    } else {
      const ok = await p.confirm({
        message: `This file is bound to an existing stash not created on this machine.\nUpdate ${binding.slug} (${url})?`,
      })
      if (p.isCancel(ok) || !ok) {
        console.error('Not updating that stash — creating a fresh one instead.')
        return false // fall through to create + rebind
      }
      recordAcceptance(store, binding)
    }
  }

  // ── PUT the update ──
  let result: StashUpdateResponse
  try {
    result = (await client.put('/api/stash', {
      slug: binding.slug,
      content,
      ...(title ? { title } : {}),
    })) as StashUpdateResponse
  } catch (err) {
    // Old server: the route file exists with GET/POST, so a missing PUT export
    // returns 405 — never a bare 404. The code-less-404 branch stays only as a
    // defensive fallback for proxies that rewrite statuses. Neither may fork.
    if (
      (err instanceof ServerError && err.status === 405) ||
      (err instanceof NotFoundError && !err.code)
    ) {
      throw new ValidationError(
        `This Margins server does not support stash updates yet — upgrade the server, or use --new to create a fresh stash.`,
      )
    }
    // Stash gone (swept or deleted): the enveloped 404 carries a JSON code.
    if (err instanceof NotFoundError) {
      console.error('The stash this file was bound to no longer exists — creating a fresh one.')
      return false
    }
    if (err instanceof ForbiddenError) {
      // Comment-only membership: the caller was INVITED to this doc. Recreating
      // would silently fork it and strand the review — hard error instead.
      if (err.code === 'INSUFFICIENT_ROLE') {
        throw new ValidationError(
          `You have comment-only access to this stash (${binding.slug}) — you can't update it.\nUse --new to deliberately create your own fork.`,
        )
      }
      // Foreign binding (not a member at all): a fresh stash under the caller's
      // own account is the intended recovery.
      console.error('The bound stash belongs to a different account — creating a fresh one.')
      return false
    }
    // 400 — validation (content too large, title too long, non-stash slug).
    // Mirror the create path: the api client collapses 400s to a generic
    // ServerError whose message would misleadingly say "try again later".
    if (err instanceof ServerError && err.status === 400) {
      throw new ValidationError(
        'The stash update was rejected (content too large, title too long, or the bound slug is not a stash). Use --verbose for the server response.',
      )
    }
    // 409 — e.g. REVERT_UNSUPPORTED; the message now carries the server's text.
    if (err instanceof ConflictError) {
      throw new ValidationError(err.userMessage)
    }
    throw err
  }

  const shareUrl = opts.share ? await mintShareLink(client, binding.slug, url, 'Updated stash') : undefined

  if (cfg.json) {
    console.log(
      formatJson({
        id: result.workspace.id,
        slug: result.workspace.slug,
        url,
        action: result.changed ? 'updated' : 'unchanged',
        changed: result.changed,
        head: result.head,
        ...(shareUrl ? { shareUrl } : {}),
      }),
    )
    return true
  }

  console.log(result.changed ? `Updated stash: ${url}` : `Already up to date — no new version: ${url}`)
  if (shareUrl) console.log(`Share link: ${shareUrl}`)
  return true
}

/** Mint (or fetch) the stable share link; stable across updates by design. */
async function mintShareLink(
  client: ApiClient,
  slug: string,
  reviewUrl: string,
  outcome: string,
): Promise<string> {
  try {
    const shareRes = (await client.post('/api/stash/share', { slug })) as { shareUrl: string }
    return shareRes.shareUrl
  } catch (err) {
    if (err instanceof NotFoundError && !err.code) {
      throw new ValidationError(
        `${outcome}: ${reviewUrl}\nBut this Margins server does not support share links yet — update the server to use --share.`,
      )
    }
    throw err
  }
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
