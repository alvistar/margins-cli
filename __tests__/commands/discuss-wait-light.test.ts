/**
 * #39: the agent key mint, Margins Light vs the cloud.
 *
 * The published Light runtime has no `/api/keys`: it mints with
 * `POST /api/local/agent-keys`, behind the daemon's capability token from the discovery
 * record (`~/.margins/daemons/<storeKey>.json`), and refuses a request that carries an API
 * key. The CLI tells the two apart from that record, never from the URL alone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { _resetStore } from '../../src/lib/config.js'
import { sendPayload, startFakeAgentServer, type FakeAgentServer } from '../helpers/fake-agent-server.js'

const WS = 'ws_light_1'
const KEY = 'mrgn_synthetic_key_0000'
const LOCAL_TOKEN = 'local_capability_token_synthetic'

let configDir: string
let marginsHome: string
let server: FakeAgentServer | undefined

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-wait-light-'))
  marginsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-home-light-'))
  vi.stubEnv('MARGINS_CONFIG_DIR', configDir)
  vi.stubEnv('MARGINS_HOME', marginsHome)
  _resetStore()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  await server?.close()
  server = undefined
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(configDir, { recursive: true, force: true })
  fs.rmSync(marginsHome, { recursive: true, force: true })
})

const cfg = (serverUrl: string) => ({ apiKey: KEY, serverUrl, json: false, verbose: false, noColor: false })
const noSleep = { sleep: async () => {} }

/** The record a running daemon publishes (margins/scripts/lib/daemon.mjs). */
function publishDaemon(record: { port: number; token?: string; pid?: number }, name = '0123456789abcdef'): void {
  const dir = path.join(marginsHome, 'daemons')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({
    v: 2, marker: 'margins-daemon', store: '/synthetic/store', pid: record.pid ?? process.pid,
    startedAt: Date.now(), port: record.port, token: record.token, ready: true,
  }), { mode: 0o600 })
}

const portOf = (url: string) => Number(new URL(url).port)
const mints = (s: FakeAgentServer) => s.requests.filter((r) => r.method === 'POST' && /^\/api\/(keys|local\/agent-keys)$/.test(r.path))

describe('discuss wait: agent key mint against Margins Light', () => {
  it('mints through POST /api/local/agent-keys with the capability token and no API key, and stores the key', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, light: { token: LOCAL_TOKEN }, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }) }] })
    publishDaemon({ port: portOf(server.url), token: LOCAL_TOKEN })
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')

    await handleDiscussWait(cfg(server.url), { workspace: WS, session: 'sess-a' }, noSleep)

    const [mint, ...more] = mints(server)
    expect(more).toHaveLength(0)
    expect(mint!.path).toBe('/api/local/agent-keys')
    expect(mint!.marginsToken).toBe(LOCAL_TOKEN)
    expect(mint!.authorization).toBeUndefined()
    expect(mint!.body).toEqual({ workspaceId: WS, label: expect.stringMatching(/^margins-cli on /) })
    expect(server.streamRequests.map((r) => r.authorization)).toEqual([`Bearer ${server.minted[0]!.key}`])
    const stored = JSON.parse(fs.readFileSync(path.join(configDir, 'agent-keys.json'), 'utf8')) as Record<string, { key: string }>
    expect(Object.values(stored).map((k) => k.key)).toEqual([server.minted[0]!.key])
  })

  it('mints again through the same Light route when the key gets a 401', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, light: { token: LOCAL_TOKEN }, script: [{ kind: 'status', status: 401, code: 'UNAUTHORIZED' }] })
    publishDaemon({ port: portOf(server.url), token: LOCAL_TOKEN })
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')

    await handleDiscussWait(cfg(server.url), { workspace: WS, session: 'sess-a' }, noSleep).catch(() => {})

    expect(mints(server).map((r) => [r.path, r.marginsToken, r.authorization])).toEqual([
      ['/api/local/agent-keys', LOCAL_TOKEN, undefined],
      ['/api/local/agent-keys', LOCAL_TOKEN, undefined],
    ])
    expect(server.minted).toHaveLength(2)
  })

  it('points at restarting the daemon when it refuses the capability token', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, light: { token: LOCAL_TOKEN } })
    publishDaemon({ port: portOf(server.url), token: 'stale_token_from_an_earlier_run' })
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')
    const { AgentKeyMintRefused } = await import('../../src/lib/agent-channel/agent-key.js')

    const err = await handleDiscussWait(cfg(server.url), { workspace: WS, session: 'sess-a' }, noSleep).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(AgentKeyMintRefused)
    expect((err as { userMessage?: string }).userMessage).toMatch(/FORBIDDEN_TOKEN.*margins stop/)
    expect(server.minted).toHaveLength(0)
  })

  it('names the daemon when the discovery record has no capability token', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, light: { token: LOCAL_TOKEN } })
    publishDaemon({ port: portOf(server.url) })
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')

    const err = await handleDiscussWait(cfg(server.url), { workspace: WS, session: 'sess-a' }, noSleep).catch((e: unknown) => e)

    expect((err as { userMessage?: string }).userMessage).toMatch(/margins stop/)
    expect(mints(server)).toHaveLength(0)
  })
})

