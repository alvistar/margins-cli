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
/** A `wait` that never ends must not outlive its test. */
let children: ReturnType<typeof spawn>[] = []

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-light-route-'))
})
afterEach(async () => {
  for (const c of children) c.kill()
  children = []
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
    children.push(child)
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

/** Resolve once `check` holds, polling; fail after `ms`. */
async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

const mintsOn = (s: FakeAgentServer) => s.requests.filter((r) => r.method === 'POST' && r.path === '/api/local/agent-keys')
const NOT_RUNNING = /Margins Light is not running for Workspace/g

describe('`wait` follows a Margins Light restart (#72)', () => {
  /** The holder's daemon on port A, holding the stream open until the test restarts it. */
  async function holdingDaemon(store: string): Promise<FakeAgentServer> {
    const token = `capability_token_${store}`
    const s = await startFakeAgentServer({ workspaceId: LOCAL_WS, light: { token, holds: [LOCAL_WS] }, script: [{ kind: 'hold' }] })
    servers.push(s)
    publishDaemon(store, portOf(s), token)
    return s
  }

  it('the record moves from port A to port B: `wait` reconnects to B and claims the send there, in the same process', async () => {
    const cloud = await fakeCloud()
    const a = await holdingDaemon('store_a')
    const wait = cli(['discuss', 'wait', '--workspace', LOCAL_WS, '--session', 'sess-a'], cloud.url)
    await until(() => a.streamRequests.length === 1)

    await a.stop()
    const b = await fakeDaemon('store_a', [LOCAL_WS])

    const run = await wait
    expect(run.stderr).not.toMatch(LOGIN)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('snd_1')
    expect(b.streamRequests).toHaveLength(1)
    expect(cloud.requests).toEqual([])
  }, 60_000)

  it('no live daemon holds it: `wait` keeps retrying, says once that Margins Light is not running, then claims on the next daemon', async () => {
    const cloud = await fakeCloud()
    const a = await holdingDaemon('store_a')
    const wait = cli(['discuss', 'wait', '--workspace', LOCAL_WS, '--session', 'sess-a'], cloud.url)
    await until(() => a.streamRequests.length === 1)

    await a.stop()
    fs.rmSync(path.join(tmp, 'home', 'daemons', 'store_a.json'))
    // A daemon that does not hold it: each attempt asks it, so its mints count the attempts.
    const other = await fakeDaemon('store_c', ['local-someotherfolder'])
    await until(() => mintsOn(other).length >= 2)
    const b = await fakeDaemon('store_a', [LOCAL_WS])

    const run = await wait
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('snd_1')
    expect(run.stderr.match(NOT_RUNNING)).toHaveLength(1)
    expect(b.streamRequests).toHaveLength(1)
  }, 60_000)

  it('another store\'s daemon takes the old port and refuses the key: no mint for this Workspace reaches it', async () => {
    const cloud = await fakeCloud()
    const a = await holdingDaemon('store_a')
    const wait = cli(['discuss', 'wait', '--workspace', LOCAL_WS, '--session', 'sess-a'], cloud.url)
    await until(() => a.streamRequests.length === 1)
    const mintsBefore = mintsOn(a).length

    await a.stop()
    const b = await fakeDaemon('store_a', [LOCAL_WS])
    // Store C's daemon now listens on port A, and the old key means nothing there.
    for (const k of a.minted) a.revoke(k.key)
    publishDaemon('store_c', portOf(a), 'capability_token_store_a')
    await a.start()

    const run = await wait
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('snd_1')
    expect(b.streamRequests).toHaveLength(1)
    expect(mintsOn(a)).toHaveLength(mintsBefore)
  }, 60_000)
})

describe('a --send-only action whose send the local store does not hold (#68)', () => {
  const action = ['discuss', 'done', '--send', 'snd_unknown_7', '--attempt', '1']

  it('a live daemon, no login, an empty store: fails naming the send, never the login', async () => {
    const cloud = await fakeCloud()
    const daemon = await fakeDaemon('store_a', [LOCAL_WS])

    const run = await cli(action, cloud.url)
    expect(run.status).not.toBe(0)
    expect(run.stderr).not.toMatch(LOGIN)
    expect(run.stderr).toContain('snd_unknown_7')
    expect(run.stderr).toContain('--workspace')
    expect([...cloud.requests, ...daemon.requests]).toEqual([])
  }, 60_000)

  it('with --workspace local-<id>: resolves the daemon that holds it, as before', async () => {
    const cloud = await fakeCloud()
    const daemon = await fakeDaemon('store_a', [LOCAL_WS])

    const run = await cli([...action, '--workspace', LOCAL_WS], cloud.url)
    expect(run.stderr).not.toMatch(LOGIN)
    expect(daemon.minted).toHaveLength(1)
    expect(cloud.requests).toEqual([])
  }, 60_000)

  it('no live daemon, no login: the cloud gate still says to log in', async () => {
    const cloud = await fakeCloud()

    const run = await cli(action, cloud.url)
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(LOGIN)
    expect(cloud.requests).toEqual([])
  }, 60_000)

  it('a logged-in user on a cloud Workspace: the action goes to the cloud, as before', async () => {
    const cloud = await fakeCloud(CLOUD_WS)
    const daemon = await fakeDaemon('store_a', [LOCAL_WS])

    const run = await cli([...action, '--workspace', CLOUD_WS], cloud.url, API_KEY)
    expect(cloud.requests.filter((r) => r.method === 'POST').map((r) => r.path)[0]).toBe('/api/keys')
    expect(daemon.requests).toEqual([])
    expect(run.stderr).not.toMatch(LOGIN)
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
