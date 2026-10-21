import type { ResolvedConfig } from '../../lib/config.js'
import { resolveBearer } from '../../lib/api-client.js'
import { formatJson } from '../../lib/output.js'
import { waitForSend } from '../../lib/agent-channel/wait.js'
import { openAgentChannelStore } from '../../lib/agent-channel/store.js'

export interface DiscussWaitDeps {
  /** Test seams: the backoff sleep, the jitter source, the silent-stream timeout. */
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  idleTimeoutMs?: number
}

/**
 * The local session this `wait` runs for: `--session`, else the Claude Code session
 * that launched it, else the parent process.
 */
function localSessionId(explicit: string | undefined): string {
  return explicit ?? process.env['CLAUDE_CODE_SESSION_ID'] ?? `ppid-${process.ppid}`
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
  const store = await openAgentChannelStore()
  try {
    store.linkSession(sessionId, opts.workspace)

    const payload = await waitForSend({
      serverUrl: cfg.serverUrl,
      workspaceId: opts.workspace,
      bearer: () => resolveBearer(cfg),
      ...deps,
    })

    store.holdSend({
      sendId: payload.send.id,
      attempt: payload.send.attempt,
      workspaceId: payload.send.workspaceId,
      discussionId: payload.send.discussionId,
      sessionId,
      leaseExpiresAt: payload.send.leaseExpiresAt,
    })

    if (cfg.json) {
      console.log(formatJson(payload))
      return
    }
    console.log(payload.prompt)
  } finally {
    store.close()
  }
}
