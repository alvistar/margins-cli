import {
  lookupBinding,
  recordBinding,
  isAccepted,
  recordAcceptance,
  type ResolvedBindingStore,
  type StashBinding,
} from './bindings.js'
import type { StashHttp, StashResponse } from './http.js'

// ─── Stash create / update, with the R11 recovery matrix ──────────────────────
//
// Lifted out of `margins-cli`'s `stash` command so the CLI and the Margins Light
// daemon run ONE copy of these rules. What stayed behind in the CLI is
// everything that talks to a person: prompts, printing, exit codes. What moved
// here decides what happened and what it means.
//
//   PUT /api/stash ──▶ 2xx changed          → { action: 'updated' }
//                  ──▶ 2xx unchanged        → { action: 'unchanged' }
//                  ──▶ 401                  → UNAUTHORIZED (revoked/rejected key)
//                  ──▶ 404 (with a code)    → stash gone → create fresh + rebind
//                  ──▶ 403 NOT_A_MEMBER     → foreign binding → create fresh + rebind
//                  ──▶ 403 INSUFFICIENT_ROLE→ comment-only access → KEY_ROLE
//                  ──▶ 405 / bare 404       → OLD_SERVER
//                  ──▶ 400                  → VALIDATION
//                  ──▶ 409                  → CONFLICT, surfaced and NOT retried
//                  ──▶ 5xx                  → SERVER
//
// The 409 rule is the one that changed in the move. The design this came from
// said "re-read the head and retry once". It does not: the caller sent a
// `parentSha` describing the version it built its content on, and a retry against
// the new head would overwrite whatever moved the head — silently, and with the
// content of a document that was never merged with it. Surfacing the conflict
// costs a click; retrying costs somebody else's edit.

export const STASH_DOC_BRANCH = 'main'
export const STASH_DOC_PATH = 'document.md'
export const STASH_DOC_PATH_HTML = 'document.html'

export type StashFormat = 'markdown' | 'html'

/**
 * The largest document the server accepts, mirrored so a caller can refuse
 * BEFORE the upload. Server-side this is `MAX_STASH_CONTENT`.
 *
 * Mirrored rather than discovered because the refusal has to happen locally to
 * be useful: an HTML design goes over this by inlining its images, and only the
 * caller still holds the list of what it inlined and how big each one was. The
 * server can only say "too large".
 */
export const MAX_STASH_CONTENT = 1_000_000

/**
 * The first Margins version whose `POST /api/stash` understands `format`.
 *
 * An older server accepts the request, IGNORES the field, and returns a
 * perfectly successful markdown stash of the HTML source — the worst possible
 * outcome, because it looks like it worked. `/api/health` reports the version,
 * so an html create asks first.
 */
export const MIN_HTML_STASH_SERVER_VERSION = '0.69.0'

export type StashFailureCode =
  | 'UNAUTHORIZED'
  | 'KEY_ROLE'
  | 'OLD_SERVER'
  | 'CONFLICT'
  | 'SLUG_CONFLICT'
  | 'VALIDATION'
  | 'SERVER'
  | 'NETWORK'
  /** The server is too old to understand `format`, so it cannot hold a design. */
  | 'HTML_UNSUPPORTED'
  /** The caller asked to update a stash as one format and it holds the other. */
  | 'FORMAT_MISMATCH'

export interface StashFailure {
  code: StashFailureCode
  /** The server's own wording, when it sent any. Never a placeholder. */
  serverMessage?: string
  /** HTTP status, when there was a response to read one from. */
  status?: number
  /** Present on CONFLICT: the head the caller's `parentSha` disagreed with. */
  head?: string | null
  /**
   * Present on HTML_UNSUPPORTED after a create ALREADY LANDED: the markdown
   * stash the old server made from the HTML source. The CLI has no delete
   * command, so naming it is the only way the user can go and remove it.
   */
  strandedSlug?: string
  /** Present on HTML_UNSUPPORTED from the preflight: the version it read. */
  serverVersion?: string
}

export type StashAction = 'created' | 'updated' | 'unchanged'

