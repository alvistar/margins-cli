import { readFileSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'
import * as p from '@clack/prompts'
import {
  buildStashReviewUrl,
  isAccepted,
  lookupBinding,
  recordAcceptance,
  recordBinding,
  upsertStash,
  MAX_STASH_CONTENT,
  type StashFormat,
  type ResolvedBindingStore,
  type StashBinding,
  type StashHttp,
  type StashResponse,
  type StashUpsertResult,
} from 'margins-stash-core'
import type { ResolvedConfig } from '../lib/config.js'
import { createApiClient, type ApiClient } from '../lib/api-client.js'
import { formatJson } from '../lib/output.js'
import { inlineLocalAssets, formatBytes } from '../lib/html-inline.js'
import {
  ValidationError,
  ConflictError,
  ServerError,
  NotFoundError,
  ForbiddenError,
  AuthExpired,
  NetworkError,
} from '../lib/errors.js'

export interface StashOptions {
  title?: string
  /** Also mint a shareable /s/<slug> link for the stash and print it. */
  share?: boolean
  /** Force a fresh stash even when a binding exists (deliberate fork). */
  new?: boolean
  /** Skip the first-use trust confirmation on a binding this CLI didn't write. */
  yes?: boolean
  /** Override the format inferred from the file extension. */
  format?: string
  /** Update without an optimistic lock — overwrite whatever the stash holds. */
  force?: boolean
}

const HTML_EXTENSIONS = new Set(['.html', '.htm'])

/**
 * What kind of document this is.
 *
 * From the EXTENSION, because it is the only signal that is actually about the
 * author's intent. Sniffing the content would guess — a markdown document may
 * legitimately open with a div, and an HTML fragment may not — and guessing
 * wrong in either direction is destructive: markdown sanitized as HTML loses
 * its source, HTML stored as markdown loses its rendering. `--format` is the
 * override for the cases with no extension to read (stdin) or a misleading one.
 */
function resolveFormat(opts: StashOptions, fileName: string | undefined): StashFormat {
  if (opts.format) {
    if (opts.format !== 'markdown' && opts.format !== 'html') {
      throw new ValidationError(`--format must be "markdown" or "html" (got "${opts.format}").`)
    }
    return opts.format
  }
  // stdin has no extension, so it is markdown unless --format says otherwise.
  if (!fileName) return 'markdown'
  return HTML_EXTENSIONS.has(extname(fileName).toLowerCase()) ? 'html' : 'markdown'
}

/**
 * A design's title: the `title` element, else the first `h1`, tags stripped.
 *
 * NOT the markdown heading regex. Run over HTML that matches whatever `#`
 * happened to start a line in the CSS, so a design would be titled `sidebar {`.
 * The server's sanitizer derives the same two in the same order; this exists so
 * the title is already right in the printed output and in `--json`.
 */
function deriveHtmlTitle(content: string): string | undefined {
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title\s*>/i, /<h1[^>]*>([\s\S]*?)<\/h1\s*>/i]) {
    const m = re.exec(content)
    const text = m?.[1]?.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
    if (text) return text
  }
  return undefined
}

/**
 * Fold local CSS and images into the document, or refuse if the result is too
 * big to upload.
 *
 * The refusal happens HERE, not at the server, because only here is the
 * information that makes it actionable: the server can say the document is over
 * a megabyte, but it cannot say that 900 KB of it is one photograph.
 */
function prepareHtml(content: string, fileName: string | undefined): string {
  const baseDir = fileName ? dirname(resolve(fileName)) : process.cwd()
  const { html, inlined, warnings } = inlineLocalAssets(content, baseDir)

  for (const warning of warnings) console.error(`Not inlined: ${warning}`)
  // Always printed, even on success. These files LEAVE THE MACHINE, and the
  // author is entitled to see which ones before they send anyone the link.
  for (const asset of inlined) {
    console.error(`Inlined ${asset.path} (${formatBytes(asset.bytes)})`)
  }

  if (html.length > MAX_STASH_CONTENT) {
    const biggest = [...inlined]
      .sort((a, b) => b.bytes - a.bytes)
      .map((a) => `  ${a.path} — ${formatBytes(a.bytes)}`)
      .join('\n')
    throw new ValidationError(
      `This design is ${formatBytes(html.length)} once its assets are inlined; the limit is ` +
        `${formatBytes(MAX_STASH_CONTENT)}. Nothing was uploaded.` +
        (biggest ? `\n\nInlined, largest first:\n${biggest}` : ''),
    )
  }
  return html
}

/**
 * Publish a single markdown document to a Margins stash (a one-off, single-doc
 * workspace) and print its review URL. Content comes from a file argument, an
 * explicit `-`, or piped stdin.
 *
 * The stash update path — the binding store, the R13 trust rule, and the R11
 * recovery matrix — lives in `margins-stash-core`, shared with the
 * Margins Light daemon so both reach the same stash from the same file. What
 * stays here is everything that talks to a person: the trust prompt, the printed
 * lines, and the mapping from the package's outcome codes to this CLI's error
 * classes and exit codes.
 */
