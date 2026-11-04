/**
 * A fake Margins that honours the agent-channel wire contract (PROTOCOL.md "Wire
 * contract", "The agent stream", "The agent key"):
 *
 * - `GET /api/workspaces/{w}/agent-channel/stream`: refusal with `Retry-After` and the
 *   `apiError` body, a first `heartbeat`, one `send` event, then the end of the
 *   response. Each connection plays the next step of a script, so a test decides when
 *   admission refuses, when the connection drops and when a send arrives.
 * - `POST /api/keys` with `{ agent: { workspaceId } }`: mints an agent key, behind a
 *   login (an agent key is refused with 403 `KEY_CANNOT_MANAGE_KEYS`).
 * - With `light`, the published Margins Light runtime instead: no `/api/keys` (404), and
 *   `POST /api/local/agent-keys { workspaceId, label?, expiresAt? }` mints behind the
 *   daemon's capability token in `x-margins-token`; a Bearer that is an API key is refused
 *   with 403 `KEY_CANNOT_MANAGE_KEYS`, a wrong or absent token with 403 `FORBIDDEN_TOKEN`.
 * - `POST /api/workspaces/{w}/agent-channel/sends/{s}/{action}`: judged by the
 *   protocol's own reference model (`applySendEvent`), so the fake fences, replays and
 *   refuses as the server does. A delivered send is claimed through the same model.
 * - `POST …/sends/{s}/edit` (#340, `edit/route.ts`): writes the send's `document` when the
 *   test gave one. A Margins Light document answers 403 `AGENT_SEND_EDIT_NOT_ALLOWED` with
 *   the server's sentence; a stale base merges or answers 409 `SYNC_MERGE_CONFLICT` with
 *   `conflicts`, `text` and `head`, as `onStaleBase` says; one written edit per send. The
 *   conflict is judged before the reference model, so it is not stored, as on the server.
 * - A `deliver` step with `mode` decides the payload's mode as the server does at claim
 *   (`sendModeOf`), from the minted key's actions and the stream's
 *   `Margins-Agent-Capabilities` header.
 */
import * as http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import {
  AGENT_CHANNEL_ERROR,
  AGENT_CHANNEL_PATHS,
  AGENT_CHANNEL_PROTOCOL_VERSION,
  AGENT_STREAM_EVENT,
  AGENT_ACTIONS,
  AGENT_CAPABILITIES_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_PATTERN,
  applySendEvent,
  newSendRecord,
  parseAgentCapabilities,
  renderSendPrompt,
  sendModeOf,
  type AgentAction,
  type EditResult,
  type SendDocument,
  type SendEventPayload,
  type SendRecord,
} from '../../src/lib/agent-channel/protocol.js'

export type StreamStep =
  /** Admission refused: 429 (agent share full) or 503 (server full), with `Retry-After`. */
  | { kind: 'refuse'; status: 429 | 503; retryAfterS: number }
  /** Admission passes, one heartbeat, then the socket is destroyed (the ~5 min long-poll drop). */
  | { kind: 'drop' }
  /**
   * Admission passes, then heartbeats every `heartbeatMs` (default: none after the first).
   * Open until the test acts, or until `endAfterMs`, when the server ends the response.
   */
  | { kind: 'hold'; heartbeatMs?: number; endAfterMs?: number }
  /**
   * Admission passes, one heartbeat, then the claimed send and the end of the response.
   * With `mode`, the payload's mode and prompt are decided at claim as the server does.
   */
  | { kind: 'deliver'; payload: SendEventPayload; mode?: { document: SendDocument; senderMayWrite?: boolean; baseSha: string } }
  /** Any other status with an `apiError` body (401, 403, 404). */
  | { kind: 'status'; status: number; code: string }

export interface StreamRequest {
  method: string
  path: string
  authorization: string | undefined
  accept: string | undefined
  idempotencyKey: string | undefined
  /** The `x-margins-token` header (the Light daemon's capability token). */
  marginsToken: string | undefined
  /** The `Margins-Agent-Capabilities` header (#340). */
  capabilities: string | undefined
  /** The JSON body of a POST, parsed. */
  body?: Record<string, unknown>
  /** When the request arrived (ms since epoch). */
  at: number
}

