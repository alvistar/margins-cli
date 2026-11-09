/**
 * #67: a `local-` Workspace id reaches the live Margins Light daemon that holds it, with the
 * default (cloud) server URL and no `--server-url`.
 *
 * The reader's "Link a session" line prints `margins discuss wait --workspace local-<id>` and
 * nothing else; the daemon's port changes at every restart. A `local-` id does not say which
 * store holds it, and the desktop app's daemon and `margins open`'s can be live at once, so
 * the CLI asks each live daemon (the mint, on its capability token) and uses the one that holds
 * the Workspace for the whole command: the auth gate, the mint, the stream and every action.
 *
 * Only a real process proves what the gate does, so this drives the CLI from source, as
 * `auth-gate-light.test.ts` does. `MARGINS_SERVER_URL` names a fake cloud: no request may
 * reach it for a `local-` id.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendPayload, startFakeAgentServer, type FakeAgentServer } from './helpers/fake-agent-server.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL_WS = 'local-0f3a9c2e7b1d4a6f8e5c0b9d2a7f4e1c'
const CLOUD_WS = 'ws_cloud_1'
const API_KEY = 'mrgn_synthetic_key_0000'

let tmp: string
let servers: FakeAgentServer[] = []

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-light-route-'))
})
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()))
  servers = []
  fs.rmSync(tmp, { recursive: true, force: true })
})

interface Run { status: number | null; stdout: string; stderr: string }

function cli(args: string[], serverUrl: string, apiKey = ''): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'src', 'index.ts'), ...args],
      {
        cwd: tmp,
        env: {
          ...process.env,
          NO_COLOR: '1',
          CI: '',
          MARGINS_SERVER_URL: serverUrl,
          MARGINS_CONFIG_DIR: path.join(tmp, 'config'),
          MARGINS_DATA_DIR: path.join(tmp, 'data'),
          MARGINS_HOME: path.join(tmp, 'home'),
          MARGINS_PGLITE: path.join(tmp, 'home', 'store'),
          MARGINS_API_KEY: apiKey,
          MARGINS_OIDC_TOKEN: '',
          ACTIONS_ID_TOKEN_REQUEST_URL: '',
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
        },
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('exit', (status) => resolve({ status, stdout, stderr }))
  })
}

/** The record a running Light daemon publishes (margins/scripts/lib/daemon.mjs), one per store. */
function publishDaemon(store: string, port: unknown, token: string): void {
  const dir = path.join(tmp, 'home', 'daemons')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${store}.json`), JSON.stringify({
    v: 2, marker: 'margins-daemon', store: `/synthetic/${store}`, pid: process.pid,
    startedAt: Date.now(), port, token, ready: true,
  }), { mode: 0o600 })
}

const portOf = (s: FakeAgentServer) => Number(new URL(s.url).port)
const deliver = (workspaceId: string) => [{ kind: 'deliver' as const, payload: sendPayload({ workspaceId }) }]

async function fakeCloud(workspaceId = LOCAL_WS): Promise<FakeAgentServer> {
  const s = await startFakeAgentServer({ workspaceId, script: deliver(workspaceId) })
  servers.push(s)
  return s
}

/** A live Light daemon (fake) that holds `holds`, with its discovery record published. */
async function fakeDaemon(store: string, holds: string[]): Promise<FakeAgentServer> {
  const token = `capability_token_${store}`
  const s = await startFakeAgentServer({ workspaceId: LOCAL_WS, light: { token, holds }, script: deliver(LOCAL_WS) })
  servers.push(s)
  publishDaemon(store, portOf(s), token)
  return s
}

const LOGIN = /auth login/i

describe('a local- Workspace with the default (cloud) server URL (#67)', () => {
  it('one live daemon: `wait` mints on it and claims the send, then `done` answers on it, with no login and no flag', async () => {
    const cloud = await fakeCloud()
    const daemon = await fakeDaemon('store_a', [LOCAL_WS])

    const wait = await cli(['discuss', 'wait', '--workspace', LOCAL_WS, '--session', 'sess-a'], cloud.url)
    expect(wait.stderr).not.toMatch(LOGIN)
    expect(wait.status).toBe(0)
    expect(wait.stdout).toContain('snd_1')

    // The printed action commands carry no --workspace: the held send names it.
    const done = await cli(['discuss', 'done', '--send', 'snd_1', '--attempt', '1'], cloud.url)
    expect(done.stderr).not.toMatch(LOGIN)
    expect(done.status).toBe(0)

    expect(daemon.minted).toHaveLength(1)
    expect(daemon.streamRequests).toHaveLength(1)
    expect(daemon.accepted.map((a) => a.action)).toEqual(['done'])
    expect(cloud.requests).toEqual([])
  }, 60_000)

  it('two live daemons: the command reaches the second, the one that holds the Workspace', async () => {
    const cloud = await fakeCloud()
    const other = await fakeDaemon('store_a', ['local-someotherfolder'])
    const holder = await fakeDaemon('store_b', [LOCAL_WS])

    const wait = await cli(['discuss', 'wait', '--workspace', LOCAL_WS, '--session', 'sess-a'], cloud.url)
    expect(wait.status).toBe(0)
    expect(wait.stdout).toContain('snd_1')

    expect(holder.streamRequests).toHaveLength(1)
    expect(other.streamRequests).toEqual([])
    expect(other.minted).toEqual([])
    expect(cloud.requests).toEqual([])
  }, 60_000)

  it('two live daemons: a key stored for the one that does not hold it does not pick it', async () => {
    const cloud = await fakeCloud()
    const stale = await fakeDaemon('store_a', ['local-someotherfolder'])
    const holder = await fakeDaemon('store_b', [LOCAL_WS])
    // A key from an earlier daemon on the port `stale` now has: the slot is the URL.
    const slot = `http://127.0.0.1:${portOf(stale)} ${LOCAL_WS}`
    fs.mkdirSync(path.join(tmp, 'config'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'config', 'agent-keys.json'), JSON.stringify({
      [slot]: {
        id: 'key_old', key: 'mrgn_agent_synthetic_old', workspaceId: LOCAL_WS, serverUrl: `http://127.0.0.1:${portOf(stale)}`,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(), actions: ['reply', 'done'],
      },
    }), { mode: 0o600 })

    const wait = await cli(['discuss', 'wait', '--workspace', LOCAL_WS, '--session', 'sess-a'], cloud.url)
    expect(wait.status).toBe(0)
    expect(holder.streamRequests).toHaveLength(1)
    expect(stale.streamRequests).toEqual([])
  }, 60_000)

  it('two live daemons that both hold it: fails and names both ports, never picks one', async () => {
    const cloud = await fakeCloud()
    const a = await fakeDaemon('store_a', [LOCAL_WS])
    const b = await fakeDaemon('store_b', [LOCAL_WS])

    const wait = await cli(['discuss', 'wait', '--workspace', LOCAL_WS, '--session', 'sess-a'], cloud.url)
    expect(wait.status).toBe(1)
    expect(wait.stderr).toContain(String(portOf(a)))
    expect(wait.stderr).toContain(String(portOf(b)))
    expect(wait.stderr).toContain('--server-url')
    expect([...a.streamRequests, ...b.streamRequests]).toEqual([])
    expect(cloud.requests).toEqual([])
  }, 60_000)

  it.each([
    ['no live daemon', async () => {}],
    ['a live daemon that does not hold it', async () => { await fakeDaemon('store_a', ['local-someotherfolder']) }],
  ])('%s: exits non-zero naming Margins Light, never the login', async (_name, setup) => {
    const cloud = await fakeCloud()
    await setup()

    const wait = await cli(['discuss', 'wait', '--workspace', LOCAL_WS, '--session', 'sess-a'], cloud.url)
    expect(wait.status).toBe(1)
    expect(wait.stderr).toMatch(/Margins Light/)
    expect(wait.stderr).toMatch(/margins open/)
    expect(wait.stderr).not.toMatch(LOGIN)
    expect(cloud.requests).toEqual([])
  }, 60_000)

  it('an explicit --server-url at a daemon is used as is: no other daemon is asked', async () => {
    const cloud = await fakeCloud()
    const named = await fakeDaemon('store_a', [LOCAL_WS])
    const other = await fakeDaemon('store_b', [LOCAL_WS])

    const wait = await cli(['--server-url', named.url, 'discuss', 'wait', '--workspace', LOCAL_WS, '--session', 'sess-a'], cloud.url)
    expect(wait.status).toBe(0)
    expect(named.streamRequests).toHaveLength(1)
    expect(other.requests).toEqual([])
    expect(cloud.requests).toEqual([])
  }, 60_000)

  it('a non-local id takes the cloud path, even with a live daemon: the login mints on the cloud', async () => {
    const cloud = await fakeCloud(CLOUD_WS)
    const daemon = await fakeDaemon('store_a', [CLOUD_WS, LOCAL_WS])

    const wait = await cli(['discuss', 'wait', '--workspace', CLOUD_WS, '--session', 'sess-a'], cloud.url, API_KEY)
    expect(wait.status).toBe(0)
    expect(cloud.requests.filter((r) => r.method === 'POST').map((r) => [r.path, r.authorization, r.marginsToken]))
      .toEqual([['/api/keys', `Bearer ${API_KEY}`, undefined]])
    expect(daemon.requests).toEqual([])
  }, 60_000)

  it('a non-local id with no login is still refused before any request, even with a live daemon', async () => {
    const cloud = await fakeCloud(CLOUD_WS)
    const daemon = await fakeDaemon('store_a', [CLOUD_WS])

    const wait = await cli(['discuss', 'wait', '--workspace', CLOUD_WS], cloud.url)
    expect(wait.status).toBe(1)
    expect(wait.stderr).toMatch(LOGIN)
    expect([...cloud.requests, ...daemon.requests]).toEqual([])
  }, 60_000)
})

describe('liveDaemons: the capability token goes to a loopback URL a live record names', () => {
  it('names each live daemon at 127.0.0.1 on its port, and skips a record whose port is not a port', async () => {
    const home = path.join(tmp, 'home')
    process.env['MARGINS_HOME'] = home
    try {
      publishDaemon('store_a', 45678, 'tok_a')
      publishDaemon('store_b', '80@example.invalid', 'tok_b')
      publishDaemon('store_c', 70000, 'tok_c')
      const { liveDaemons } = await import('../src/lib/runtime.js')

      expect(liveDaemons()).toEqual([{ url: 'http://127.0.0.1:45678', port: 45678, token: 'tok_a' }])
    } finally {
      delete process.env['MARGINS_HOME']
    }
  })
})
