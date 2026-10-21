/**
 * actions.ts — the client half of an agent action (PROTOCOL.md "Action requests and
 * answers", "Idempotency", "Errors").
 *
 * One action on one claimed send: `POST .../sends/{s}/{action}` with the attempt, an
 * `Idempotency-Key` and the agent key. The key and the request go to the outbox
 * before the first byte is sent, and leave it only when an answer arrives, so a resend
 * after a lost response — in this process, or by running the same command again — is
 * the same request with the same key, and the server replays its first answer
 * instead of writing twice.
 *
 * On 409 `AGENT_SEND_ATTEMPT_SUPERSEDED` or `AGENT_SEND_CLOSED` the session stops
 * acting on that send and the outbox drops every entry of it.
 */
import { randomUUID } from 'node:crypto'
import type { ResolvedConfig } from '../config.js'
import type { ApiClient } from '../api-client.js'
import {
  AuthExpired, ConflictError, MarginsError, NetworkError, NotFoundError, ResponseParseError, ServerError, TimeoutError,
  ValidationError,
} from '../errors.js'
import { withAgentKey } from './agent-key.js'
import {
  AGENT_CHANNEL_ERROR,
  AGENT_CHANNEL_PATHS,
  IDEMPOTENCY_KEY_HEADER,
  type ActionRequestBody,
  type ActionResponseBody,
  type AgentAction,
} from './protocol.js'
import { openAgentChannelStore, type AgentChannelStore } from './store.js'

/** Sends of one request before the command gives up and leaves it in the outbox. */
const MAX_SENDS = 3
const RESEND_BASE_MS = 1_000

export interface AgentActionRequest {
  action: AgentAction
  sendId: string
  attempt: number
  /** The Workspace id; else the one the local store recorded when `wait` received the send. */
  workspaceId?: string
  body: Omit<ActionRequestBody, 'attempt'>
}

export interface AgentActionDeps {
  sleep?: (ms: number) => Promise<void>
}

/** The session must stop acting on this send: a newer claim holds it, or it is closed. */
export class SendNoLongerHeldError extends MarginsError {
  constructor(sendId: string, code: string) {
    super(
      `Send ${sendId}: ${code}`,
      code === AGENT_CHANNEL_ERROR.sendClosed.code
        ? `Send ${sendId} is closed (${code}): it was answered, or a person resolved the thread. Stop acting on it.`
        : `Send ${sendId}: this attempt no longer holds the claim (${code}). Stop acting on it; a newer claim answers it.`,
      1,
    )
  }
}

export class ActionLeftInOutboxError extends MarginsError {
  constructor(action: AgentAction, sendId: string, cause: MarginsError) {
    super(
      `${action} on send ${sendId} unanswered: ${cause.message}`,
      `${cause.userMessage}\nThe ${action} stays in the outbox: run the same command again to resend it (the server will not write it twice).`,
      1,
    )
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A failure after which the request may have landed or not: resend it with the same key. */
function isLostResponse(err: unknown): err is MarginsError {
  return err instanceof NetworkError
    || err instanceof ResponseParseError
    || err instanceof TimeoutError
    || (err instanceof ServerError && err.status >= 500)
}

function refusalCode(err: unknown): string | undefined {
  if (err instanceof ConflictError || err instanceof NotFoundError || err instanceof ServerError) return err.code
  return undefined
}

/**
 * A success answer that does not name the send, attempt and state proves nothing: it
 * fails as unreadable, a lost response, and the request stays in the outbox.
 */
function parseAnswer(raw: unknown): ActionResponseBody {
  const a = raw as Partial<ActionResponseBody> | null
  if (!a || typeof a.sendId !== 'string' || !Number.isSafeInteger(a.attempt) || typeof a.state !== 'string') {
    throw new ResponseParseError()
  }
  return a as ActionResponseBody
}

/** The outbox is the protocol's idempotency: an unusable store fails the action. */
async function inOutbox<T>(use: (store: AgentChannelStore) => T): Promise<T> {
  const store = await openAgentChannelStore()
  try {
    return use(store)
  } finally {
    store.close()
  }
}

export async function sendAgentAction(
  cfg: ResolvedConfig,
  req: AgentActionRequest,
  deps: AgentActionDeps = {},
): Promise<ActionResponseBody> {
  const sleep = deps.sleep ?? defaultSleep
  const requestBody: ActionRequestBody = { attempt: req.attempt, ...req.body }
  const bodyJson = JSON.stringify(requestBody)

  // An unusable store fails the command rather than risk a second write under a new key.
  const entry = await inOutbox((store) => {
    const workspaceId = req.workspaceId
      ?? store.heldSends().find((h) => h.sendId === req.sendId)?.workspaceId
    if (!workspaceId) {
      throw new ValidationError(
        `No Workspace on record for send ${req.sendId}. Pass --workspace <id> (the id \`margins discuss wait\` was run with).`,
      )
    }
    const pending = store.pendingAction(workspaceId, req.sendId, req.action, req.attempt, bodyJson)
    if (pending) return pending
    const fresh = {
      idempotencyKey: `${req.action}-${randomUUID()}`,
      sendId: req.sendId,
      workspaceId,
      action: req.action,
      attempt: req.attempt,
      body: bodyJson,
    }
    store.queueAction(fresh)
    return fresh
  })

  // Each id is one path segment: a `/` or `..` in it must never reach another route.
  const path = AGENT_CHANNEL_PATHS.action(encodeURIComponent(entry.workspaceId), encodeURIComponent(req.sendId), req.action)
  const post = async (client: ApiClient): Promise<ActionResponseBody> => {
    for (let sends = 1; ; sends++) {
      try {
        return parseAnswer(await client.post(path, requestBody, { [IDEMPOTENCY_KEY_HEADER]: entry.idempotencyKey }))
      } catch (err) {
        if (!isLostResponse(err) || sends >= MAX_SENDS) throw err
        await sleep(RESEND_BASE_MS * 2 ** (sends - 1))
      }
    }
  }

  try {
    // A revoked key is minted again inside, and the same request resent under the same key.
    const answer = await withAgentKey(cfg, entry.workspaceId, post)
    await inOutbox((store) => store.settleAction(entry.idempotencyKey))
    return answer
  } catch (err) {
    // The answer may have been lost, or the login cannot mint a key now: either way the
    // request may yet land, so it stays in the outbox for the same command to resend.
    if (isLostResponse(err) || err instanceof AuthExpired) throw new ActionLeftInOutboxError(req.action, req.sendId, err)
    const code = refusalCode(err)
    if (code === AGENT_CHANNEL_ERROR.sendClosed.code) {
      await inOutbox((store) => store.dropSend(req.sendId))
      throw new SendNoLongerHeldError(req.sendId, code)
    }
    if (code === AGENT_CHANNEL_ERROR.attemptSuperseded.code) {
      // A newer attempt (another session's) may have entries of its own waiting to resend.
      await inOutbox((store) => store.dropSend(req.sendId, req.attempt))
      throw new SendNoLongerHeldError(req.sendId, code)
    }
    // Any other refusal changed nothing (only accepted actions are stored), and the
    // same request would be refused again: it leaves the outbox.
    await inOutbox((store) => store.settleAction(entry.idempotencyKey))
    throw err
  }
}
