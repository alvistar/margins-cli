/**
 * agent-key.ts — the agent key a linked session acts with (PROTOCOL.md "The agent key",
 * D3; server alvistar/margins#293).
 *
 * One key per (server, Workspace): role `comment`, the agent actions only, an expiry
 * (30 days when the CLI names none). The first `wait` in a Workspace mints it, and every
 * agent-channel request after that sends it instead of the login. Where it is minted
 * depends on the server (#39):
 *
 * - the cloud: `POST /api/keys { agent: { workspaceId } }` through the person's existing
 *   login (human auth: a key never mints a key);
 * - a Margins Light daemon (a live discovery record names the server's loopback port):
 *   `POST /api/local/agent-keys { workspaceId }` with the daemon's capability token in
 *   `x-margins-token` and no `Authorization`, since Light has no `/api/keys` and refuses
 *   a mint that presents an API key.
 *
 * The key is a credential, so it lives in the CLI credential store beside
 * `config.json` (`agent-keys.json`, owner-only), never in the agent channel's SQLite
 * store, which holds machine state only (D11).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ResolvedConfig } from '../config.js'
import { getConfigDir } from '../config.js'
import { createApiClient, type ApiClient } from '../api-client.js'
import { AuthExpired, ForbiddenError, MarginsError, ResponseParseError } from '../errors.js'
import { liveDaemonAt, type LiveDaemon } from '../runtime.js'

const KEYS_BASENAME = 'agent-keys.json'
/** A key this close to its expiry is minted again rather than used. */
const EXPIRY_MARGIN_MS = 60 * 60 * 1000

export interface StoredAgentKey {
  id: string
  key: string
  workspaceId: string
  serverUrl: string
  /** ISO 8601. */
  expiresAt: string
}

type KeyFile = Record<string, StoredAgentKey>

export class AgentKeyMintRefused extends MarginsError {
  constructor(reason: string, light = false) {
    super(
      `Agent key mint refused: ${reason}`,
      light
        ? `The Margins Light daemon refused to mint the agent key (${reason}). It mints on its capability token: run \`margins stop\`, then \`margins open\` again, and check this Workspace is in Margins Light.`
        : `Margins refused to mint the agent key (${reason}). The agent key is minted through your login: run \`margins auth login\` (an API key cannot mint one), and check you can write in this Workspace.`,
      1,
    )
  }
}

/** A live Light daemon whose discovery record carries no capability token. */
export class LightDaemonTokenMissing extends MarginsError {
  constructor(port: number) {
    super(
      `Margins Light daemon on port ${port} has no capability token`,
      `The Margins Light daemon on port ${port} published no capability token, so it cannot mint the agent key. Run \`margins stop\`, then \`margins open\` again.`,
      1,
    )
  }
}

function keysPath(): string {
  return path.join(getConfigDir(), KEYS_BASENAME)
}

function slot(serverUrl: string, workspaceId: string): string {
  return `${serverUrl.replace(/\/$/, '')} ${workspaceId}`
}

function readKeyFile(): KeyFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(keysPath(), 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? parsed as KeyFile : {}
  } catch {
    return {}
  }
}

/** Write owner-only, through a temp file and a rename, so a reader never sees half a file. */
function writeKeyFile(file: KeyFile): void {
  const target = keysPath()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, target)
}

/** The stored key for this Workspace, when it is not about to expire. */
export function readAgentKey(serverUrl: string, workspaceId: string): StoredAgentKey | undefined {
  const stored = readKeyFile()[slot(serverUrl, workspaceId)]
  if (!stored || typeof stored.key !== 'string') return undefined
  if (Date.parse(stored.expiresAt) - Date.now() < EXPIRY_MARGIN_MS) return undefined
  return stored
}

/** Drop the stored key (the server answered 401 to it: revoked or expired). */
export function forgetAgentKey(serverUrl: string, workspaceId: string): void {
  const file = readKeyFile()
  const name = slot(serverUrl, workspaceId)
  if (!(name in file)) return
  delete file[name]
  writeKeyFile(file)
}

/** `POST /api/local/agent-keys` on the daemon's capability token, with no `Authorization`. */
function mintOnLight(cfg: ResolvedConfig, daemon: LiveDaemon, workspaceId: string, label: string): Promise<unknown> {
  if (!daemon.token) throw new LightDaemonTokenMissing(daemon.port)
  const client = createApiClient(cfg, { fixedBearer: null })
  return client.post('/api/local/agent-keys', { workspaceId, label }, { 'x-margins-token': daemon.token })
}

/**
 * Mint a new agent key and store it: on a Margins Light daemon through its capability
 * token, else through the login in `cfg`.
 */
export async function mintAgentKey(cfg: ResolvedConfig, workspaceId: string): Promise<StoredAgentKey> {
  const label = `margins-cli on ${os.hostname()}`
  const daemon = liveDaemonAt(cfg.serverUrl)
  let minted: unknown
  try {
    minted = daemon
      ? await mintOnLight(cfg, daemon, workspaceId, label)
      : await createApiClient(cfg).post('/api/keys', { agent: { workspaceId }, label })
  } catch (err) {
    if (err instanceof ForbiddenError) throw new AgentKeyMintRefused(err.code ?? 'forbidden', daemon !== null)
    throw err
  }
  const m = minted as Partial<StoredAgentKey> | null
  if (!m || typeof m.id !== 'string' || typeof m.key !== 'string' || typeof m.expiresAt !== 'string') {
    throw new ResponseParseError()
  }
  const stored: StoredAgentKey = { id: m.id, key: m.key, workspaceId, serverUrl: cfg.serverUrl, expiresAt: m.expiresAt }
  const file = readKeyFile()
  file[slot(cfg.serverUrl, workspaceId)] = stored
  writeKeyFile(file)
  return stored
}

/** An API client that sends the agent key and nothing else. */
function agentClient(cfg: ResolvedConfig, key: StoredAgentKey): ApiClient {
  return createApiClient(cfg, { fixedBearer: key.key })
}

/**
 * Run `use` with a client that sends the Workspace's agent key: the stored one, else
 * one minted now (`mintAgentKey`: the daemon's capability token on Margins Light, else
 * the login). A 401 to the key (revoked, or expired early; a
 * `wait` can hold one for hours) mints a new key once and runs `use` again; a second
 * 401 is the end.
 */
export async function withAgentKey<T>(
  cfg: ResolvedConfig,
  workspaceId: string,
  use: (client: ApiClient) => Promise<T>,
): Promise<T> {
  const key = readAgentKey(cfg.serverUrl, workspaceId) ?? await mintAgentKey(cfg, workspaceId)
  try {
    return await use(agentClient(cfg, key))
  } catch (err) {
    if (!(err instanceof AuthExpired)) throw err
    forgetAgentKey(cfg.serverUrl, workspaceId)
    return use(agentClient(cfg, await mintAgentKey(cfg, workspaceId)))
  }
}
