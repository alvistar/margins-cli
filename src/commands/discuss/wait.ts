import type { ResolvedConfig } from '../../lib/config.js'
import { formatJson } from '../../lib/output.js'
import { waitForSend, type WaitForSendOptions } from '../../lib/agent-channel/wait.js'
import { openAgentChannelStore, type AgentChannelStore } from '../../lib/agent-channel/store.js'
import { withAgentKey } from '../../lib/agent-channel/agent-key.js'
import { removeChannelServer } from '../../lib/agent-channel/mcp-config.js'

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
 * The local store is bookkeeping: a locked or unavailable store must never cost the
 * session a send the server has already claimed for it. Each write warns and goes on.
 */
async function withStore(action: string, write: (store: AgentChannelStore) => void): Promise<void> {
  let store: AgentChannelStore | undefined
  try {
    store = await openAgentChannelStore()
    write(store)
  } catch (err) {
    const reason = (err as { userMessage?: string }).userMessage ?? (err as Error).message
    process.stderr.write(`margins: local store: could not ${action}: ${reason}\n`)
  } finally {
    store?.close()
  }
}

/**
 * Linking turns the old `channel.mjs` channel off, so a comment without a send never
 * reaches this session (D18 #10). A config it cannot read is left alone, with a warning.
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
  const sessionId = localSessionId(opts.session)
  await withStore('link this session', (store) => store.linkSession(sessionId, opts.workspace))
  turnChannelOff()

  // The stream sends the agent key, minted on the first wait in this Workspace.
  const payload = await withAgentKey(cfg, opts.workspace, (client) =>
    waitForSend({ client, workspaceId: opts.workspace, ...deps }))

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
