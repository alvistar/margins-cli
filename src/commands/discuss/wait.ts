import type { ResolvedConfig } from '../../lib/config.js'
import { formatJson } from '../../lib/output.js'
import { backoffMs, defaultSleep, StreamServerGone, waitForSend, type WaitForSendOptions } from '../../lib/agent-channel/wait.js'
import { openAgentChannelStore, SqliteUnavailableError, type AgentChannelStore } from '../../lib/agent-channel/store.js'
import { withAgentKey } from '../../lib/agent-channel/agent-key.js'
import { removeChannelServer } from '../../lib/agent-channel/mcp-config.js'
import { assertPlainId } from '../../lib/agent-channel/actions.js'
import {
  findLightServerAgain, isLocalWorkspaceId, isPickedLightServer, LightWorkspaceNotOpen,
} from '../../lib/agent-channel/light-target.js'
import type { SendEventPayload } from '../../lib/agent-channel/protocol.js'

/** Test seams: the backoff sleep, the jitter source, the silent-stream timeout. */
export type DiscussWaitDeps = Pick<WaitForSendOptions, 'sleep' | 'random' | 'idleTimeoutMs'>

/**
 * The local session this `wait` runs for: `--session`, else the Claude Code session
 * that launched it, else the parent process.
 */
function localSessionId(explicit: string | undefined): string {
  return explicit ?? process.env['CLAUDE_CODE_SESSION_ID'] ?? `ppid-${process.ppid}`
}

/**
 * The local store is bookkeeping: a locked store must never cost the session a send the
 * server has already claimed for it, so each write warns and goes on. A Node without
 * `node:sqlite` is different: no action could answer a send it claims (the outbox needs
 * the store), so the first write, before the stream, stops the wait instead.
 */
async function withStore(
  action: string,
  write: (store: AgentChannelStore) => void,
  { requireSqlite = false }: { requireSqlite?: boolean } = {},
): Promise<void> {
  let store: AgentChannelStore | undefined
  try {
    store = await openAgentChannelStore()
    write(store)
  } catch (err) {
    if (requireSqlite && err instanceof SqliteUnavailableError) throw err
    const reason = (err as { userMessage?: string }).userMessage ?? (err as Error).message
    process.stderr.write(`margins: local store: could not ${action}: ${reason}\n`)
  } finally {
    store?.close()
  }
}

/**
 * Linking turns the old `channel.mjs` channel off, so a comment without a send never
 * reaches this session (D18 #10). It runs once the stream is admitted, so a link that
 * fails (no key, wrong Workspace) leaves the old channel on. A config it cannot read is
 * left alone, with a warning.
 */
function turnChannelOff(): void {
  try {
    const removal = removeChannelServer(process.cwd())
    if (removal) {
      process.stderr.write(
        `margins: linked: removed ${removal.removed.join(', ')} (channel.mjs) from ${removal.file}; ` +
        'comments without a send no longer reach this session. Restart Claude Code if it is running with that channel.\n',
      )
    }
  } catch (err) {
    process.stderr.write(`margins: could not check the MCP config for the channel.mjs channel: ${(err as Error).message}\n`)
  }
}

/**
 * The wait on a `local-` Workspace whose daemon the CLI picked (#72). Margins Light takes a
 * new port at every start, so when the picked daemon is no longer at its URL (a dead port,
 * or another store's daemon there) the wait finds the daemon that holds the Workspace again
 * and goes on there, with that URL's agent key. While none does, it keeps trying with
 * backoff and says so once.
 */
async function waitFollowingLight(cfg: ResolvedConfig, workspaceId: string, deps: DiscussWaitDeps): Promise<SendEventPayload> {
  const sleep = deps.sleep ?? defaultSleep
  const random = deps.random ?? Math.random
  let target = cfg
  let linked = false
  const onAdmitted = () => {
    if (!linked) turnChannelOff()
    linked = true
  }
  for (;;) {
    // A daemon whose record names no store cannot be followed: the plain wait, as before.
    if (target.lightStore === undefined) {
      return withAgentKey(target, workspaceId, (client) => waitForSend({ client, workspaceId, ...deps, onAdmitted }))
    }
    const reachable = () => isPickedLightServer(target)
    try {
      return await withAgentKey(target, workspaceId, (client) =>
        waitForSend({ client, workspaceId, ...deps, onAdmitted, reachable }), { mayMint: reachable })
    } catch (err) {
      // Whatever the URL answered (a dead port, another store's 401, 403 or 404, a mint that
      // failed), it is not the picked daemon any more: find it again. Else the error stands.
      if (reachable()) throw err
      if (!(err instanceof StreamServerGone)) await sleep(backoffMs(1, random))
    }
    let failures = 0
    let said = false
    for (;;) {
      try {
        target = await findLightServerAgain(target, workspaceId)
        break
      } catch (err) {
        if (!(err instanceof LightWorkspaceNotOpen)) throw err
        if (!said) {
          process.stderr.write(`margins: Margins Light is not running for Workspace ${workspaceId}; waiting for it to open.\n`)
          said = true
        }
        await sleep(backoffMs(++failures, random))
      }
    }
  }
}

/**
 * `margins discuss wait --workspace <id>`: hold the agent stream, claim one send,
 * print its payload, return (exit 0). The harness that ran it in the background
 * wakes the session with the output. The local store records the link and which
 * session holds the send (machine state only, no secrets); the agent key lives in
 * the credential store (`agent-key.ts`).
 */
export async function handleDiscussWait(
  cfg: ResolvedConfig,
  opts: { workspace: string; session?: string },
  deps: DiscussWaitDeps = {},
): Promise<void> {
  assertPlainId(opts.workspace, '--workspace')
  const sessionId = localSessionId(opts.session)
  await withStore('link this session', (store) => store.linkSession(sessionId, opts.workspace), { requireSqlite: true })

  // The stream sends the agent key, minted on the first wait in this Workspace.
  const payload = cfg.lightStore !== undefined && isLocalWorkspaceId(opts.workspace)
    ? await waitFollowingLight(cfg, opts.workspace, deps)
    : await withAgentKey(cfg, opts.workspace, (client) =>
      waitForSend({ client, workspaceId: opts.workspace, ...deps, onAdmitted: turnChannelOff }))

  // Print first: the payload is what the session needs; the record is bookkeeping.
  console.log(cfg.json ? formatJson(payload) : payload.prompt)

  await withStore('record the held send', (store) => store.holdSend({
    sendId: payload.send.id,
    attempt: payload.send.attempt,
    workspaceId: payload.send.workspaceId,
    discussionId: payload.send.discussionId,
    sessionId,
    leaseExpiresAt: payload.send.leaseExpiresAt,
  }))
}
