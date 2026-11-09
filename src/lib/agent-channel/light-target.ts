/**
 * light-target.ts — which Margins Light daemon a `local-` Workspace lives on (#67).
 *
 * The reader's "Link a session" line prints `margins discuss wait --workspace local-<id>`,
 * with no server: the daemon's port changes at every restart. A `local-` id is
 * `sha256(source_root)`, so it does not say which store holds it, and the desktop app's
 * daemon and the one `margins open` started can be live at the same time. So the CLI asks
 * each live daemon, on its capability token, with the agent key mint itself
 * (`POST /api/local/agent-keys`, the one Light route that answers "do you hold it": a daemon
 * that does not answers 403 `NOT_A_MEMBER`), and uses the one that holds the Workspace for
 * the whole command: the auth gate, the mint, the stream and every agent action.
 *
 * When only one daemon is live and this CLI holds an agent key for it, that daemon is
 * used without a mint, so an agent action (one process each) does not mint a key per call;
 * a stale key there is minted again on it by `withAgentKey`. With two live daemons every
 * one is asked: a stored key names a URL, and a port can pass to another store's daemon at
 * a restart, so it proves nothing about which daemon holds the Workspace now. A holder
 * keeps the key its probe minted, also when two hold it and the command fails.
 *
 * An explicit `--server-url`, or a configured one, that is a live daemon is never
 * overridden: the caller only asks when `liveDaemonAt(cfg.serverUrl)` is null.
 */
import type { ResolvedConfig } from '../config.js'
import { MarginsError } from '../errors.js'
import { liveDaemons } from '../runtime.js'
import { AgentKeyMintRefused, mintAgentKey, readAgentKey } from './agent-key.js'
import { openAgentChannelStore } from './store.js'

/** The Workspace ids Margins Light issues: `local-` and the hash of the source folder. */
export function isLocalWorkspaceId(workspaceId: string): boolean {
  return workspaceId.startsWith('local-')
}

/**
 * The Workspace an agent-channel command acts in: its `--workspace`, else the one the held
 * send recorded (the action lines `wait` prints carry `--send` and no `--workspace`). An
 * unreadable store names none: the action itself reports that.
 */
export async function agentWorkspaceOf(opts: Record<string, unknown>): Promise<string | undefined> {
  if (typeof opts['workspace'] === 'string') return opts['workspace']
  if (typeof opts['send'] !== 'string') return undefined
  try {
    const store = await openAgentChannelStore()
    try {
      return store.heldSends().find((h) => h.sendId === opts['send'])?.workspaceId
    } finally {
      store.close()
    }
  } catch {
    return undefined
  }
}

/** No live Light daemon holds the Workspace: Margins Light is not open on its folder. */
export class LightWorkspaceNotOpen extends MarginsError {
  constructor(workspaceId: string, notes: string[]) {
    const why = notes.length ? ` (${notes.join('; ')})` : ''
    super(
      `No live Margins Light daemon holds Workspace ${workspaceId}`,
      `No running Margins Light holds Workspace ${workspaceId}${why}. Open Margins Light on that folder (the desktop app, or \`margins open\` in it), then run the command again.`,
      1,
    )
  }
}

/** Two live daemons hold the Workspace: the CLI does not pick one. */
export class LightWorkspaceAmbiguous extends MarginsError {
  constructor(workspaceId: string, ports: number[]) {
    const list = ports.join(' and ')
    super(
      `Margins Light daemons on ports ${list} both hold Workspace ${workspaceId}`,
      `Margins Light daemons on ports ${list} both hold Workspace ${workspaceId}. Name the one to use: \`margins --server-url http://127.0.0.1:<port> …\`.`,
      1,
    )
  }
}

/** Ask one daemon with the mint (which stores the key) whether it holds the Workspace, and why not when it is not a plain no. */
async function holds(cfg: ResolvedConfig, workspaceId: string): Promise<{ holds: true } | { holds: false; note?: string }> {
  try {
    await mintAgentKey(cfg, workspaceId)
    return { holds: true }
  } catch (err) {
    // NOT_A_MEMBER is the plain "another store holds it" answer: nothing to report.
    if (err instanceof AgentKeyMintRefused && err.reason === 'NOT_A_MEMBER') return { holds: false }
    return { holds: false, note: `${cfg.serverUrl}: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * `cfg` with `serverUrl` set to the live Light daemon that holds `workspaceId`. A holder's
 * fresh agent key is stored on the way (the probe is the mint), so the command does not
 * mint again.
 */
export async function resolveLightServer(cfg: ResolvedConfig, workspaceId: string): Promise<ResolvedConfig> {
  const daemons = liveDaemons().map((d) => ({ ...d, cfg: { ...cfg, serverUrl: d.url } }))

  const only = daemons.length === 1 ? daemons[0]! : undefined
  if (only && readAgentKey(only.url, workspaceId)) return only.cfg

  const answers = await Promise.all(daemons.map(async (d) => ({ d, answer: await holds(d.cfg, workspaceId) })))
  const holders = answers.filter((a) => a.answer.holds).map((a) => a.d)
  if (holders.length === 1) return holders[0]!.cfg
  if (holders.length > 1) throw new LightWorkspaceAmbiguous(workspaceId, holders.map((d) => d.port))
  const notes = answers.flatMap((a) => (!a.answer.holds && a.answer.note ? [a.answer.note] : []))
  throw new LightWorkspaceNotOpen(workspaceId, notes)
}