export async function handleStash(
  cfg: ResolvedConfig,
  file: string | undefined,
  opts: StashOptions = {},
): Promise<void> {
  const { content: raw, fileName } = readDocument(file)
  if (!raw.trim()) {
    throw new ValidationError('A stash document needs content.')
  }

  const format = resolveFormat(opts, fileName)
  // A design has to arrive as ONE self-contained file — the server drops every
  // external reference — so its local CSS and images are folded in first.
  const content = format === 'html' ? prepareHtml(raw, fileName) : raw

  const client = createApiClient(cfg)

  // Updates send a title only from --title or the H1 (deliberate rename
  // signals). The filename-stem fallback stays create-only — on update it would
  // clobber a custom title the owner set (e.g. via --title or the web UI) every
  // time a heading-less doc is re-stashed. The package applies whichever title it
  // is given to whichever path it takes, so the choice is made here, where the
  // binding is known.
  const headingTitle =
    opts.title?.trim() ||
    (format === 'html' ? deriveHtmlTitle(content) : deriveHeadingTitle(content))
  const stemTitle = fileName ? basename(fileName, extname(fileName)) : undefined

  const result = await upsertStash({
    http: adaptApiClient(client),
    content,
    ...(fileName ? { filePath: fileName } : {}),
    ...(headingTitle ?? stemTitle ? { title: (headingTitle ?? stemTitle)! } : {}),
    ...(headingTitle ? { updateTitle: headingTitle } : {}),
    ...(opts.new ? { forceNew: true } : {}),
    // Sent on BOTH paths. On create it reaches the server only when html; on
    // update the package sends it either way, so a .md file bound to a design
    // (or the reverse) is refused rather than written.
    format,
    ...(opts.force ? { force: true } : {}),
    confirmTrust: (binding, store) => confirmTrust(cfg, binding, store, opts),
    // Passed explicitly rather than left to the package's default. The store is
    // process-global state, and naming it here is what lets this command's tests
    // substitute one — a package that reached for the real store internally would
    // make every CLI test touch the developer's own ~/.config.
    bindings: { lookupBinding, recordBinding, isAccepted, recordAcceptance },
  })

  if (!result.ok) throw toCliError(result.failure, cfg.serverUrl)

  // The bound stash was gone or foreign, so the link the user shared last time is
  // dead and this is a different document. Said on stderr, before the new URL, in
  // the CLI's own words — the package reports which recovery happened and leaves
  // the telling to whoever has a user.
  if (result.reboundReason === 'missing') {
    console.error('The stash this file was bound to no longer exists — creating a fresh one.')
  } else if (result.reboundReason === 'foreign') {
    console.error('The bound stash belongs to a different account — creating a fresh one.')
  }

  // D9: this file's binding predates head tracking, so there was no version to
  // check against and the update overwrote whatever was there. Said out loud,
  // once — the next update has a head and is protected.
  if (result.unprotectedUpdate) {
    console.error(
      'This stash was published before Margins tracked versions, so this update overwrote it without checking. Future updates are protected.',
    )
  }

  // The stash's REAL path, from the response. The default is document.md, which
  // does not exist in a design's workspace — the link would 404 on arrival.
  const url = buildStashReviewUrl(cfg.serverUrl, result.slug, result.path)
  const outcome = result.action === 'created' ? 'Stashed for review' : 'Updated stash'
  const shareUrl = opts.share ? await mintShareLink(client, result.slug, url, outcome) : undefined

  if (cfg.json) {
    console.log(
      formatJson({
        id: result.workspaceId,
        slug: result.slug,
        url,
        action: result.action,
        format: result.format,
        path: result.path,
        ...(result.action === 'created'
          ? {}
          : { changed: result.changed, head: result.head }),
        ...(shareUrl ? { shareUrl } : {}),
      }),
    )
    return
  }

  if (result.action === 'created') console.log(`Stashed for review: ${url}`)
  else if (result.action === 'updated') console.log(`Updated stash: ${url}`)
  else console.log(`Already up to date — no new version: ${url}`)
  if (shareUrl) console.log(`Share link: ${shareUrl}`)
}

/**
 * Present the CLI's HTTP client to the package as a transport that RETURNS a
 * status instead of throwing one.
 *
 * The inversion is the price of keeping `createApiClient` on this path: it owns
 * the Keycloak refresh, so a `margins stash` from a `margins auth login` session
 * still works, and dropping it to use the package's own plain-fetch transport
 * would have quietly removed that.
 */
