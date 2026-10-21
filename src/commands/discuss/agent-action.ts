import type { ResolvedConfig } from '../../lib/config.js'
import { formatJson } from '../../lib/output.js'
import { ValidationError } from '../../lib/errors.js'
import { sendAgentAction, type AgentActionDeps, type AgentActionRequest } from '../../lib/agent-channel/actions.js'
import type { AgentAction } from '../../lib/agent-channel/protocol.js'

export interface AgentActionOpts {
  send: string
  attempt: string
  /** The Workspace id; default: the one `discuss wait` recorded for the send. */
  workspace?: string
  /** `reply`: the reply. `propose`: the rationale. */
  body?: string
  /** `progress`: the progress line. */
  text?: string
  /** `resolve`: the resolution summary. */
  summary?: string
  /** `done`: an optional note. */
  note?: string
  /** `propose`: the passage the Proposal replaces, or the heading it anchors to. */
  anchorText?: string
  anchorHeading?: string
  /** `propose`: the new text; empty proposes deleting the passage. */
  replacement?: string
}

function parseAttempt(raw: string): number {
  const attempt = Number(raw)
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new ValidationError(`--attempt must be a positive integer (got "${raw}").`)
  }
  return attempt
}

function actionBody(action: AgentAction, opts: AgentActionOpts): AgentActionRequest['body'] {
  switch (action) {
    case 'reply':
      if (!opts.body) throw new ValidationError('reply --send needs --body <text>.')
      return { text: opts.body }
    case 'progress':
      if (!opts.text) throw new ValidationError('progress needs --text <line>.')
      return { text: opts.text }
    case 'resolve':
      return opts.summary ? { text: opts.summary } : {}
    case 'done':
      return opts.note ? { text: opts.note } : {}
    case 'propose': {
      if (opts.replacement === undefined) throw new ValidationError('propose needs --replacement <text> (empty to delete the passage).')
      if (!opts.anchorText && !opts.anchorHeading) {
        throw new ValidationError('propose needs --anchor-text <passage> or --anchor-heading <heading>.')
      }
      const proposal: Record<string, string> = { body: opts.body ?? '' }
      if (opts.anchorText) {
        proposal['anchorType'] = 'text'
        proposal['anchorSelectedText'] = opts.anchorText
        if (opts.anchorHeading) proposal['anchorHeadingText'] = opts.anchorHeading
      } else {
        proposal['anchorType'] = 'heading'
        proposal['anchorHeadingText'] = opts.anchorHeading!
      }
      proposal['replacementBody'] = opts.replacement
      return { ...(opts.body ? { text: opts.body } : {}), proposal }
    }
  }
}

/**
 * `margins discuss <reply|propose|progress|resolve|done> --send <id> --attempt <n>`:
 * one agent action on the send `discuss wait` claimed, with the agent key.
 */
export async function handleAgentAction(
  cfg: ResolvedConfig,
  action: AgentAction,
  opts: AgentActionOpts,
  deps: AgentActionDeps = {},
): Promise<void> {
  const answer = await sendAgentAction(cfg, {
    action,
    sendId: opts.send,
    attempt: parseAttempt(opts.attempt),
    workspaceId: opts.workspace,
    body: actionBody(action, opts),
  }, deps)

  if (cfg.json) {
    console.log(formatJson(answer))
    return
  }
  const created = answer.createdId ? `, created ${answer.createdId}` : ''
  console.log(`${action} accepted on send ${answer.sendId} (attempt ${answer.attempt}, now ${answer.state}${created}).`)
}
