/**
 * Edit mode on a send (#62; server alvistar/margins#357, PROTOCOL.md "Mode, and the `edit`
 * action"): `margins discuss edit --file --format --base` sends the whole new text, writes
 * the merged text back on success, and on a 409 leaves the file and prints the current head
 * and text; the stream declares the `edit` capability so the server picks edit mode.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { _resetStore } from '../../src/lib/config.js'
import { AGENT_CAPABILITIES_HEADER, AGENT_CHANNEL_PATHS, sendModeOf } from '../../src/lib/agent-channel/protocol.js'
import { sendPayload, startFakeAgentServer, type FakeAgentServer, type FakeDocument } from '../helpers/fake-agent-server.js'

const WS = 'ws_test_1'
const LOGIN = 'access_synthetic_login'
const STASH_MD: FakeDocument = { kind: 'stash', format: 'markdown', text: '# Spec\n\nThe lease is 10 minutes.\n', head: 'sha_base' }

let configDir: string
let projectDir: string
let server: FakeAgentServer | undefined
let logs: string[]

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-edit-'))
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-edit-project-'))
  vi.stubEnv('MARGINS_CONFIG_DIR', configDir)
  vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
  _resetStore()
  logs = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')) })
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(async () => {
  await server?.close()
  server = undefined
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(configDir, { recursive: true, force: true })
  fs.rmSync(projectDir, { recursive: true, force: true })
})

const cfg = (serverUrl: string, json = false) => ({
  apiKey: LOGIN, serverUrl, json, verbose: false, noColor: false,
})

const noSleep = { sleep: async () => { await new Promise((r) => setImmediate(r)) } }

async function claimed(doc: FakeDocument = STASH_MD, opts: { mintActions?: Parameters<typeof startFakeAgentServer>[0]['mintActions'] } = {}) {
  server = await startFakeAgentServer({
    workspaceId: WS,
    mintActions: opts.mintActions,
    script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }), mode: { document: doc, baseSha: doc.head } }],
  })
  server.documents.set('snd_1', { ...doc })
  const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')
  await handleDiscussWait(cfg(server.url, true), { workspace: WS, session: 'sess-a' }, noSleep)
  const payload = JSON.parse(logs.at(-1)!) as { mode: string; prompt: string; document: { baseSha: string } }
  logs = []
  return payload
}

function writeDraft(text: string): string {
  const file = path.join(projectDir, 'draft.md')
  fs.writeFileSync(file, text)
  return file
}

async function edit(opts: { file: string; base: string; format?: string }, json = false) {
  const { handleAgentEdit } = await import('../../src/commands/discuss/edit.js')
  return handleAgentEdit(cfg(server!.url, json), { send: 'snd_1', attempt: '1', ...opts }, noSleep)
}

const editRequests = () => server!.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/edit'))

describe('discuss edit: the stream declares the edit capability', () => {
  it('wait sends Margins-Agent-Capabilities: edit, and the server picks edit mode with --base and --format', async () => {
    const payload = await claimed()

    expect(server!.streamRequests[0]?.capabilities).toBe('edit')
    expect(payload.mode).toBe('edit')
    expect(payload.prompt).toContain('margins discuss edit --send snd_1 --attempt 1 --base sha_base --format markdown --file <path>')
  })

  it('a client that declares nothing still gets Proposal mode', async () => {
    server = await startFakeAgentServer({
      workspaceId: WS,
      script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }), mode: { document: STASH_MD, baseSha: 'sha_base' } }],
    })
    // An older CLI: the same stream request with no capability header.
    const { mintAgentKey } = await import('../../src/lib/agent-channel/agent-key.js')
    const key = await mintAgentKey(cfg(server.url), WS)
    const res = await fetch(server.url + AGENT_CHANNEL_PATHS.stream(WS), { headers: { Authorization: `Bearer ${key.key}`, Accept: 'text/event-stream' } })
    const body = await res.text()

    expect(server.streamRequests[0]?.capabilities).toBeUndefined()
    expect(body).toContain('"mode":"suggest"')
    expect(body).toContain('You are in Proposal mode.')
    expect(sendModeOf({ document: STASH_MD, senderMayWrite: true, keyActions: ['edit'], clientCapabilities: [] })).toBe('suggest')
  })

  it('the header name is the protocol constant', () => {
    expect(AGENT_CAPABILITIES_HEADER).toBe('Margins-Agent-Capabilities')
  })

  it('a stored key minted by an older CLI is minted again once, so its actions include edit', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }), mode: { document: STASH_MD, baseSha: 'sha_base' } }] })
    // agent-keys.json as 0.24.x wrote it: no `actions`, so it may lack `edit`.
    const { mintAgentKey } = await import('../../src/lib/agent-channel/agent-key.js')
    await mintAgentKey(cfg(server.url), WS)
    const file = path.join(configDir, 'agent-keys.json')
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>
    for (const k of Object.values(stored)) delete k['actions']
    fs.writeFileSync(file, JSON.stringify(stored))

    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')
    await handleDiscussWait(cfg(server.url), { workspace: WS, session: 'sess-a' }, noSleep)
    await handleDiscussWait(cfg(server.url), { workspace: WS, session: 'sess-a' }, noSleep)

    expect(server.minted).toHaveLength(2)
    expect(server.streamRequests.map((r) => r.authorization)).toEqual([`Bearer ${server.minted[1]!.key}`, `Bearer ${server.minted[1]!.key}`])
  })

  it('an older key whose new mint fails is still used: the wait goes on, in Proposal mode', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }), mode: { document: STASH_MD, baseSha: 'sha_base' } }] })
    const { mintAgentKey } = await import('../../src/lib/agent-channel/agent-key.js')
    const old = await mintAgentKey(cfg(server.url), WS)
    const file = path.join(configDir, 'agent-keys.json')
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>
    for (const k of Object.values(stored)) delete k['actions']
    fs.writeFileSync(file, JSON.stringify(stored))

    // The "login" is an agent key: the server refuses the mint (KEY_CANNOT_MANAGE_KEYS).
    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')
    await handleDiscussWait({ ...cfg(server.url), apiKey: old.key }, { workspace: WS, session: 'sess-a' }, noSleep)

    expect(server.minted).toHaveLength(1)
    expect(server.streamRequests[0]?.authorization).toBe(`Bearer ${old.key}`)
  })

  it('a key whose recorded actions lack edit is not minted again: the send stays in Proposal mode', async () => {
    server = await startFakeAgentServer({ workspaceId: WS, mintActions: ['reply', 'propose', 'progress', 'resolve', 'done'], script: [{ kind: 'deliver', payload: sendPayload({ workspaceId: WS }), mode: { document: STASH_MD, baseSha: 'sha_base' } }] })
    const { mintAgentKey } = await import('../../src/lib/agent-channel/agent-key.js')
    await mintAgentKey(cfg(server.url), WS)

    const { handleDiscussWait } = await import('../../src/commands/discuss/wait.js')
    await handleDiscussWait(cfg(server.url, true), { workspace: WS, session: 'sess-a' }, noSleep)

    // Its actions are recorded and lack edit: no mint loop, and the server says Proposal mode.
    expect(server.minted).toHaveLength(1)
    expect((JSON.parse(logs.at(-1)!) as { mode: string }).mode).toBe('suggest')
  })
})

describe('discuss edit --file --format --base', () => {
  it('sends the whole file with the base sha and the format, and writes the stored text back', async () => {
    const payload = await claimed()
    const file = writeDraft('# Spec\n\nThe lease is 15 minutes.\n')

    await edit({ file, base: payload.document.baseSha, format: 'markdown' })

    expect(editRequests()[0]?.body).toEqual({ attempt: 1, content: '# Spec\n\nThe lease is 15 minutes.\n', baseSha: 'sha_base', format: 'markdown' })
    expect(fs.readFileSync(file, 'utf8')).toBe('# Spec\n\nThe lease is 15 minutes.\n')
    expect(server!.documents.get('snd_1')?.text).toBe('# Spec\n\nThe lease is 15 minutes.\n')
    expect(logs.join('\n')).toMatch(/head sha_edit_1/)
    expect(logs.join('\n')).toContain('http://margins.test/doc?changes=1..2')
  })

  it('a merge over a concurrent change writes the merged text back to the file before the new head is printed', async () => {
    await claimed({ ...STASH_MD, onStaleBase: (sent) => `${sent}\nA line someone else added.\n` })
    server!.documents.set('snd_1', { ...server!.documents.get('snd_1')!, head: 'sha_concurrent' })
    const file = writeDraft('# Spec\n\nThe lease is 15 minutes.\n')

    await edit({ file, base: 'sha_base', format: 'markdown' }, true)

    expect(fs.readFileSync(file, 'utf8')).toBe('# Spec\n\nThe lease is 15 minutes.\n\nA line someone else added.\n')
    const answer = JSON.parse(logs.at(-1)!) as { edit: { merged: boolean; head: string }; file: string }
    expect(answer.edit).toMatchObject({ merged: true, head: 'sha_edit_1' })
    expect(answer.file).toBe(file)
  })

  it('a 409 prints the current head and text, leaves the file unchanged, and a retry on that head succeeds', async () => {
    await claimed()
    server!.documents.set('snd_1', { ...STASH_MD, text: '# Spec\n\nThe lease is 12 minutes.\n', head: 'sha_now' })
    const file = writeDraft('# Spec\n\nThe lease is 15 minutes.\n')

    const err = await edit({ file, base: 'sha_base', format: 'markdown' }).catch((e: unknown) => e) as { userMessage?: string; exitCode?: number }

    expect(err.userMessage).toMatch(/SYNC_MERGE_CONFLICT/)
    expect(err.userMessage).toMatch(/--base sha_now/)
    expect(err.exitCode).toBe(1)
    expect(fs.readFileSync(file, 'utf8')).toBe('# Spec\n\nThe lease is 15 minutes.\n')
    const printed = logs.join('\n')
    expect(printed).toMatch(/head: sha_now/)
    expect(printed).toMatch(/<<<MARGINS-DATA [0-9a-f]{32} document\n# Spec\n\nThe lease is 12 minutes.\n\nMARGINS-DATA [0-9a-f]{32}>>>/)

    logs = []
    await edit({ file, base: 'sha_now', format: 'markdown' })
    expect(fs.readFileSync(file, 'utf8')).toBe('# Spec\n\nThe lease is 15 minutes.\n')
    expect(server!.documents.get('snd_1')).toMatchObject({ text: '# Spec\n\nThe lease is 15 minutes.\n', head: 'sha_edit_1' })
  })

  it('a 409 with --json prints the code, head, conflicts and current text as one object', async () => {
    await claimed()
    server!.documents.set('snd_1', { ...STASH_MD, text: 'now\n', head: 'sha_now' })
    const file = writeDraft('mine\n')

    await edit({ file, base: 'sha_base', format: 'markdown' }, true).catch(() => undefined)

    expect(JSON.parse(logs.at(-1)!)).toEqual({
      error: 'SYNC_MERGE_CONFLICT',
      message: expect.any(String),
      head: 'sha_now',
      conflicts: [{ path: 'doc.md', reason: 'content' }],
      text: 'now\n',
      file,
    })
  })

  it('passes --format html through on a Design', async () => {
    const design: FakeDocument = { kind: 'stash', format: 'html', text: '<html><body>a</body></html>', head: 'sha_base' }
    const payload = await claimed(design)
    expect(payload.prompt).toContain('--format html')
    const file = writeDraft('<html><body>b</body></html>')

    await edit({ file, base: 'sha_base', format: 'html' })

    expect(editRequests()[0]?.body).toMatchObject({ format: 'html', content: '<html><body>b</body></html>' })
    expect(server!.documents.get('snd_1')?.text).toBe('<html><body>b</body></html>')
  })

  it('refuses a missing or unknown --format before any request', async () => {
    await claimed()
    const file = writeDraft('x\n')

    await expect(edit({ file, base: 'sha_base' })).rejects.toThrow(/--format/)
    await expect(edit({ file, base: 'sha_base', format: 'md' })).rejects.toThrow(/--format must be markdown or html/)
    expect(editRequests()).toHaveLength(0)
  })

  it('refuses a missing file or a malformed --base before any request', async () => {
    await claimed()

    await expect(edit({ file: path.join(projectDir, 'nope.md'), base: 'sha_base', format: 'markdown' })).rejects.toThrow(/Cannot read --file/)
    await expect(edit({ file: writeDraft('x'), base: '../x', format: 'markdown' })).rejects.toThrow(/--base must be a plain id/)
    expect(editRequests()).toHaveLength(0)
  })

  it('a format the document does not hold is the server\'s refusal, and the file is unchanged', async () => {
    await claimed()
    const file = writeDraft('<p>x</p>')

    const err = await edit({ file, base: 'sha_base', format: 'html' }).catch((e: unknown) => e) as { userMessage?: string }

    expect(err.userMessage).toMatch(/markdown/)
    expect(fs.readFileSync(file, 'utf8')).toBe('<p>x</p>')
  })
})

describe('discuss edit on a Margins Light document', () => {
  it('the server offers no edit command: the prompt names the local file', async () => {
    const payload = await claimed({ kind: 'light', format: 'markdown', text: 'x', head: 'sha_base' })

    expect(payload.mode).toBe('edit')
    expect(payload.prompt).not.toContain('margins discuss edit')
    expect(payload.prompt).toMatch(/only that file/)
  })

  it('an edit call is refused with the server\'s sentence to edit the local file, and nothing is written', async () => {
    await claimed({ kind: 'light', format: 'markdown', text: 'x', head: 'sha_base' })
    const file = writeDraft('y')

    const err = await edit({ file, base: 'sha_base', format: 'markdown' }).catch((e: unknown) => e) as { userMessage?: string }

    expect(err.userMessage).toMatch(/AGENT_SEND_EDIT_NOT_ALLOWED/)
    expect(err.userMessage).toMatch(/On Margins Light the document is your local file: edit the local file the send named/)
    expect(fs.readFileSync(file, 'utf8')).toBe('y')
    expect(server!.documents.get('snd_1')?.text).toBe('x')
  })
})
