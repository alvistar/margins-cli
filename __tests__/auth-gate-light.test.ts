/**
 * #40: the preAction auth gate, Margins Light vs the cloud, with NO credential.
 *
 * A person who only uses Margins Light (the desktop app or `margins open`) has no login
 * and no API key. The agent channel against a live Light daemon does not need either: the
 * agent key is minted on the daemon's capability token (#39). `stop` talks to no server at
 * all. The gate used to refuse all of them before the handler ran.
 *
 * Only a real process proves what the gate does (it calls `process.exit`), so this drives
 * the CLI from source. The child is spawned ASYNC: the fake server answers from this
 * process's event loop, which `spawnSync` would block.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendPayload, startFakeAgentServer, type FakeAgentServer } from './helpers/fake-agent-server.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const WS = 'ws_light_gate'
const LOCAL_TOKEN = 'local_capability_token_synthetic'

let tmp: string
let server: FakeAgentServer | undefined

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-gate-'))
})
afterEach(async () => {
  await server?.close()
  server = undefined
  fs.rmSync(tmp, { recursive: true, force: true })
})

interface Run { status: number | null; stdout: string; stderr: string }

function cli(args: string[], serverUrl: string): Promise<Run> {
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
          // No credential of any kind: an empty config dir, no API key, no OIDC.
          MARGINS_CONFIG_DIR: path.join(tmp, 'config'),
          MARGINS_DATA_DIR: path.join(tmp, 'data'),
          MARGINS_HOME: path.join(tmp, 'home'),
          MARGINS_PGLITE: path.join(tmp, 'home', 'store'),
          MARGINS_API_KEY: '',
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

/** The record a running Light daemon publishes (margins/scripts/lib/daemon.mjs). */
function publishDaemon(port: number): void {
  const dir = path.join(tmp, 'home', 'daemons')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '0123456789abcdef.json'), JSON.stringify({
    v: 2, marker: 'margins-daemon', store: '/synthetic/store', pid: process.pid,
    startedAt: Date.now(), port, token: LOCAL_TOKEN, ready: true,
  }), { mode: 0o600 })
}

const REFUSED = /not authenticated|margins auth login|api key/i

describe('auth gate with no credential (#40)', () => {
  it('a Light target: `discuss wait` claims a send, `reply --send` and `done` answer it', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, light: { token: LOCAL_TOKEN }, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }) }] })
    publishDaemon(Number(new URL(server.url).port))

    const wait = await cli(['discuss', 'wait', '--workspace', WS, '--session', 'sess-a'], server.url)
    expect(wait.stderr).not.toMatch(REFUSED)
    expect(wait.status).toBe(0)
    expect(wait.stdout).toContain('snd_1')

    // `reply` is gated as an agent action only with --send: the branch the gate reads from its options.
    const reply = await cli(['discuss', 'reply', '--send', 'snd_1', '--attempt', '1', '--body', 'On it.'], server.url)
    expect(reply.stderr).not.toMatch(REFUSED)
    expect(reply.status).toBe(0)

    const done = await cli(['discuss', 'done', '--send', 'snd_1', '--attempt', '1'], server.url)
    expect(done.stderr).not.toMatch(REFUSED)
    expect(done.status).toBe(0)
    expect(server.accepted.map((a) => a.action)).toEqual(['reply', 'done'])
  }, 60_000)

  it('`stop` runs: it talks to no server', async () => {
    const r = await cli(['stop'], 'http://127.0.0.1:1')
    expect(r.stderr).not.toMatch(REFUSED)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('No running Margins Light daemon.')
  }, 60_000)

  it('a cloud target (no live daemon on the port) is still refused before any request', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }) }] })

    const wait = await cli(['discuss', 'wait', '--workspace', WS], server.url)
    expect(wait.status).toBe(1)
    expect(wait.stderr).toMatch(REFUSED)

    const done = await cli(['discuss', 'done', '--send', 'snd_1', '--attempt', '1', '--workspace', WS], server.url)
    expect(done.status).toBe(1)
    expect(done.stderr).toMatch(REFUSED)

    expect(server.requests).toEqual([])
  }, 60_000)

  it('a Light target does not open the gate for commands outside the agent channel', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, light: { token: LOCAL_TOKEN }, script: [] })
    publishDaemon(Number(new URL(server.url).port))

    const list = await cli(['discuss', 'list', 'some-slug'], server.url)
    expect(list.status).toBe(1)
    expect(list.stderr).toMatch(REFUSED)
    expect(server.requests).toEqual([])
  }, 60_000)
})