function adaptApiClient(client: ApiClient): StashHttp {
  async function run(call: () => Promise<unknown>): Promise<StashResponse> {
    try {
      return { status: 200, body: await call() }
    } catch (err) {
      // Auth and transport failures have no status the matrix should classify:
      // a revoked key is 401 by definition, and a connection that never opened
      // has no response at all — rethrowing lets `upsertStash` report NETWORK.
      if (err instanceof AuthExpired) return { status: 401 }
      if (err instanceof ServerError) {
        return { status: err.status, ...(err.code ? { code: err.code } : {}), ...(err.serverMessage ? { message: err.serverMessage } : {}) }
      }
      if (err instanceof ForbiddenError) {
        return { status: 403, ...(err.code ? { code: err.code } : {}), ...(err.serverMessage ? { message: err.serverMessage } : {}) }
      }
      if (err instanceof NotFoundError) {
        // A 404 with NO code is how an old server's missing PUT reaches us
        // through a status-rewriting proxy. Inventing one here would make the
        // matrix fork a second stash instead of refusing — see its ordering note.
        return { status: 404, ...(err.code ? { code: err.code } : {}) }
      }
      if (err instanceof ConflictError) {
        // `userMessage` rather than `serverMessage`: on the UPDATE path the CLI
        // has always surfaced whatever the client put there, placeholder
        // included, because a 409 on a stash the user is looking at is more
        // useful half-worded than replaced by a generic sentence.
        return { status: 409, ...(err.code ? { code: err.code } : {}), message: err.serverMessage ?? err.userMessage }
      }
      throw err
    }
  }
  return {
    get: (path) => run(() => client.get(path)),
    post: (path, body) => run(() => client.post(path, body)),
    put: (path, body) => run(() => client.put(path, body)),
  }
}

/**
 * R13: confirm a binding this machine did not record before overwriting it.
 *
 * `--yes` accepts; a non-TTY refuses with instructions rather than guessing;
 * declining falls through to a fresh stash, which is what returning false means
 * to the package.
 */
async function confirmTrust(
  cfg: ResolvedConfig,
  binding: StashBinding,
  _store: ResolvedBindingStore,
  opts: StashOptions,
): Promise<boolean> {
  if (opts.yes) return true

  const url = buildStashReviewUrl(cfg.serverUrl, binding.slug)
  if (!process.stdin.isTTY) {
    throw new ValidationError(
      `This file is bound to an existing stash (${binding.slug}) but the binding was not created on this machine.\n` +
        `Re-run with --yes to update ${url}, or --new to create a fresh stash.`,
    )
  }

  const ok = await p.confirm({
    message: `This file is bound to an existing stash not created on this machine.\nUpdate ${binding.slug} (${url})?`,
  })
  if (p.isCancel(ok) || !ok) {
    console.error('Not updating that stash — creating a fresh one instead.')
    return false
  }
  return true
}

/** The package's outcome codes, in this CLI's words. */
function toCliError(
  failure: Extract<StashUpsertResult, { ok: false }>['failure'],
  serverUrl: string,
): Error {
  switch (failure.code) {
    case 'OLD_SERVER':
      return new ValidationError(
        'This Margins server does not support stash updates yet — upgrade the server, or use --new to create a fresh stash.',
      )
    case 'KEY_ROLE':
      return new ValidationError(
        "You have comment-only access to this stash — you can't update it.\nUse --new to deliberately create your own fork.",
      )
    case 'UNAUTHORIZED':
      return new AuthExpired()
    case 'VALIDATION':
      // The server's own words when it sent any. Its HTML refusals name the
      // measurement, the limit and the fix — which is the only thing the author
      // can act on, and the generic sentence below threw all of it away.
      return new ValidationError(
        failure.serverMessage ??
          'The stash was rejected (content empty/too large, title too long, or the bound slug is not a stash). Use --verbose for the server response.',
      )
    case 'FORMAT_MISMATCH':
      // Deliberately NOT offered --force: a stash's format is fixed at creation,
      // so there is nothing forcing would resolve.
      return new ValidationError(
        `${failure.serverMessage ?? 'This stash holds a different kind of document.'}\n` +
          'Use --new to publish this file as a separate stash.',
      )
    case 'HTML_UNSUPPORTED':
      return new ValidationError(
        failure.strandedSlug
          ? `This Margins server does not support HTML stashes, and it has already created a MARKDOWN one from this file: ${failure.strandedSlug}\n` +
            'Delete it from the web UI (the CLI cannot), then update the server.'
          : `This Margins server${failure.serverVersion ? ` (${failure.serverVersion})` : ''} does not support HTML stashes. ` +
            'Update the server, or pass --format markdown to publish the source as text. Nothing was uploaded.',
      )
    case 'SLUG_CONFLICT':
      return new ConflictError('Could not allocate a stash slug — please retry.')
    case 'CONFLICT':
      // Surfaced, never retried: the content was built on a version the stash has
      // moved past, and a retry against the new head would overwrite whatever
      // moved it.
      return new ValidationError(
        `${failure.serverMessage ?? 'The stash changed since this content was written; nothing was published.'}\n` +
          'Re-run with --force to overwrite it anyway, or --new to publish this as a separate stash.',
      )
    case 'NETWORK':
      return new NetworkError(serverUrl)
    case 'SERVER':
      return new ServerError(failure.status ?? 500, undefined, failure.serverMessage)
  }
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