/**
 * Why a bound file ended up on a NEW stash instead of the one it pointed at.
 *
 * The caller has to be able to say which of these happened — "the stash you
 * shared is gone" and "that stash belongs to someone else" are different pieces
 * of news, and a single "rebound" flag would flatten them into neither.
 */
export type ReboundReason = 'missing' | 'foreign' | 'trust-declined'

/**
 * The binding store, as a port.
 *
 * Injected rather than imported at the call site so a caller with a different
 * trust posture can supply its own, and so each caller's tests can substitute
 * one. The default is the real store, which is what both shipping callers use.
 */
export interface BindingsPort {
  lookupBinding: typeof lookupBinding
  recordBinding: typeof recordBinding
  isAccepted: typeof isAccepted
  recordAcceptance: typeof recordAcceptance
}

const DEFAULT_BINDINGS: BindingsPort = {
  lookupBinding,
  recordBinding,
  isAccepted,
  recordAcceptance,
}

export interface StashUpsertSuccess {
  ok: true
  action: StashAction
  slug: string
  workspaceId: string
  /** False when the content was byte-identical and no new version was cut. */
  changed: boolean
  head: string | null
  /**
   * The bound stash was gone, foreign, or its trust was declined, so a FRESH one
   * was created and the binding repointed. The link the caller showed last time
   * no longer works, and only this flag says so.
   */
  rebound: boolean
  /** Present when `rebound` — which of the three recoveries happened. */
  reboundReason?: ReboundReason
  /** What the stash holds, as the SERVER reported it. */
  format: StashFormat
  /** The stash's real document path — what the review URL must end in. */
  path: string
  /**
   * The update went out with NO `parentSha`, so it overwrote whatever the stash
   * held rather than checking first.
   *
   * Only ever true for a binding written before head tracking existed (D9).
   * Those have nothing to send, and refusing them would strand every stash
   * created by an older CLI. So it overwrites ONCE, records the head it gets
   * back, and every later update is protected — but the caller is told, because
   * "I overwrote something without checking" is not a thing to do silently.
   *
   * A flag rather than a `console.error` here: this module never prints. The
   * caller owns the wording and the stream.
   */
  unprotectedUpdate?: boolean
}

export type StashUpsertResult = StashUpsertSuccess | { ok: false; failure: StashFailure }

export interface UpsertStashOptions {
  http: StashHttp
  /** Content to publish. */
  content: string
  /**
   * Absolute or cwd-relative path of the local file. Its IDENTITY, not its
   * content — omit it (stdin, an unsaved buffer) and every call creates a fresh
   * stash, because there is nothing to bind a stash to.
   */
  filePath?: string
  /** Title for a NEWLY created stash. */
  title?: string
  /**
   * Title for an UPDATE, kept separate from `title` on purpose.
   *
   * A caller that derives a title from the filename when the document has no
   * heading must not send that on an update: it would overwrite a title the
   * owner set by hand, every time a heading-less document was re-published. Omit
   * this and the update sends no title at all, which leaves the stored one alone.
   */
  updateTitle?: string
  /** Force a fresh stash even when a binding exists (a deliberate fork). */
  forceNew?: boolean
  /**
   * The version the content was built on. Sent on the update; the server answers
   * 409 rather than overwriting a stash that moved on since.
   */
  parentSha?: string | null
  /**
   * What kind of document this is. Absent means markdown.
   *
   * On CREATE it is sent only when `html` — an absent field already means
   * markdown to the server, and every request body this CLI has ever sent for a
   * markdown stash stays byte-identical. On UPDATE it is sent whenever known, so
   * the server can refuse a stash that holds the other format before it writes.
   */
  format?: StashFormat
  /**
   * Update without an optimistic lock: overwrite whatever the stash holds now.
   *
   * The deliberate escape hatch from a conflict. `--new` forks instead; this one
   * is for "yes, I know it moved, mine is the version that should win".
   */
  force?: boolean
  /**
   * Confirm a binding THIS machine did not record (R13). Honouring a binding is
   * an overwrite capability, so a binding that arrived with a clone is untrusted
   * until something says otherwise.
   *
   * A callback, not a prompt, because the two callers answer it differently: the
   * CLI asks the user, and the daemon — which has no one to ask — refuses. Absent
   * means refuse, which is the fail-closed direction: a fresh stash under the
   * caller's own name, never an overwrite of a stranger's.
   */
  confirmTrust?: (binding: StashBinding, store: ResolvedBindingStore) => Promise<boolean>
  /** Override the binding store. Defaults to the real one. */
  bindings?: BindingsPort
}