/** An agent key the fake minted. */
export interface MintedKey {
  id: string
  key: string
  workspaceId: string
  expiresAt: string
}

/** The document a send is about, for the `edit` route. */
export interface FakeDocument extends SendDocument {
  text: string
  head: string
  /** A `baseSha` behind `head`: a conflict (the default), or the merged text. */
  onStaleBase?: 'conflict' | ((sent: string, current: string) => string)
}

export interface FakeAgentServer {
  url: string
  requests: StreamRequest[]
  /** The requests to the agent stream only (no key mint, no action). */
  readonly streamRequests: StreamRequest[]
  /** Every agent key minted, in order. */
  minted: MintedKey[]
  /** The sends the stream delivered, by id, as the reference model holds them. */
  sends: Map<string, SendRecord>
  /** Accepted (not replayed) actions, in order: what landed on the page. */
  accepted: { sendId: string; action: AgentAction; attempt: number; idempotencyKey: string; body: Record<string, unknown> }[]
  /** The document of each send, by send id, which the `edit` route writes. */
  documents: Map<string, FakeDocument>
  /** The next `n` action requests are judged and committed, then the socket dies before the answer. */
  loseResponses(n: number): void
  /** Revoke an agent key: the server answers 401 to it from now on. */
  revoke(key: string): void
  /** A person resolves the sent thread (O1). */
  resolveThread(sendId: string): void
  /** Stop answering: close the listener and destroy every open socket (a server restart, first half). */
  stop(): Promise<void>
  /** Listen again on the same port (a server restart, second half). */
  start(): Promise<void>
  close(): Promise<void>
}

export function sendPayload(opts: { workspaceId: string; sendId?: string; attempt?: number }): SendEventPayload {
  const sendId = opts.sendId ?? 'snd_1'
  const attempt = opts.attempt ?? 1
  return {
    protocol: AGENT_CHANNEL_PROTOCOL_VERSION,
    send: {
      id: sendId,
      attempt,
      workspaceId: opts.workspaceId,
      discussionId: 'disc_1',
      leaseExpiresAt: '2026-10-20T10:10:15.000Z',
    },
    mode: 'suggest',
    document: { format: 'markdown', baseSha: null },
    prompt: renderSendPrompt(
      {
        sendId,
        attempt,
        path: 'docs/spec.md',
        quote: 'The lease is 10 minutes.',
        document: '# Spec\n\nThe lease is 10 minutes.\n',
        messages: [{ author: 'Ada Writer', text: 'Is ten minutes enough?' }],
      },
      () => 'f'.repeat(32),
    ),
  }
}

function sse(event: string, data: unknown, id?: string): string {
  return [`event: ${event}`, ...(id ? [`id: ${id}`] : []), `data: ${JSON.stringify(data)}`].join('\n') + '\n\n'
}

/**
 * The propose route's refusals of a Proposal (`DiscussionCreateSchema` with `kind:
 * suggestion`, and the route's own guard), so a request the server would answer 400
 * fails here too.
 */
