/**
 * The linked session's half of the agent channel (#27): the agent key minted on the
 * first `wait`, the five actions on a claimed send with their outbox, and the link
 * that takes the old `channel.mjs` channel out of the MCP config. All against the
 * contract fake, whose actions are judged by the protocol's reference model.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { _resetStore } from '../../src/lib/config.js'
import { sendPayload, startFakeAgentServer, type FakeAgentServer } from '../helpers/fake-agent-server.js'

const WS = 'ws_test_1'
const LOGIN = 'access_synthetic_login'

let configDir: string
let projectDir: string
let server: FakeAgentServer | undefined
let logs: string[]
let errs: string[]

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-agent-'))
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-agent-project-'))
  vi.stubEnv('MARGINS_CONFIG_DIR', configDir)
  vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
  _resetStore()
  logs = []
  errs = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')) })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { errs.push(String(chunk)); return true })
})

afterEach(async () => {
  await server?.close()
  server = undefined
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  fs.rmSync(configDir, { recursive: true, force: true })
  fs.rmSync(projectDir, { recursive: true, force: true })
})

const cfg = (serverUrl: string, json = false) => ({
  apiKey: LOGIN, serverUrl, json, verbose: false, noColor: false,
})

const noSleep = { sleep: async () => { await new Promise((r) => setImmediate(r)) } }

async function waitFor(sendId = 'snd_1', attempt = 1, session = 'sess-a') {
  const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')
  await handleDiscussWait(cfg(server!.url), { workspace: WS, session }, noSleep)
  return { sendId, attempt }
}

function allFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? allFilesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)])
}

describe('discuss wait: the agent key', () => {
  it('first wait mints the Workspace-scoped agent key through the login and streams with it', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }) }] })

    await waitFor()

    const mint = server.requests.find((r) => r.method === 'POST' && r.path === '/api/keys')
    expect(mint?.authorization).toBe(`Bearer ${LOGIN}`)
    expect(mint?.body).toMatchObject({ agent: { workspaceId: WS } })
    expect(server.minted).toHaveLength(1)
    const stream = server.requests.find((r) => r.method === 'GET')
    expect(stream?.authorization).toBe(`Bearer ${server.minted[0]!.key}`)
  })

  it('stores the key in the CLI credential store, owner-only, and never in SQLite', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }) }] })

    await waitFor()

    const key = server.minted[0]!.key
    const holders = allFilesUnder(configDir).filter((f) => fs.readFileSync(f).includes(key))
    expect(holders.map((f) => path.basename(f))).toEqual(['agent-keys.json'])
    expect(fs.statSync(holders[0]!).mode & 0o077).toBe(0)
    expect(fs.readFileSync(path.join(configDir, 'agent-channel.sqlite')).includes(key)).toBe(false)
  })

  it('a later wait reuses the stored key instead of minting another', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }) }] })

    await waitFor()
    await waitFor()

    expect(server.minted).toHaveLength(1)
    const streams = server.requests.filter((r) => r.method === 'GET')
    expect(streams.map((r) => r.authorization)).toEqual([`Bearer ${server.minted[0]!.key}`, `Bearer ${server.minted[0]!.key}`])
  })

  it('a revoked key is minted again once, and the wait goes on', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }) }] })
    await waitFor()
    server.revoke(server.minted[0]!.key)

    await waitFor()

    expect(server.minted).toHaveLength(2)
    expect(server.requests.filter((r) => r.method === 'GET').at(-1)?.authorization).toBe(`Bearer ${server.minted[1]!.key}`)
  })

  it('an API key as the login cannot mint: the error names `margins auth login`', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }) }] })
    await waitFor()
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')
    // Another Workspace, with the earlier agent key as the "login": the server refuses it.
    const err = await handleDiscussWait(
      { ...cfg(server.url), apiKey: server.minted[0]!.key }, { workspace: 'ws_other', session: 'sess-a' }, noSleep,
    ).catch((e: unknown) => e)

    expect((err as { userMessage?: string }).userMessage).toMatch(/margins auth login/)
  })
})

async function act(
  action: 'reply' | 'propose' | 'progress' | 'resolve' | 'done',
  opts: Record<string, unknown>,
  deps = noSleep,
) {
  const { handleAgentAction } = await import('../../src/commands/discuss/agent-action.js')
  return handleAgentAction(cfg(server!.url), action, { send: 'snd_1', attempt: '1', ...opts }, deps)
}

async function outbox() {
  const { openAgentChannelStore } = await import('../../src/lib/agent-channel/store.js')
  const store = await openAgentChannelStore()
  try {
    return store.outbox()
  } finally {
    store.close()
  }
}

describe('discuss reply | propose | progress | resolve | done on a claimed send', () => {
  beforeEach(async () => {
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }) }] })
    await waitFor()
  })

  it('reply sends the attempt, an idempotency key and the text with the agent key, and lands once', async () => {
    await act('reply', { body: 'Ten minutes covers one long tool call.' })

    const req = server!.requests.find((r) => r.method === 'POST' && r.path.endsWith('/reply'))!
    expect(req.path).toBe(`/api/workspaces/${WS}/agent-channel/sends/snd_1/reply`)
    expect(req.authorization).toBe(`Bearer ${server!.minted[0]!.key}`)
    expect(req.idempotencyKey).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/)
    expect(req.body).toEqual({ attempt: 1, text: 'Ten minutes covers one long tool call.' })
    expect(server!.accepted.map((a) => a.action)).toEqual(['reply'])
    expect(logs.join('\n')).toMatch(/disc_created_1/)
    expect(await outbox()).toEqual([])
  })

  it('propose lands a Proposal the server accepts: a text anchor with its context', async () => {
    await act('propose', {
      anchorText: 'is 10 minutes', anchorPrefix: 'The lease ', anchorSuffix: '.',
      replacement: 'is 15 minutes', body: 'Covers slow tools.',
    })

    const req = server!.requests.find((r) => r.method === 'POST' && r.path.endsWith('/propose'))!
    expect(req.body).toEqual({
      attempt: 1,
      text: 'Covers slow tools.',
      proposal: {
        body: 'Covers slow tools.',
        anchorType: 'text',
        anchorSelectedText: 'is 10 minutes',
        anchorPrefix: 'The lease ',
        anchorSuffix: '.',
        replacementBody: 'is 15 minutes',
      },
    })
    expect(server!.accepted.map((a) => a.action)).toEqual(['propose'])
  })

  it('propose on a passage at the end of the document sends its empty suffix as an empty string', async () => {
    await act('propose', {
      anchorText: 'is 10 minutes.', anchorPrefix: 'The lease ', anchorSuffix: '',
      replacement: 'is 15 minutes.',
    })

    const req = server!.requests.find((r) => r.method === 'POST' && r.path.endsWith('/propose'))!
    expect(req.body).toEqual({
      attempt: 1,
      proposal: {
        body: '',
        anchorType: 'text',
        anchorSelectedText: 'is 10 minutes.',
        anchorPrefix: 'The lease ',
        anchorSuffix: '',
        replacementBody: 'is 15 minutes.',
      },
    })
    expect(server!.accepted.map((a) => a.action)).toEqual(['propose'])
  })

  it('propose on a passage at the start of the document sends its empty prefix as an empty string', async () => {
    await act('propose', {
      anchorText: 'The lease', anchorPrefix: '', anchorSuffix: ' is 10 minutes.',
      replacement: 'The claim',
    })

    const req = server!.requests.find((r) => r.method === 'POST' && r.path.endsWith('/propose'))!
    expect((req.body as { proposal: Record<string, unknown> }).proposal).toMatchObject({ anchorPrefix: '', anchorSuffix: ' is 10 minutes.' })
    expect(server!.accepted.map((a) => a.action)).toEqual(['propose'])
  })

  it('propose with an empty passage is refused before anything is sent', async () => {
    const err = await act('propose', { anchorText: '', anchorPrefix: 'The lease ', anchorSuffix: '', replacement: 'x' })
      .catch((e: unknown) => e)

    expect((err as { userMessage?: string }).userMessage).toMatch(/--anchor-text/)
    expect(server!.requests.filter((r) => r.path.endsWith('/propose'))).toEqual([])
  })

  it('propose without the passage\'s context is refused before anything is sent', async () => {
    const err = await act('propose', { anchorText: 'is 10 minutes', replacement: 'is 15 minutes' }).catch((e: unknown) => e)

    expect((err as { userMessage?: string }).userMessage).toMatch(/--anchor-prefix/)
    expect(server!.requests.filter((r) => r.path.endsWith('/propose'))).toEqual([])
    expect(await outbox()).toEqual([])
  })

  it('progress, then done, answers the send', async () => {
    await act('progress', { text: 'reading GLOSSARY.md' })
    await act('done', { note: 'Answered in the thread.' })

    expect(server!.accepted.map((a) => [a.action, a.body['text']])).toEqual([
      ['progress', 'reading GLOSSARY.md'],
      ['done', 'Answered in the thread.'],
    ])
    expect(server!.sends.get('snd_1')!.state).toBe('answered')
  })

  it('resolve closes the sent thread and the send', async () => {
    await act('resolve', { summary: 'Settled: 10 minutes.' })

    expect(server!.accepted.map((a) => [a.action, a.body['text']])).toEqual([['resolve', 'Settled: 10 minutes.']])
    expect(server!.sends.get('snd_1')!.state).toBe('answered')
  })

  it('after a lost response the outbox resends with the same key, and the reply lands once', async () => {
    server!.loseResponses(1)

    await act('reply', { body: 'Once only.' })

    const posts = server!.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/reply'))
    expect(posts).toHaveLength(2)
    expect(posts[1]!.idempotencyKey).toBe(posts[0]!.idempotencyKey)
    expect(server!.accepted).toHaveLength(1)
    expect(logs.join('\n')).toMatch(/disc_created_1/)
    expect(await outbox()).toEqual([])
  })

  it('a command that ran out of resends keeps its outbox entry; running it again resends the same key', async () => {
    server!.loseResponses(100)
    const err = await act('reply', { body: 'Once only.' }).catch((e: unknown) => e)
    expect((err as { userMessage?: string }).userMessage).toMatch(/outbox/)
    expect(await outbox()).toHaveLength(1)
    const lostKey = server!.requests.find((r) => r.method === 'POST' && r.path.endsWith('/reply'))!.idempotencyKey

    server!.loseResponses(0)
    await act('reply', { body: 'Once only.' })

    const posts = server!.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/reply'))
    expect(new Set(posts.map((p) => p.idempotencyKey))).toEqual(new Set([lostKey]))
    expect(server!.accepted).toHaveLength(1)
    expect(await outbox()).toEqual([])
  })

  it('the outbox stores no credential', async () => {
    server!.loseResponses(100)
    await act('reply', { body: 'Once only.' }).catch(() => undefined)

    expect(await outbox()).toHaveLength(1)
    expect(fs.readFileSync(path.join(configDir, 'agent-channel.sqlite')).includes(server!.minted[0]!.key)).toBe(false)
  })

  it('a send a person resolved: the action stops with AGENT_SEND_CLOSED and the outbox drops the send', async () => {
    server!.loseResponses(100)
    await act('progress', { text: 'thinking' }).catch(() => undefined)
    server!.loseResponses(0)
    server!.resolveThread('snd_1')

    const err = await act('reply', { body: 'Too late.' }).catch((e: unknown) => e)

    expect((err as { userMessage?: string }).userMessage).toMatch(/AGENT_SEND_CLOSED/)
    expect(await outbox()).toEqual([])
  })

  it('a superseded attempt stops with AGENT_SEND_ATTEMPT_SUPERSEDED', async () => {
    const err = await act('reply', { body: 'Old claim.', attempt: '7' }).catch((e: unknown) => e)

    expect((err as { userMessage?: string }).userMessage).toMatch(/AGENT_SEND_ATTEMPT_SUPERSEDED/)
    expect(server!.accepted).toEqual([])
  })

  it('a revoked agent key is minted again once, and the action keeps its idempotency key', async () => {
    server!.revoke(server!.minted[0]!.key)

    await act('reply', { body: 'After rotation.' })

    const posts = server!.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/reply'))
    expect(posts.map((p) => p.authorization)).toEqual([`Bearer ${server!.minted[0]!.key}`, `Bearer ${server!.minted[1]!.key}`])
    expect(posts[1]!.idempotencyKey).toBe(posts[0]!.idempotencyKey)
    expect(server!.accepted).toHaveLength(1)
  })
})

describe('discuss wait: linking turns the channel.mjs channel off', () => {
  const marginsHttp = { type: 'http', url: 'http://127.0.0.1:4000/api/mcp', headers: { Authorization: 'Bearer synthetic' } }
  const channel = {
    type: 'stdio',
    command: 'node',
    args: ['/opt/margins-runtime/scripts/channel.mjs'],
    env: { MARGINS_DAEMON_URL: 'http://127.0.0.1:4000', MARGINS_LOCAL_TOKEN: 'synthetic', MARGINS_WORKSPACE_ID: WS },
  }
  const other = { type: 'stdio', command: 'npx', args: ['some-other-server'] }

  function writeMcp(dir: string, servers: Record<string, unknown>) {
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2) + '\n')
  }
  const readMcp = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }

  beforeEach(async () => {
    // The project is a git repository: the link edits only a config inside one.
    fs.mkdirSync(path.join(projectDir, '.git'))
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }) }] })
  })

  it('never edits a .mcp.json when the session is in no git repository', async () => {
    fs.rmSync(path.join(projectDir, '.git'), { recursive: true })
    writeMcp(projectDir, { margins_channel: channel, other })
    const before = fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8')

    await waitFor()

    expect(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8')).toBe(before)
  })

  it('keeps a server that runs some other channel.mjs', async () => {
    const bridge = { type: 'stdio', command: 'node', args: ['./tools/channel.mjs'] }
    writeMcp(projectDir, { bridge, margins_channel: channel })

    await waitFor()

    expect(readMcp(projectDir).mcpServers).toEqual({ bridge })
  })

  it('leaves the channel on when the link fails before the stream is admitted', async () => {
    await server!.close()
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'status', status: 403, code: 'FORBIDDEN' }] })
    writeMcp(projectDir, { margins_channel: channel, other })
    const before = fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8')

    const err = await waitFor().catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8')).toBe(before)
  })

  it('removes the channel.mjs server from the project MCP config and keeps every other server', async () => {
    writeMcp(projectDir, { margins: marginsHttp, margins_channel: channel, other })

    await waitFor()

    expect(readMcp(projectDir).mcpServers).toEqual({ margins: marginsHttp, other })
    expect(errs.join('')).toMatch(/margins_channel/)
    expect(errs.join('')).toContain(path.join(projectDir, '.mcp.json'))
  })

  it('removes it under any name, from the nearest .mcp.json above the session directory', async () => {
    const sub = path.join(projectDir, 'docs', 'specs')
    fs.mkdirSync(sub, { recursive: true })
    vi.mocked(process.cwd).mockReturnValue(sub)
    writeMcp(projectDir, { review_channel: channel, other })

    await waitFor()

    expect(readMcp(projectDir).mcpServers).toEqual({ other })
  })

  it('never edits a .mcp.json above the session\'s git repository', async () => {
    const repo = path.join(projectDir, 'repo')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    vi.mocked(process.cwd).mockReturnValue(repo)
    writeMcp(projectDir, { margins_channel: channel, other })
    const before = fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8')

    await waitFor()

    expect(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8')).toBe(before)
  })

  it('leaves a config without the channel byte-for-byte alone, and creates none', async () => {
    writeMcp(projectDir, { margins: marginsHttp, other })
    const before = fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8')

    await waitFor()

    expect(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8')).toBe(before)
    fs.rmSync(path.join(projectDir, '.mcp.json'))
    await waitFor()
    expect(fs.existsSync(path.join(projectDir, '.mcp.json'))).toBe(false)
  })
})

describe('agent actions: review fixes', () => {
  it('a superseded attempt drops only its own and older outbox entries, never a newer attempt\'s', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS, attempt: 2 }) }] })
    await waitFor('snd_1', 2)
    const { openAgentChannelStore } = await import('../../src/lib/agent-channel/store.js')
    const store = await openAgentChannelStore()
    // Attempt 2's reply went out and its answer was lost: it waits in the outbox for a resend.
    store.queueAction({ idempotencyKey: 'reply-attempt-2', sendId: 'snd_1', workspaceId: WS, action: 'reply', attempt: 2, body: '{"attempt":2,"text":"x"}' })
    store.close()

    const err = await act('reply', { body: 'Old claim.', attempt: '1' }).catch((e: unknown) => e)

    expect((err as { userMessage?: string }).userMessage).toMatch(/AGENT_SEND_ATTEMPT_SUPERSEDED/)
    expect((await outbox()).map((e) => e.idempotencyKey)).toEqual(['reply-attempt-2'])
  })

  it('a send id with a path in it never reaches another route', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }) }] })
    await waitFor()

    await act('reply', { body: 'x', send: '../../../../keys', workspace: WS }).catch(() => undefined)

    const posts = server.requests.filter((r) => r.method === 'POST')
    expect(posts.map((r) => r.path)).toEqual(['/api/keys'])
  })

  it('a success answer without the send, attempt and state is not taken: the action stays in the outbox', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }) }] })
    await waitFor()
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/reply')) return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      return realFetch(input, init)
    })

    const err = await act('reply', { body: 'x' }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect(logs.join('\n')).not.toMatch(/accepted on send/)
    expect(await outbox()).toHaveLength(1)
  })

  it('a key minted in this run and revoked during the wait is minted again once, and the wait goes on', async () => {
    server = await startFakeAgentServer({
      workspaceId: WS,
      script: [{ kind: 'drop' }, { kind: 'deliver', payload: sendPayload({ workspaceId: WS }) }],
    })
    const s = server
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')
    const sleep = async () => { s.revoke(s.minted[0]!.key); await new Promise((r) => setImmediate(r)) }

    await handleDiscussWait(cfg(s.url), { workspace: WS, session: 'sess-a' }, { sleep })

    expect(s.minted).toHaveLength(2)
    expect(logs.join('\n')).toContain('send snd_1, attempt 1')
  })
})

describe('agent actions and wait: fix-diff review', () => {
  it('a wrong, higher --attempt drops no entry of the attempt that holds the send', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }) }] })
    await waitFor()
    server.loseResponses(100)
    await act('progress', { text: 'thinking' }).catch(() => undefined)
    server.loseResponses(0)

    const err = await act('reply', { body: 'x', attempt: '99' }).catch((e: unknown) => e)

    expect((err as { userMessage?: string }).userMessage).toMatch(/AGENT_SEND_ATTEMPT_SUPERSEDED/)
    expect((await outbox()).map((e) => [e.action, e.attempt])).toEqual([['progress', 1]])
  })

  it.each(['..', '.', 'snd 1', 'a/b'])('refuses the send id %j before anything is sent', async (send) => {
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }) }] })
    await waitFor()

    const err = await act('reply', { body: 'x', send, workspace: WS }).catch((e: unknown) => e)

    expect((err as { userMessage?: string }).userMessage).toMatch(/--send/)
    expect(server.requests.filter((r) => r.path.endsWith('/reply'))).toEqual([])
  })

  it('wait refuses a Workspace id that is not a plain id before anything is sent', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }) }] })
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')

    const err = await handleDiscussWait(cfg(server.url), { workspace: '..', session: 'sess-a' }, noSleep).catch((e: unknown) => e)

    expect((err as { userMessage?: string }).userMessage).toMatch(/--workspace/)
    expect(server.requests).toEqual([])
  })
})