interface CreateResponseShape {
  workspace: { id: string; slug: string; name: string }
  /** Both ADDITIVE, and both absent from a server older than `format`. */
  format?: StashFormat
  path?: string
  head?: string | null
}

interface UpdateResponseShape {
  workspace: { id: string; slug: string; name: string }
  changed: boolean
  url: string
  head: string | null
  format?: StashFormat
  path?: string
}

/** Compare two 3-segment semver strings. Returns <0, 0, or >0. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10))
  const pb = b.split('.').map((n) => Number.parseInt(n, 10))
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Refuse an html create against a server too old to understand `format`.
 *
 * Such a server does not error — it ignores the field and happily stores the
 * HTML source as markdown, so the user gets a success message and a link to a
 * page of escaped tags. Asking first is the only way to fail honestly.
 *
 * Everything uncertain FALLS THROUGH: a health endpoint that is missing, a
 * version that will not parse, and the literal `unknown` a dev server reports
 * all continue to the create, where the response-echo check is the backstop. A
 * preflight that refused on uncertainty would block development servers.
 */
async function checkHtmlSupport(http: StashHttp): Promise<StashFailure | null> {
  let res: StashResponse
  try {
    res = await http.get('/api/health')
  } catch {
    return null
  }
  if (res.status < 200 || res.status >= 300) return null

  const body = payload<{ version?: unknown }>(res.body)
  const version = typeof body?.version === 'string' ? body.version : null
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return null

  if (compareVersions(version, MIN_HTML_STASH_SERVER_VERSION) >= 0) return null
  return { code: 'HTML_UNSUPPORTED', serverVersion: version }
}

/** A transport-level throw — no response, so nothing to classify. */
function networkFailure(): StashUpsertResult {
  return { ok: false, failure: { code: 'NETWORK' } }
}

function fail(code: StashFailureCode, res: StashResponse): StashUpsertResult {
  return {
    ok: false,
    failure: {
      code,
      status: res.status,
      ...(res.message ? { serverMessage: res.message } : {}),
    },
  }
}

/**
 * The success payload, whichever transport delivered it.
 *
 * The stash routes answer with the API's `apiOk` envelope — `{ data: … }` — but
 * the two transports do not agree on who removes it. The CLI's own client
 * unwraps every response before its adapter hands one over
 * (`api-client.ts`, `readJson`), while the daemon's plain `fetch` transport
 * hands the body through untouched, because the recovery matrix also has to read
 * un-enveloped bodies (a `PUT` conflict, an old server's bare 404).
 *
 * So the matrix accepts both and unwraps here. This is the only place that rule
 * lives. Without it the daemon read `body.workspace` off the envelope, got
 * `undefined`, and threw AFTER the stash had already been created on the server.
 */
function payload<T>(body: unknown): T {
  if (typeof body === 'object' && body !== null && 'data' in body) {
    return (body as { data: T }).data
  }
  return body as T
}

/**
 * Create the stash, or update the one this file is already bound to.
 *
 * Never prompts, never prints, never exits. Every outcome is in the return
 * value, including the ones a person has to be told about.
 */
export async function upsertStash(opts: UpsertStashOptions): Promise<StashUpsertResult> {
  const { filePath } = opts
  const bindings = opts.bindings ?? DEFAULT_BINDINGS

  if (filePath && !opts.forceNew) {
    const hit = bindings.lookupBinding(filePath)
    if (hit) {
      const outcome = await tryUpdate(opts, bindings, hit.store, hit.binding)
      // A `ReboundReason` means "recoverable — create a fresh stash and rebind":
      // the stash is gone, belongs to someone else, or its trust was declined.
      // Anything else, success or failure, is the answer.
      if (typeof outcome !== 'string') return outcome
      return createFresh(opts, bindings, outcome)
    }
  }

  return createFresh(opts, bindings, undefined)
}

