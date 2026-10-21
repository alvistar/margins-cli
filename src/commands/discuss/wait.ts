import type { ResolvedConfig } from '../../lib/config.js'
import { createApiClient } from '../../lib/api-client.js'
import { formatJson } from '../../lib/output.js'
import { waitForSend, type WaitForSendOptions } from '../../lib/agent-channel/wait.js'
import { openAgentChannelStore, type AgentChannelStore } from '../../lib/agent-channel/store.js'

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
 * `margins discuss wait --workspace <id>`: hold the agent stream, claim one send,
 * print its payload, return (exit 0). The harness that ran it in the background
 * wakes the session with the output. The local store records the link and which
 * session holds the send (machine state only, no secrets).
 */
export async function handleDiscussWait(
  cfg: ResolvedConfig,
  opts: { workspace: string; session?: string },
  deps: DiscussWaitDeps = {},
): Promise<void> {
  const sessionId = localSessionId(opts.session)
  await withStore('link this session', (store) => store.linkSession(sessionId, opts.workspace))

  const payload = await waitForSend({ client: createApiClient(cfg), workspaceId: opts.workspace, ...deps })

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