describe('discuss wait: agent key mint against the cloud', () => {
  it('mints through POST /api/keys with the login, without the capability token', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }) }] })
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')

    await handleDiscussWait(cfg(server.url), { workspace: WS, session: 'sess-a' }, noSleep)

    const [mint, ...more] = mints(server)
    expect(more).toHaveLength(0)
    expect(mint!.path).toBe('/api/keys')
    expect(mint!.authorization).toBe(`Bearer ${KEY}`)
    expect(mint!.marginsToken).toBeUndefined()
    expect(mint!.body).toEqual({ agent: { workspaceId: WS }, label: expect.stringMatching(/^margins-cli on /) })
  })

  it('re-mints through POST /api/keys on a 401', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'status', status: 401, code: 'UNAUTHORIZED' }] })
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')

    await handleDiscussWait(cfg(server.url), { workspace: WS, session: 'sess-a' }, noSleep).catch(() => {})

    expect(mints(server).map((r) => [r.path, r.authorization])).toEqual([
      ['/api/keys', `Bearer ${KEY}`],
      ['/api/keys', `Bearer ${KEY}`],
    ])
  })

  it.each([
    ['a daemon on another port', (port: number) => publishDaemon({ port: port + 1, token: LOCAL_TOKEN })],
    ['a dead daemon on this port', (port: number) => publishDaemon({ port, token: LOCAL_TOKEN, pid: 2 ** 22 + 7 })],
  ])('ignores %s', async (_name, publish) => {
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }) }] })
    publish(portOf(server.url))
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')

    await handleDiscussWait(cfg(server.url), { workspace: WS, session: 'sess-a' }, noSleep)

    expect(mints(server).map((r) => [r.path, r.marginsToken])).toEqual([['/api/keys', undefined]])
  })
})

describe('liveDaemonAt: the capability token goes to a loopback http URL only', () => {
  it('names the daemon at every loopback spelling of its port', async () => {
    publishDaemon({ port: 45678, token: LOCAL_TOKEN })
    const { liveDaemonAt } = await import('../../src/lib/runtime.js')

    for (const url of ['http://127.0.0.1:45678', 'http://localhost:45678', 'http://[::1]:45678']) {
      expect(liveDaemonAt(url)).toEqual({ port: 45678, token: LOCAL_TOKEN })
    }
  })

  it.each([
    ['another host', 'http://example.invalid:45678'],
    ['https on loopback', 'https://127.0.0.1:45678'],
  ])('ignores %s, even with a live record on that port', async (_name, url) => {
    publishDaemon({ port: 45678, token: LOCAL_TOKEN })
    const { liveDaemonAt } = await import('../../src/lib/runtime.js')

    expect(liveDaemonAt(url)).toBeNull()
  })
})
