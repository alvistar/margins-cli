/**
 * wait.ts — the client half of the agent stream (PROTOCOL.md "The agent stream").
 *
 * Holds `GET /api/workspaces/{w}/agent-channel/stream` until the server claims one
 * send of the caller and writes it as a `send` event, then returns that payload.
 *
 * Nothing but a claimed send ends the wait. A refusal of admission (429 / 503) waits
 * at least `Retry-After` plus jitter; a dropped connection, a server restart, a
 * gateway error or a stream that goes silent reconnects in the same process with
 * jittered exponential backoff (T0, alvistar/margins#290: the long poll drops about
 * every 5 minutes, and a drop must not wake the session). Only a refusal that a retry
 * cannot change (401, 403, 404, another 4xx, an unknown protocol) ends it with an error.
 */
import { CLI_VERSION } from '../version.js'
import {
  AuthExpired, ForbiddenError, NotFoundError, ResponseParseError, ServerError, ValidationError,
} from '../errors.js'
import {
  AGENT_CHANNEL_ERROR,
  AGENT_CHANNEL_PATHS,
  AGENT_CHANNEL_PROTOCOL_VERSION,
  AGENT_STREAM_EVENT,
  AGENT_STREAM_HEARTBEAT_MS,
  AGENT_STREAM_RETRY_AFTER_S,
  type SendEventPayload,
} from './protocol.js'
import { readSseEvents } from './sse.js'

/** First reconnect delay after a drop; it doubles per failure in a row. */
const BACKOFF_BASE_MS = 1_000
const BACKOFF_CAP_MS = 30_000
/** Jitter added on top of `Retry-After`, so refused streams do not return in step. */
const RETRY_AFTER_JITTER_MS = 5_000
/** No event for three heartbeats: the connection is half-open, reconnect. */
const DEFAULT_IDLE_TIMEOUT_MS = 3 * AGENT_STREAM_HEARTBEAT_MS

export interface WaitForSendOptions {
  serverUrl: string
  workspaceId: string
  /** Resolved again for each connection, so a refreshed login is picked up. */
  bearer: () => Promise<string>
  sleep?: (ms: number) => Promise<void>
  /** Jitter source in [0, 1). */
  random?: () => number
  idleTimeoutMs?: number
}

type Attempt =
  | { kind: 'send'; payload: SendEventPayload }
  | { kind: 'retry-after'; seconds: number }
  /** `admitted`: the stream passed admission (a heartbeat arrived) before it ended. */
  | { kind: 'dropped'; admitted: boolean }

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function waitForSend(opts: WaitForSendOptions): Promise<SendEventPayload> {
  const sleep = opts.sleep ?? defaultSleep
  const random = opts.random ?? Math.random
  let failures = 0

  for (;;) {
    const attempt = await connectOnce(opts)
    if (attempt.kind === 'send') return attempt.payload
    if (attempt.kind === 'retry-after') {
      await sleep(attempt.seconds * 1000 + random() * RETRY_AFTER_JITTER_MS)
      continue
    }
    // A stream that was admitted and then dropped is the normal long-poll cycle:
    // start the backoff over. Failures in a row (server down) back off further.
    failures = attempt.admitted ? 1 : failures + 1
    const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1))
    await sleep(ceiling / 2 + random() * (ceiling / 2))
  }
}

async function connectOnce(opts: WaitForSendOptions): Promise<Attempt> {
  const path = AGENT_CHANNEL_PATHS.stream(opts.workspaceId)
  const url = `${opts.serverUrl.replace(/\/$/, '')}${path}`
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const controller = new AbortController()
  let idle: ReturnType<typeof setTimeout> | undefined
  const armIdle = () => {
    clearTimeout(idle)
    idle = setTimeout(() => controller.abort(), idleTimeoutMs)
  }
  let admitted = false

  try {
    armIdle()
    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${await opts.bearer()}`,
          Accept: 'text/event-stream',
          'X-Margins-Client': `margins-cli/${CLI_VERSION}`,
        },
        signal: controller.signal,
      })
    } catch {
      return { kind: 'dropped', admitted }
    }

    if (response.status !== 200 || !response.body) return await refusal(response, path)

    try {
      for await (const event of readSseEvents(response.body)) {
        armIdle()
        if (event.event === AGENT_STREAM_EVENT.heartbeat) {
          admitted = true
        } else if (event.event === AGENT_STREAM_EVENT.send) {
          return { kind: 'send', payload: parseSendEvent(event.data) }
        }
        // Any other event name is ignored (PROTOCOL.md).
      }
    } catch (err) {
      if (err instanceof ValidationError || err instanceof ResponseParseError) throw err
    }
    return { kind: 'dropped', admitted }
  } finally {
    clearTimeout(idle)
    controller.abort()
  }
}

async function refusal(response: Response, path: string): Promise<Attempt> {
  const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null
  const code = typeof body?.error === 'string' ? body.error : undefined
  const message = typeof body?.message === 'string' ? body.message : undefined

  if (response.status === AGENT_CHANNEL_ERROR.agentShareFull.status || response.status === AGENT_CHANNEL_ERROR.serverFull.status) {
    const floor = response.status === AGENT_CHANNEL_ERROR.agentShareFull.status
      ? AGENT_STREAM_RETRY_AFTER_S.agentShareFull
      : AGENT_STREAM_RETRY_AFTER_S.serverFull
    return { kind: 'retry-after', seconds: Math.max(floor, parseRetryAfter(response.headers.get('Retry-After'))) }
  }
  if (response.status === 401) throw new AuthExpired()
  if (response.status === 403) throw new ForbiddenError(path, code, message)
  if (response.status === 404) throw new NotFoundError(path, code)
  if (response.status >= 400 && response.status < 500) throw new ServerError(response.status, code, message)
  // 5xx (a gateway during a restart) or an unexpected 2xx/3xx: try again.
  return { kind: 'dropped', admitted: false }
}

/** `Retry-After` in seconds, or as an HTTP date; 0 when absent or unreadable. */
function parseRetryAfter(header: string | null): number {
  if (!header) return 0
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds)
  const at = Date.parse(header)
  return Number.isNaN(at) ? 0 : Math.max(0, Math.ceil((at - Date.now()) / 1000))
}

function parseSendEvent(data: string): SendEventPayload {
  let payload: SendEventPayload
  try {
    payload = JSON.parse(data) as SendEventPayload
  } catch {
    throw new ResponseParseError()
  }
  if (payload?.protocol !== AGENT_CHANNEL_PROTOCOL_VERSION) {
    throw new ValidationError(
      `Margins sent agent-channel protocol ${String(payload?.protocol)}; this CLI speaks ${AGENT_CHANNEL_PROTOCOL_VERSION}. Upgrade margins-cli.`,
    )
  }
  if (typeof payload.send?.id !== 'string' || !Number.isSafeInteger(payload.send.attempt) || typeof payload.prompt !== 'string') {
    throw new ResponseParseError()
  }
  return payload
}
