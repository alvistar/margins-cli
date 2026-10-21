import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { _resetStore } from '../../src/lib/config.js'
import { sendPayload, startFakeAgentServer, type FakeAgentServer } from '../helpers/fake-agent-server.js'

const WS = 'ws_test_1'
const KEY = 'mrgn_synthetic_key_0000'

let configDir: string
let server: FakeAgentServer | undefined
let logs: string[]

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-wait-'))
  vi.stubEnv('MARGINS_CONFIG_DIR', configDir)
  _resetStore()
  logs = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')) })
})

afterEach(async () => {
  await server?.close()
  server = undefined
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(configDir, { recursive: true, force: true })
})

const cfg = (serverUrl: string, json = false) => ({
  apiKey: KEY, serverUrl, json, verbose: false, noColor: false,
})

/** Records each backoff the wait asks for and lets it pass at once. */
function recordingSleep(onSleep?: (ms: number, n: number) => Promise<void> | void) {
  const delays: number[] = []
  const sleep = async (ms: number) => {
    delays.push(ms)
    await onSleep?.(ms, delays.length)
  }
  return { delays, sleep }
}

describe('discuss wait', () => {
  it('holds the agent stream, claims one send, prints the wrapped payload and returns', async () => {
    const payload = sendPayload({ workspaceId: WS, sendId: 'snd_42', attempt: 2 })
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload }] })
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')

    await handleDiscussWait(cfg(server.url), { workspace: WS, session: 'sess-a' }, recordingSleep())

    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]!.path).toBe(`/api/workspaces/${WS}/agent-channel/stream`)
    expect(server.requests[0]!.authorization).toBe(`Bearer ${KEY}`)
    expect(server.requests[0]!.accept).toBe('text/event-stream')
    const out = logs.join('\n')
    expect(out).toContain('send snd_42, attempt 2')
    expect(out).toContain('margins discuss reply --send snd_42 --attempt 2')
    expect(out).toContain('margins discuss done --send snd_42 --attempt 2')
    expect(out).toContain('docs/spec.md')
    expect(out).toContain('The lease is 10 minutes.')
    expect(out).toContain('Is ten minutes enough?')
  })

  it('waits at least Retry-After, plus jitter, on 429 and 503, then claims', async () => {
    const payload = sendPayload({ workspaceId: WS })
    server = await startFakeAgentServer({
      workspaceId: WS,
      script: [
        { kind: 'refuse', status: 429, retryAfterS: 60 },
        { kind: 'refuse', status: 503, retryAfterS: 30 },
        { kind: 'deliver', payload },
      ],
    })
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')
    const { delays, sleep } = recordingSleep()

    await handleDiscussWait(cfg(server.url), { workspace: WS, session: 'sess-a' }, { sleep, random: () => 0.5 })

    expect(server.requests).toHaveLength(3)
    expect(delays).toHaveLength(2)
    expect(delays[0]).toBeGreaterThan(60_000)
    expect(delays[1]).toBeGreaterThan(30_000)
    expect(logs.join('\n')).toContain('send snd_1, attempt 1')
  })

  it('reconnects in the same process after dropped connections, and does not exit on a drop', async () => {
    const payload = sendPayload({ workspaceId: WS })
    server = await startFakeAgentServer({
      workspaceId: WS,
      script: [{ kind: 'drop' }, { kind: 'drop' }, { kind: 'drop' }, { kind: 'deliver', payload }],
    })
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')
    const { delays, sleep } = recordingSleep()

    await handleDiscussWait(cfg(server.url), { workspace: WS, session: 'sess-a' }, { sleep, random: () => 0.5 })

    expect(server.requests).toHaveLength(4)
    expect(delays).toHaveLength(3)
    // Each drop came after admission, so the backoff starts over: jittered, below the base.
    for (const d of delays) expect(d).toBeGreaterThan(0)
    for (const d of delays) expect(d).toBeLessThanOrEqual(1_000)
    expect(logs.join('\n')).toContain('send snd_1, attempt 1')
  })

  it('survives a server restart: backs off while the server is down, then claims', async () => {
    const payload = sendPayload({ workspaceId: WS })
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'hold' }, { kind: 'deliver', payload }] })
    const s = server
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')
    const { delays, sleep } = recordingSleep(async (_ms, n) => {
      if (n === 3) await s.start()
    })

    const waiting = handleDiscussWait(cfg(server.url), { workspace: WS, session: 'sess-a' }, { sleep, random: () => 0.5 })
    await vi.waitFor(() => expect(s.requests).toHaveLength(1))
    await s.stop()
    await waiting

    // Dropped once, then refused twice by a closed port: the backoff grows while it is down.
    expect(delays).toHaveLength(3)
    expect(delays[2]).toBeGreaterThan(delays[1]!)
    expect(delays[1]).toBeGreaterThan(delays[0]!)
    expect(s.requests).toHaveLength(2)
    expect(logs.join('\n')).toContain('send snd_1, attempt 1')
  })

  it('reconnects when the stream goes silent past the heartbeat window', async () => {
    const payload = sendPayload({ workspaceId: WS })
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'hold' }, { kind: 'deliver', payload }] })
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')
    const { delays, sleep } = recordingSleep()

    await handleDiscussWait(cfg(server.url), { workspace: WS, session: 'sess-a' }, { sleep, random: () => 0.5, idleTimeoutMs: 100 })

    expect(server.requests).toHaveLength(2)
    expect(delays).toHaveLength(1)
  })

  it.each([
    [401, 'UNAUTHORIZED', /auth login/],
    [403, 'AGENT_KEY_OUT_OF_BOUND', /.+/],
    [404, 'WORKSPACE_NOT_FOUND', /.+/],
  ])('ends with an error on %i, which a retry cannot change', async (status, code, message) => {
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'status', status, code }] })
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')
    const { delays, sleep } = recordingSleep()

    const err = await handleDiscussWait(cfg(server.url), { workspace: WS, session: 'sess-a' }, { sleep }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as { userMessage?: string }).userMessage).toMatch(message)
    expect(server.requests).toHaveLength(1)
    expect(delays).toHaveLength(0)
  })

  it('refuses a send event of a protocol version it does not know', async () => {
    const payload = { ...sendPayload({ workspaceId: WS }), protocol: 2 } as unknown as ReturnType<typeof sendPayload>
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload }] })
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')

    await expect(handleDiscussWait(cfg(server.url), { workspace: WS, session: 'sess-a' }, recordingSleep()))
      .rejects.toThrow(/protocol 2/)
    expect(logs).toHaveLength(0)
  })
})

