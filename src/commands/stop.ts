/**
 * `margins stop` — stop the detached Margins Light daemon that `margins open` starts.
 * The launcher tells the user to run this; before, the command didn't exist and the only way to
 * end the daemon was `kill <pid>`. Thin wrapper over stopDaemon() (reads ~/.margins/daemon.json,
 * SIGTERMs a live margins daemon, cleans the discovery file).
 */
import { stopDaemon } from '../lib/runtime.js'
import { formatJson } from '../lib/output.js'

export function handleStop(json: boolean): string {
  const result = stopDaemon()
  if (json) return formatJson(result)
  switch (result.reason) {
    case 'stopped':
      return `Stopped the Margins Light daemon (pid ${result.pid}).`
    case 'stale':
      return 'No running Margins Light daemon — cleaned up a stale discovery file.'
    default:
      return 'No running Margins Light daemon.'
  }
}
