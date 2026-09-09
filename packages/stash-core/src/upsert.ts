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

export type StashFailureCode =
  | 'UNAUTHORIZED'
  | 'KEY_ROLE'
  | 'OLD_SERVER'
  | 'CONFLICT'
  | 'SLUG_CONFLICT'
  | 'VALIDATION'
  | 'SERVER'
  | 'NETWORK'

export interface StashFailure {
  code: StashFailureCode
  /** The server's own wording, when it sent any. Never a placeholder. */
  serverMessage?: string
  /** HTTP status, when there was a response to read one from. */
  status?: number
  /** Present on CONFLICT: the head the caller's `parentSha` disagreed with. */
  head?: string | null
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
}

interface UpdateResponseShape {
  workspace: { id: string; slug: string; name: string }
  changed: boolean
  url: string
  head: string | null
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

  let res: StashResponse
  try {
    res = await opts.http.put('/api/stash', {
      slug: binding.slug,
      content: opts.content,
      ...(opts.updateTitle ? { title: opts.updateTitle } : {}),
      ...(opts.parentSha !== undefined ? { parentSha: opts.parentSha } : {}),
    })
  } catch {
    return networkFailure()
  }

  if (res.status >= 200 && res.status < 300) {
    const body = res.body as UpdateResponseShape
    return {
      ok: true,
      action: body.changed ? 'updated' : 'unchanged',
      slug: body.workspace.slug,
      workspaceId: body.workspace.id,
      changed: body.changed,
      head: body.head ?? null,
      rebound: false,
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
  let res: StashResponse
  try {
    res = await opts.http.post('/api/stash', {
      content: opts.content,
      ...(opts.title ? { title: opts.title } : {}),
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

  const body = res.body as CreateResponseShape
  const workspace = body.workspace

  // Remember the identity so the next run updates instead of forking (R10).
  // `recordBinding` also writes the acceptance entry, which is what stops the
  // next `margins stash` on this file asking the user to trust a binding this
  // machine just wrote.
  if (opts.filePath) {
    bindings.recordBinding(opts.filePath, { slug: workspace.slug, workspaceId: workspace.id })
  }

  return {
    ok: true,
    action: 'created',
    slug: workspace.slug,
    workspaceId: workspace.id,
    changed: true,
    head: null,
    rebound: reboundReason !== undefined,
    ...(reboundReason ? { reboundReason } : {}),
  }
}

/** The reader deep-link for a stash — the one place this URL shape lives. */
export function buildStashReviewUrl(serverUrl: string, slug: string): string {
  return `${serverUrl.replace(/\/$/, '')}/w/${slug}/-/${STASH_DOC_BRANCH}/${STASH_DOC_PATH}`
}
