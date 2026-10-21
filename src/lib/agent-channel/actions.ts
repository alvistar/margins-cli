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
import {
  AuthExpired, ConflictError, MarginsError, NetworkError, NotFoundError, ServerError, TimeoutError, ValidationError,
} from '../errors.js'
import { agentClient, forgetAgentKey, mintAgentKey, readAgentKey } from './agent-key.js'
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
    || err instanceof TimeoutError
    || (err instanceof ServerError && err.status >= 500)
}

function refusalCode(err: unknown): string | undefined {
  if (err instanceof ConflictError || err instanceof NotFoundError || err instanceof ServerError) return err.code
  return undefined
}

async function withStore<T>(use: (store: AgentChannelStore) => T): Promise<T> {
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

  // The outbox is the protocol's idempotency, not bookkeeping: an unusable store
  // fails the command rather than risk a second write under a new key.
  const entry = await withStore((store) => {
    const workspaceId = req.workspaceId
      ?? store.heldSends().find((h) => h.sendId === req.sendId)?.workspaceId
    if (!workspaceId) {
      throw new ValidationError(
        `No Workspace on record for send ${req.sendId}. Pass --workspace <id> (the id \`margins discuss wait\` was run with).`,
      )
    }
    const pending = store.pendingAction(req.sendId, req.action, req.attempt, bodyJson)
    if (pending && pending.workspaceId === workspaceId) return pending
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

  const path = AGENT_CHANNEL_PATHS.action(entry.workspaceId, req.sendId, req.action)
  const stored = readAgentKey(cfg.serverUrl, entry.workspaceId)
  let key = stored ?? await mintAgentKey(cfg, entry.workspaceId)
  let reminted = !stored

  for (let sends = 1; ; sends++) {
    try {
      const answer = await agentClient(cfg, key).post(path, requestBody, { [IDEMPOTENCY_KEY_HEADER]: entry.idempotencyKey }) as ActionResponseBody
      await withStore((store) => store.settleAction(entry.idempotencyKey))
      return answer
    } catch (err) {
      if (err instanceof AuthExpired && !reminted) {
        // A revoked or expired key: mint once through the login, resend under the same key.
        forgetAgentKey(cfg.serverUrl, entry.workspaceId)
        key = await mintAgentKey(cfg, entry.workspaceId)
        reminted = true
        sends--
        continue
      }
      if (isLostResponse(err)) {
        if (sends >= MAX_SENDS) throw new ActionLeftInOutboxError(req.action, req.sendId, err)
        await sleep(RESEND_BASE_MS * 2 ** (sends - 1))
        continue
      }
      const code = refusalCode(err)
      if (code === AGENT_CHANNEL_ERROR.attemptSuperseded.code || code === AGENT_CHANNEL_ERROR.sendClosed.code) {
        await withStore((store) => store.dropSend(req.sendId))
        throw new SendNoLongerHeldError(req.sendId, code)
      }
      // Any other refusal changed nothing (only accepted actions are stored), and the
      // same request would be refused again: it leaves the outbox.
      if (!(err instanceof AuthExpired)) await withStore((store) => store.settleAction(entry.idempotencyKey))
      throw err
    }
  }
}
