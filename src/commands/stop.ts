/**
 * `margins stop` — stop the detached Margins Light daemon that `margins open` starts.
 *
 * A thin translator over `stopDaemon()`, which delegates to the runtime's own launcher
 * rather than reading any discovery format here. See that function for why.
 *
 * The messages below are the point of the command, not decoration. Three of the five
 * verdicts mean A DAEMON IS STILL RUNNING, and every one of them used to print "No running
 * Margins Light daemon — cleaned up a stale discovery file." Both halves were false: the
 * daemon was alive, and nothing cleans a file any more. Telling someone there is nothing to
 * stop, while the thing they asked to stop holds the store lock, sends them hunting for a
 * problem the tool could see.
 */
import { stopDaemon } from '../lib/runtime.js'
import { formatJson } from '../lib/output.js'

export function handleStop(json: boolean): string {
  const result = stopDaemon()
  if (json) return formatJson(result)
  const which = result.pid ? ` (pid ${result.pid})` : ''
  switch (result.reason) {
    case 'stopped':
      return `Stopped the Margins Light daemon${which}.`
    case 'not-running':
      return 'No running Margins Light daemon.'
    case 'refused':
      return (
        `The Margins Light daemon${which} is still running — the runtime would not stop it. ` +
        'It may be wedged mid-boot, or holding a lock it cannot identify as its own. ' +
        'Run the runtime launcher with `stop --force` to signal it anyway.'
      )
    case 'timed-out':
      return (
        `Signalled the Margins Light daemon${which}, but it is still running. ` +
        'Give it a moment and try again, or signal it directly.'
      )
    default:
      return (
        `Could not stop the Margins Light daemon: ${result.detail ?? 'the runtime launcher did not answer'}. ` +
        'A daemon may still be running.'
      )
  }
}