describe('discuss wait: the local store', () => {
  it('records the linked session and which session holds the send, and holds no secret', async () => {
    const payload = sendPayload({ workspaceId: WS, sendId: 'snd_7', attempt: 3 })
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload }] })
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')
    const { openAgentChannelStore } = await import('../../src/lib/agent-channel/store.js')

    await handleDiscussWait(cfg(server.url), { workspace: WS, session: 'sess-b' }, recordingSleep())

    const store = await openAgentChannelStore()
    try {
      expect(store.linkedSessions()).toEqual([
        expect.objectContaining({ sessionId: 'sess-b', workspaceId: WS }),
      ])
      expect(store.heldSends()).toEqual([
        expect.objectContaining({
          sendId: 'snd_7', attempt: 3, sessionId: 'sess-b', workspaceId: WS,
          discussionId: 'disc_1', leaseExpiresAt: '2026-10-20T10:10:15.000Z',
        }),
      ])
    } finally {
      store.close()
    }

    // Machine state only: neither the credential nor what people wrote is on disk.
    const files = fs.readdirSync(configDir).filter((f) => f.startsWith('agent-channel'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const bytes = fs.readFileSync(path.join(configDir, f)).toString('latin1')
      expect(bytes).not.toContain(KEY)
      expect(bytes).not.toContain('Is ten minutes enough?')
    }
  })

  it('a new attempt of the same send moves it to the session that claimed it', async () => {
    server = await startFakeAgentServer({
      workspaceId: WS,
      script: [
        { kind: 'deliver', payload: sendPayload({ workspaceId: WS, sendId: 'snd_9', attempt: 1 }) },
        { kind: 'deliver', payload: sendPayload({ workspaceId: WS, sendId: 'snd_9', attempt: 2 }) },
      ],
    })
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')
    const { openAgentChannelStore } = await import('../../src/lib/agent-channel/store.js')

    await handleDiscussWait(cfg(server.url), { workspace: WS, session: 'sess-a' }, recordingSleep())
    await handleDiscussWait(cfg(server.url), { workspace: WS, session: 'sess-b' }, recordingSleep())

    const store = await openAgentChannelStore()
    try {
      expect(store.heldSends()).toEqual([expect.objectContaining({ sendId: 'snd_9', attempt: 2, sessionId: 'sess-b' })])
      expect(store.linkedSessions().map((l) => l.sessionId).sort()).toEqual(['sess-a', 'sess-b'])
    } finally {
      store.close()
    }
  })
})