async function tryUpdate(
  opts: UpsertStashOptions,
  bindings: BindingsPort,
  store: ResolvedBindingStore,
  binding: StashBinding,
): Promise<StashUpsertResult | ReboundReason> {
  // ── Trust gate (R13) ──
  if (!bindings.isAccepted(store, binding)) {
    const accepted = opts.confirmTrust ? await opts.confirmTrust(binding, store) : false
    if (!accepted) return 'trust-declined' // fall through to create + rebind
    bindings.recordAcceptance(store, binding)
  }

  // ── What to send as `parentSha`, in priority order ──
  //
  //   --force            → nothing. "Mine wins", stated deliberately.
  //   explicit option    → that. The daemon knows the head it read.
  //   binding.head       → that. The normal CLI path since head tracking.
  //   a binding with no head → nothing, ONCE, and say so (D9).
  //
  // The last one is the only surprising branch. A binding written by an older
  // CLI has no head to send; refusing it would strand every stash those CLIs
  // created, and inventing one would be worse. So it overwrites once, records
  // the head from the response, and protects every update after this.
  const explicit = opts.parentSha !== undefined
  const fromBinding = binding.head ?? undefined
  const sendParentSha = opts.force ? undefined : explicit ? opts.parentSha : fromBinding
  const unprotected = !opts.force && !explicit && fromBinding === undefined

  let res: StashResponse
  try {
    res = await opts.http.put('/api/stash', {
      slug: binding.slug,
      content: opts.content,
      ...(opts.updateTitle ? { title: opts.updateTitle } : {}),
      ...(sendParentSha !== undefined ? { parentSha: sendParentSha } : {}),
      // Sent whenever known — including "markdown" — so the server can refuse a
      // stash holding the other format BEFORE it writes. An older server ignores
      // it, which is the same as not sending it.
      ...(opts.format ? { format: opts.format } : {}),
    })
  } catch {
    return networkFailure()
  }

  if (res.status >= 200 && res.status < 300) {
    const body = payload<UpdateResponseShape>(res.body)
    const head = body.head ?? null
    // Record the new head so the NEXT update is protected — including the D9
    // case, which is exactly why that case is allowed to happen once.
    if (opts.filePath) {
      bindings.recordBinding(opts.filePath, {
        slug: body.workspace.slug,
        workspaceId: body.workspace.id,
        head,
      })
    }
    return {
      ok: true,
      action: body.changed ? 'updated' : 'unchanged',
      slug: body.workspace.slug,
      workspaceId: body.workspace.id,
      changed: body.changed,
      head,
      rebound: false,
      format: body.format ?? opts.format ?? 'markdown',
      path: body.path ?? pathForFormat(body.format ?? opts.format),
      ...(unprotected ? { unprotectedUpdate: true } : {}),
    }
  }

  // Ordering below is load-bearing: the old-server test must precede the generic
  // 404, because it is the one 404 that must NOT fork a second stash.
  if (res.status === 405 || (res.status === 404 && !res.code)) {
    return fail('OLD_SERVER', res)
  }
  if (res.status === 401) return fail('UNAUTHORIZED', res)
  if (res.status === 404) return 'missing' // stash swept or deleted → recreate
  if (res.status === 403) {
    // Comment-only membership means the caller was INVITED to this document.
    // Recreating would silently fork it and strand the review, so this is the one
    // 403 that refuses instead of recovering.
    if (res.code === 'INSUFFICIENT_ROLE') return fail('KEY_ROLE', res)
    return 'foreign' // not a member at all → a fresh stash under the caller's account
  }
  if (res.status === 400) return fail('VALIDATION', res)
  // Before the generic 409: a format mismatch is not a concurrency conflict and
  // has a different remedy (a new stash, not --force), so `--force` must not
  // look like it would help.
  if (res.status === 409 && res.code === 'FORMAT_MISMATCH') return fail('FORMAT_MISMATCH', res)
  if (res.status === 409) {
    const body = res.body as { head?: string | null } | undefined
    return {
      ok: false,
      failure: {
        code: 'CONFLICT',
        status: 409,
        head: body?.head ?? null,
        ...(res.message ? { serverMessage: res.message } : {}),
      },
    }
  }
  return fail('SERVER', res)
}