function proposalRefusal(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return '`proposal` must be a Suggestion.'
  const p = raw as Record<string, unknown>
  if (typeof p['replacementBody'] !== 'string') return 'A suggestion needs a replacement'
  if (p['anchorType'] !== 'text') return 'A suggestion needs a text selection'
  // The server contract since alvistar/margins#308: both are strings, and either or both may be
  // empty (an empty side is the document's edge). The fake has no document to place the passage
  // in, so it accepts any pair of strings.
  if (typeof p['anchorPrefix'] !== 'string' || typeof p['anchorSuffix'] !== 'string') return 'A suggestion needs surrounding context'
  if (p['send'] !== undefined || p['clientRef'] !== undefined) return 'An agent Proposal has no `send` or `clientRef`.'
  return undefined
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

export async function startFakeAgentServer(opts: {
  workspaceId: string
  script?: StreamStep[]
  /** Answer as the published Margins Light runtime, whose capability token is `token`. */
  light?: { token: string }
  /** The actions a minted key carries (default: all of `AGENT_ACTIONS`). */
  mintActions?: AgentAction[]
}): Promise<FakeAgentServer> {
  const mintActions = opts.mintActions ?? [...AGENT_ACTIONS]
  const documents = new Map<string, FakeDocument>()
  const keyActions = new Map<string, AgentAction[]>()
  /** The stored answer's `edit` of each written edit, by idempotency key, for a replay. */
  const editAnswers = new Map<string, EditResult>()
  const edited = new Set<string>()
  let heads = 0
  const script = opts.script ?? [{ kind: 'hold' }]
  const requests: StreamRequest[] = []
  const minted: MintedKey[] = []
  const revoked = new Set<string>()
  const sends = new Map<string, SendRecord>()
  const accepted: FakeAgentServer['accepted'] = []
  let toLose = 0
  const sockets = new Set<Socket>()
  const streamPath = AGENT_CHANNEL_PATHS.stream(opts.workspaceId)
  const actionPath = new RegExp(`^/api/workspaces/([^/]+)/agent-channel/sends/([^/]+)/(${AGENT_ACTIONS.join('|')})$`)
  let step = 0

  const bearerOf = (req: http.IncomingMessage) => req.headers.authorization?.replace(/^Bearer /, '')
  const agentKeyOf = (req: http.IncomingMessage) => minted.find((k) => k.key === bearerOf(req))

  const handleMint = (req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown>) => {
    // Human auth only: a key never mints a key.
    if (agentKeyOf(req)) {
      json(res, 403, { error: 'KEY_CANNOT_MANAGE_KEYS', message: 'API keys cannot create or manage API keys.' })
      return
    }
    const agent = body['agent'] as { workspaceId?: unknown } | undefined
    if (!agent || typeof agent.workspaceId !== 'string') {
      json(res, 400, { error: 'VALIDATION_ERROR', message: 'Not an agent key request.' })
      return
    }
    const n = minted.length + 1
    const key: MintedKey = {
      id: `key_${n}`,
      key: `mrgn_agent_synthetic_${n}`,
      workspaceId: agent.workspaceId,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }
    minted.push(key)
    keyActions.set(key.key, mintActions)
    json(res, 201, { data: { ...key, label: body['label'] ?? null, role: 'comment', actions: mintActions } })
  }

  /** `POST /api/local/agent-keys` as `margins/src/app/api/local/agent-keys/route.ts` answers it. */
  const handleLocalMint = (req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown>, token: string) => {
    if (req.headers['x-margins-token'] !== token) {
      json(res, 403, { error: 'FORBIDDEN_TOKEN', message: 'Missing or invalid capability token.' })
      return
    }
    // resolveLocalUser: a Bearer that is neither the capability token nor a JWT is read as a key.
    const bearer = bearerOf(req)
    if (bearer && bearer !== token) {
      json(res, 403, { error: 'KEY_CANNOT_MANAGE_KEYS', message: 'API keys cannot create or manage API keys.' })
      return
    }
    if (typeof body['workspaceId'] !== 'string' || body['workspaceId'].length === 0) {
      json(res, 400, { error: 'VALIDATION_ERROR', message: 'workspaceId is required.' })
      return
    }
    const n = minted.length + 1
    const key: MintedKey = {
      id: `key_${n}`,
      key: `mrgn_agent_synthetic_${n}`,
      workspaceId: body['workspaceId'],
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }
    minted.push(key)
    keyActions.set(key.key, mintActions)
    json(res, 201, { data: { ...key, label: body['label'] ?? null, role: 'comment', actions: mintActions } })
  }

  const handleAction = (req: http.IncomingMessage, res: http.ServerResponse, m: RegExpMatchArray, body: Record<string, unknown>) => {
    const [, workspaceId, sendId, action] = m as unknown as [string, string, string, AgentAction]
    const key = agentKeyOf(req)
    if (!key || revoked.has(key.key)) {
      json(res, 401, { error: 'UNAUTHORIZED', message: 'Authentication required.' })
      return
    }
    if (key.workspaceId !== workspaceId) {
      json(res, 403, { error: AGENT_CHANNEL_ERROR.keyOutOfBound.code, message: 'Out of bound.' })
      return
    }
    const idempotencyKey = req.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()] as string | undefined
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      json(res, 400, { error: AGENT_CHANNEL_ERROR.idempotencyKeyRequired.code, message: 'Key required.' })
      return
    }
    const send = sends.get(sendId)
    if (!send || workspaceId !== opts.workspaceId) {
      json(res, 404, { error: AGENT_CHANNEL_ERROR.sendNotFound.code, message: 'No such send.' })
      return
    }
    if (action === 'edit') {
      const refused = editRefusal(sendId, key.key, idempotencyKey, body)
      if (refused) {
        json(res, refused.status, refused.body)
        return
      }
    }
    if (action === 'propose') {
      const refusal = proposalRefusal(body['proposal'])
      if (refusal) {
        json(res, 400, { error: 'VALIDATION_ERROR', message: refusal })
        return
      }
    }
    const { attempt, ...rest } = body as { attempt: number }
    const { record, outcome } = applySendEvent(send, {
      type: 'action', now: Date.now(), action, attempt, idempotencyKey, body: JSON.stringify(rest),
    })
    sends.set(sendId, record)
    let edit: EditResult | undefined
    if (outcome.kind === 'accepted') {
      accepted.push({ sendId, action, attempt, idempotencyKey, body })
      if (action === 'edit') edit = writeEdit(sendId, idempotencyKey, body)
    } else if (outcome.kind === 'replayed' && action === 'edit') {
      edit = editAnswers.get(idempotencyKey)
    }
    if (toLose > 0) {
      toLose--
      req.socket.destroy()
      return
    }
    if (outcome.kind === 'refused') {
      json(res, outcome.error.status, { error: outcome.error.code, message: 'Refused.' })
      return
    }
    if (outcome.kind !== 'accepted' && outcome.kind !== 'replayed') {
      json(res, 500, { error: 'INTERNAL', message: 'Unexpected outcome.' })
      return
    }
    const createdId = action === 'reply' || action === 'propose'
      ? `disc_created_${accepted.findIndex((a) => a.idempotencyKey === idempotencyKey && a.sendId === sendId) + 1}`
      : undefined
    json(res, 200, { data: { sendId, ...outcome.result, ...(createdId ? { createdId } : {}), ...(edit ? { edit } : {}) } })
  }

  /** The `edit` route's refusals, in its order, before anything is written or stored. */
  const editRefusal = (
    sendId: string, key: string, idempotencyKey: string, body: Record<string, unknown>,
  ): { status: number; body: Record<string, unknown> } | undefined => {
    if (!(keyActions.get(key) ?? []).includes('edit')) {
      return { status: 403, body: { error: AGENT_CHANNEL_ERROR.keyOutOfBound.code, message: 'Out of bound.' } }
    }
    const { content, baseSha, format } = body
    if (typeof content !== 'string') return { status: 400, body: { error: 'VALIDATION_ERROR', message: '`content` must be the whole new document text.' } }
    if (typeof baseSha !== 'string' || !baseSha.trim()) return { status: 400, body: { error: 'VALIDATION_ERROR', message: '`baseSha` must be the version you read.' } }
    if (format !== undefined && format !== 'markdown' && format !== 'html') {
      return { status: 400, body: { error: 'VALIDATION_ERROR', message: '`format` must be "markdown" or "html".' } }
    }
    // A replay answers the stored answer, before the document is judged again.
    if (editAnswers.has(idempotencyKey)) return undefined
    const doc = documents.get(sendId)
    if (!doc) return { status: 403, body: { error: AGENT_CHANNEL_ERROR.editNotAllowed.code, message: 'The edit action writes only a Stash.' } }
    if (doc.kind === 'light') {
      // edit.ts, verbatim: the sentence the agent reads.
      return {
        status: 403,
        body: {
          error: AGENT_CHANNEL_ERROR.editNotAllowed.code,
          message: 'On Margins Light the document is your local file: edit the local file the send named, then reply. The `edit` action writes only a Stash; nothing was changed.',
        },
      }
    }
    if (doc.kind !== 'stash') return { status: 403, body: { error: AGENT_CHANNEL_ERROR.editNotAllowed.code, message: 'The edit action writes only a Stash.' } }
    if (doc.format === 'html' && format !== 'html') return { status: 400, body: { error: 'HTML_FORMAT_REQUIRED', message: 'An HTML document needs format: "html".' } }
    if ((format ?? 'markdown') !== doc.format) return { status: 409, body: { error: 'FORMAT_MISMATCH', message: `This document is ${doc.format}.` } }
    if (edited.has(sendId)) return { status: 409, body: { error: AGENT_CHANNEL_ERROR.editAlreadyApplied.code, message: 'This send already made its edit.' } }
    if (baseSha !== doc.head && content !== doc.text && (doc.format === 'html' || (doc.onStaleBase ?? 'conflict') === 'conflict')) {
      return {
        status: 409,
        body: {
          error: 'SYNC_MERGE_CONFLICT',
          message: 'The document changed since baseSha and the edit could not be merged. Nothing was written: redo the change on `text` and retry with `head` as baseSha.',
          conflicts: [{ path: 'doc.md', reason: 'content' }],
          text: doc.text,
          head: doc.head,
        },
      }
    }
    return undefined
  }

  /** Write an accepted edit: fast-forward, or the merge `onStaleBase` gives. */
  const writeEdit = (sendId: string, idempotencyKey: string, body: Record<string, unknown>): EditResult => {
    const doc = documents.get(sendId)!
    const content = body['content'] as string
    if (content === doc.text) return { changed: false, merged: false, head: doc.head, text: doc.text }
    const stale = body['baseSha'] !== doc.head
    const text = stale && typeof doc.onStaleBase === 'function' ? doc.onStaleBase(content, doc.text) : content
    const fromSha = doc.head
    const head = `sha_edit_${++heads}`
    documents.set(sendId, { ...doc, text, head })
    edited.add(sendId)
    const answer: EditResult = {
      changed: true,
      merged: stale,
      head,
      text,
      ...(doc.format === 'markdown'
        ? { diff: { fromSha, toSha: head, fromVersion: 1, toVersion: 2 }, diffUrl: `${'http://margins.test'}/doc?changes=1..2` }
        : {}),
    }
    editAnswers.set(idempotencyKey, answer)
    return answer
  }

  const handler: http.RequestListener = (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => route(req, res, Buffer.concat(chunks).toString('utf8')))
  }

  const route = (req: http.IncomingMessage, res: http.ServerResponse, raw: string) => {
    let body: Record<string, unknown> | undefined
    try {
      body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined
    } catch {
      body = undefined
    }
    requests.push({
      method: req.method ?? 'GET',
      path: req.url ?? '',
      authorization: req.headers.authorization,
      accept: req.headers.accept,
      idempotencyKey: req.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()] as string | undefined,
      marginsToken: req.headers['x-margins-token'] as string | undefined,
      capabilities: req.headers[AGENT_CAPABILITIES_HEADER.toLowerCase()] as string | undefined,
      ...(body ? { body } : {}),
      at: Date.now(),
    })
    if (opts.light && req.method === 'POST' && req.url === '/api/local/agent-keys') {
      handleLocalMint(req, res, body ?? {}, opts.light.token)
      return
    }
    if (!opts.light && req.method === 'POST' && req.url === '/api/keys') {
      handleMint(req, res, body ?? {})
      return
    }
    const action = req.method === 'POST' ? (req.url ?? '').match(actionPath) : null
    if (action) {
      handleAction(req, res, action, body ?? {})
      return
    }
    if (req.method !== 'GET' || req.url !== streamPath) {
      json(res, 404, { error: 'NOT_FOUND', message: 'No such route.' })
      return
    }
    const key = agentKeyOf(req)
    if (key && revoked.has(key.key)) {
      json(res, 401, { error: 'UNAUTHORIZED', message: 'Authentication required.' })
      return
    }
    const next = script[Math.min(step, script.length - 1)]!
    step++
    if (next.kind === 'refuse') {
      const code = next.status === 429 ? AGENT_CHANNEL_ERROR.agentShareFull.code : AGENT_CHANNEL_ERROR.serverFull.code
      res.writeHead(next.status, { 'Content-Type': 'application/json', 'Retry-After': String(next.retryAfterS) })
      res.end(JSON.stringify({ error: code, message: 'Full; retry later.' }))
      return
    }
    if (next.kind === 'status') {
      res.writeHead(next.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: next.code, message: 'Refused.' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform' })
    res.write(sse(AGENT_STREAM_EVENT.heartbeat, { at: new Date().toISOString() }))
    if (next.kind === 'drop') {
      setImmediate(() => req.socket.destroy())
    } else if (next.kind === 'hold' && next.heartbeatMs) {
      const beat = setInterval(() => res.write(sse(AGENT_STREAM_EVENT.heartbeat, { at: new Date().toISOString() })), next.heartbeatMs)
      res.on('close', () => clearInterval(beat))
      if (next.endAfterMs) setTimeout(() => res.end(), next.endAfterMs)
    } else if (next.kind === 'deliver') {
      // The claim, through the reference model: the send is now held by this attempt.
      const prior = sends.get(next.payload.send.id) ?? { ...newSendRecord(), attempt: next.payload.send.attempt - 1 }
      sends.set(next.payload.send.id, applySendEvent(prior, { type: 'claim', now: Date.now() }).record)
      const payload = next.mode ? decideMode(next.payload, next.mode, key?.key, req.headers[AGENT_CAPABILITIES_HEADER.toLowerCase()] as string | undefined) : next.payload
      // A comment line and an event name the client does not know: both are ignored.
      res.write(': keep-alive\n\n')
      res.write(sse('presence', { state: 'listening' }))
      res.write(sse(AGENT_STREAM_EVENT.send, payload, `${payload.send.id}.${payload.send.attempt}`))
      res.end()
    }
  }

  /** The claim's mode decision (`sendModeOf`), and the prompt that says it. */
  const decideMode = (
    payload: SendEventPayload,
    m: NonNullable<Extract<StreamStep, { kind: 'deliver' }>['mode']>,
    key: string | undefined,
    capabilities: string | undefined,
  ): SendEventPayload => {
    const mode = sendModeOf({
      document: m.document,
      senderMayWrite: m.senderMayWrite ?? true,
      keyActions: key ? keyActions.get(key) ?? [] : [],
      clientCapabilities: parseAgentCapabilities(capabilities ?? null),
    })
    const promptMode = mode === 'suggest'
      ? { kind: 'suggest' as const }
      : m.document.kind === 'light'
        ? { kind: 'edit-local' as const, file: '/home/ada/notes/doc.md' }
        : { kind: 'edit' as const, format: m.document.format, baseSha: m.baseSha }
    return {
      ...payload,
      mode,
      document: { format: m.document.format, baseSha: m.baseSha },
      prompt: renderSendPrompt(
        {
          sendId: payload.send.id,
          attempt: payload.send.attempt,
          path: 'docs/spec.md',
          quote: 'The lease is 10 minutes.',
          document: '# Spec\n\nThe lease is 10 minutes.\n',
          messages: [{ author: 'Ada Writer', text: 'Is ten minutes enough?' }],
          mode: promptMode,
        },
        () => 'f'.repeat(32),
      ),
    }
  }

  let server = http.createServer(handler)
  const track = (s: http.Server) => s.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  track(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  const stop = () => new Promise<void>((resolve) => {
    for (const s of sockets) s.destroy()
    server.close(() => resolve())
  })

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get streamRequests() {
      return requests.filter((r) => r.method === 'GET' && r.path === streamPath)
    },
    minted,
    sends,
    accepted,
    documents,
    loseResponses(n) {
      toLose = n
    },
    revoke(key) {
      revoked.add(key)
    },
    resolveThread(sendId) {
      const send = sends.get(sendId)
      if (send) sends.set(sendId, applySendEvent(send, { type: 'thread-resolved', now: Date.now() }).record)
    },
    stop,
    async start() {
      server = http.createServer(handler)
      track(server)
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
    },
    async close() {
      if (server.listening) await stop()
    },
  }
}
