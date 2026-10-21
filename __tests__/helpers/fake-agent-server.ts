/**
 * A fake Margins that honours the agent-channel wire contract for the stream
 * (PROTOCOL.md "Wire contract", "The agent stream"): `GET
 * /api/workspaces/{w}/agent-channel/stream`, refusal with `Retry-After` and the
 * `apiError` body, a first `heartbeat`, one `send` event, then the end of the
 * response. Each connection plays the next step of a script, so a test decides
 * when admission refuses, when the connection drops and when a send arrives.
 */
import * as http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import {
  AGENT_CHANNEL_ERROR,
  AGENT_CHANNEL_PATHS,
  AGENT_CHANNEL_PROTOCOL_VERSION,
  AGENT_STREAM_EVENT,
  renderSendPrompt,
  type SendEventPayload,
} from '../../src/lib/agent-channel/protocol.js'

export type StreamStep =
  /** Admission refused: 429 (agent share full) or 503 (server full), with `Retry-After`. */
  | { kind: 'refuse'; status: 429 | 503; retryAfterS: number }
  /** Admission passes, one heartbeat, then the socket is destroyed (the ~5 min long-poll drop). */
  | { kind: 'drop' }
  /** Admission passes, then heartbeats only; the connection stays open until the test acts. */
  | { kind: 'hold' }
  /** Admission passes, one heartbeat, then the claimed send and the end of the response. */
  | { kind: 'deliver'; payload: SendEventPayload }
  /** Any other status with an `apiError` body (401, 403, 404). */
  | { kind: 'status'; status: number; code: string }

export interface StreamRequest {
  path: string
  authorization: string | undefined
  accept: string | undefined
}

export interface FakeAgentServer {
  url: string
  requests: StreamRequest[]
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

export async function startFakeAgentServer(opts: { workspaceId: string; script: StreamStep[] }): Promise<FakeAgentServer> {
  const requests: StreamRequest[] = []
  const sockets = new Set<Socket>()
  const streamPath = AGENT_CHANNEL_PATHS.stream(opts.workspaceId)
  let step = 0

  const handler: http.RequestListener = (req, res) => {
    requests.push({ path: req.url ?? '', authorization: req.headers.authorization, accept: req.headers.accept })
    if (req.method !== 'GET' || req.url !== streamPath) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'NOT_FOUND', message: 'No such route.' }))
      return
    }
    const next = opts.script[Math.min(step, opts.script.length - 1)]!
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
    } else if (next.kind === 'deliver') {
      res.write(sse(AGENT_STREAM_EVENT.send, next.payload, `${next.payload.send.id}.${next.payload.send.attempt}`))
      res.end()
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