async function createFresh(
  opts: UpsertStashOptions,
  bindings: BindingsPort,
  reboundReason: ReboundReason | undefined,
): Promise<StashUpsertResult> {
  // Ask BEFORE creating anything. An old server would store the HTML source as
  // markdown and report success, and the CLI has no way to delete what it made.
  if (opts.format === 'html') {
    const unsupported = await checkHtmlSupport(opts.http)
    if (unsupported) return { ok: false, failure: unsupported }
  }

  let res: StashResponse
  try {
    res = await opts.http.post('/api/stash', {
      content: opts.content,
      ...(opts.title ? { title: opts.title } : {}),
      // ONLY when html. An absent field already means markdown to the server, so
      // sending "markdown" would change a request body that has never carried it
      // — and other tests pin that body exactly.
      ...(opts.format === 'html' ? { format: 'html' } : {}),
    })
  } catch {
    return networkFailure()
  }

  if (res.status < 200 || res.status >= 300) {
    if (res.status === 401) return fail('UNAUTHORIZED', res)
    if (res.status === 409) return fail('SLUG_CONFLICT', res)
    if (res.status === 400) return fail('VALIDATION', res)
    if (res.status === 403) return fail('KEY_ROLE', res)
    return fail('SERVER', res)
  }

  const body = payload<CreateResponseShape>(res.body)
  const workspace = body.workspace

  // The backstop behind the health preflight. A server that understands `format`
  // echoes it back with the real `path`; one that silently ignored the field
  // echoes neither. Reached when the preflight could not decide — no health
  // endpoint, an unparseable or `unknown` version — which is also every case
  // where a wrong answer is most likely.
  //
  // The stash HAS been created by this point and it holds the HTML source as
  // markdown. Nothing here can undo that (there is no delete in the API this CLI
  // speaks), so the failure carries the slug and the caller names it.
  if (opts.format === 'html' && (body.format === undefined || body.path === undefined)) {
    return {
      ok: false,
      failure: { code: 'HTML_UNSUPPORTED', strandedSlug: workspace.slug },
    }
  }

  const format = body.format ?? opts.format ?? 'markdown'
  const head = body.head ?? null

  // Remember the identity so the next run updates instead of forking (R10).
  // `recordBinding` also writes the acceptance entry, which is what stops the
  // next `margins stash` on this file asking the user to trust a binding this
  // machine just wrote.
  if (opts.filePath) {
    bindings.recordBinding(opts.filePath, {
      slug: workspace.slug,
      workspaceId: workspace.id,
      head,
    })
  }

  return {
    ok: true,
    action: 'created',
    slug: workspace.slug,
    workspaceId: workspace.id,
    changed: true,
    head,
    rebound: reboundReason !== undefined,
    ...(reboundReason ? { reboundReason } : {}),
    format,
    path: body.path ?? pathForFormat(format),
  }
}

/** The document path a format implies, for a server that did not say. */
function pathForFormat(format: StashFormat | undefined): string {
  return format === 'html' ? STASH_DOC_PATH_HTML : STASH_DOC_PATH
}

/**
 * The reader deep-link for a stash — the one place this URL shape lives.
 *
 * `path` defaults to the markdown document so every existing caller is
 * unchanged, but a caller holding a result should pass `result.path`: a Design
 * lives at `document.html`, and the default would link to a document that is not
 * there.
 */
export function buildStashReviewUrl(
  serverUrl: string,
  slug: string,
  path: string = STASH_DOC_PATH,
): string {
  return `${serverUrl.replace(/\/$/, '')}/w/${slug}/-/${STASH_DOC_BRANCH}/${path}`
}
