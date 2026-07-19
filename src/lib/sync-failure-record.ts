/**
 * The failure record — how a background sync that failed becomes findable (U7, R16).
 *
 * Both installed git hooks background their sync and `exit 0`, so git is never
 * blocked. That is deliberate, and it is also what makes a refusal INVISIBLE:
 * the background process writes to a terminal nobody is watching, its exit code
 * goes nowhere, and the developer's next push is refused again in the same
 * silence. This module gives that failure a place to live and someone to tell.
 *
 * Two channels, because the two environments have genuinely different ones:
 *
 *   LOCAL — a record on disk. The hook writes what failed, why, and when; the
 *   next foreground `margins` command reports it once and clears it. There IS a
 *   next command, and the filesystem survives between them.
 *
 *   CI — a non-zero exit and the job log. There is no next command and no
 *   surviving filesystem: a runner is a fresh container destroyed with the job,
 *   so a record written there is written to nothing. Failing the step is the
 *   only channel that reaches a human, so the message must NAME what failed and
 *   what to do rather than surfacing a bare error.
 *
 * WHERE the record lives matters as much as that it exists. It goes in the
 * CLI's own data directory, beside the registry (`registryPath()`), and NEVER
 * inside the user's project — a file dropped there shows up in `git status`,
 * gets swept into `git add -A`, and ends up committed. `MARGINS_DATA_DIR`
 * therefore isolates it exactly as it isolates the registry and the hook locks.
 *
 * The record is REPLACED, not appended. A hook that fails on every push for a
 * week should leave one current record, not a log to page through; the useful
 * fact is "your syncs are failing, here is why", and the latest cause is the
 * truest one.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { registryPath } from './registry.js'
import { MarginsError } from './errors.js'

// ─── Shape ───────────────────────────────────────────────────────────────────

/** One project's most recent failed background sync. */
export interface SyncFailureRecord {
  /** The project directory the sync was for. This is the record's key. */
  dir: string
  /** The branches that failed — not the ones that succeeded alongside them. */
  branches: string[]
  /** Why, in the words the failing layer used. */
  cause: string
  /** ISO 8601 timestamp of the failure. */
  at: string
}

/** The outcome shape `handleHookSync` returns, narrowed to what we need. */
export interface HookSyncOutcome {
  branch: string
  ok: boolean
  error?: string
}

/**
 * A background sync that failed where the only channel is a failed step (CI).
 *
 * `message` carries the full detail, not a summary: an uncaught throw prints
 * `err.message`, and a job log that says only "Background sync failed" is the
 * bare error this unit exists to avoid.
 */
export class BackgroundSyncFailed extends MarginsError {
  constructor(message: string) {
    super(message, message, 1)
  }
}

// ─── Location ────────────────────────────────────────────────────────────────

/**
 * The record file: beside `repos.json` in the CLI's data directory, so
 * `MARGINS_DATA_DIR` isolates it for free (tests, and any user who relocates
 * their state, get the same isolation the registry already has).
 */
export function syncFailureRecordPath(): string {
  return path.join(path.dirname(registryPath()), 'sync-failures.json')
}

/** Normalise a project directory into a stable key. */
function keyFor(dir: string): string {
  return path.resolve(dir).replace(/\/+$/, '')
}

// ─── Reading (the surfacing half) ────────────────────────────────────────────

function isRecord(value: unknown, dir: string): value is SyncFailureRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Partial<SyncFailureRecord>
  return (
    Array.isArray(r.branches) &&
    r.branches.every((b) => typeof b === 'string') &&
    typeof r.cause === 'string' &&
    typeof r.at === 'string' &&
    typeof dir === 'string'
  )
}

/**
 * Every current record, or an empty list.
 *
 * A malformed file is not an error to report at the user — it is a file we
 * wrote and failed to write well. Reporting a parse error in front of an
 * unrelated command would be worse than the silence this module exists to fix,
 * so the file is discarded and the command carries on.
 */
export function readSyncFailureRecords(): SyncFailureRecord[] {
  const file = syncFailureRecordPath()
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return []
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []

  const out: SyncFailureRecord[] = []
  for (const [dir, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isRecord(value, dir)) out.push({ ...value, dir })
  }
  return out
}

/** Read every record and clear the file — the report-once primitive. */
export function takeSyncFailureRecords(): SyncFailureRecord[] {
  const records = readSyncFailureRecords()
  // Cleared unconditionally: a file that failed to parse must not survive to
  // fail again on every future command.
  try {
    fs.rmSync(syncFailureRecordPath(), { force: true })
  } catch {
    // Best effort — an unremovable record must never fail the user's command.
  }
  return records
}

/** The user-facing wording for pending records. */
export function formatSyncFailureReport(records: SyncFailureRecord[]): string {
  if (records.length === 0) return ''
  const lines = [
    'margins: an earlier background sync did not reach Margins.',
    ...records.map((r) =>
      `  ${r.dir} — ${r.branches.join(', ')} — ${r.cause} (${r.at})`),
    '  Git was not blocked at the time, so nothing said so. Fix the cause and push again.',
  ]
  return lines.join('\n') + '\n'
}

/**
 * Report any pending failure, once, and clear it. Called at the start of every
 * FOREGROUND command (never from the hook path, which has no one to tell).
 *
 * Returns whether anything was reported. Never throws: this runs in front of
 * unrelated commands, and a bookkeeping failure must not take one of them down.
 */
export function reportPendingSyncFailures(
  write: (s: string) => void = (s) => { process.stderr.write(s) },
): boolean {
  let records: SyncFailureRecord[] = []
  try {
    records = takeSyncFailureRecords()
  } catch {
    return false
  }
  if (records.length === 0) return false
  try {
    write(formatSyncFailureReport(records))
  } catch {
    return false
  }
  return true
}

// ─── Writing (the background half) ───────────────────────────────────────────

function writeAll(records: Record<string, SyncFailureRecord>): void {
  const file = syncFailureRecordPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (Object.keys(records).length === 0) {
    fs.rmSync(file, { force: true })
    return
  }
  // Atomic, matching the registry's write: partial JSON here would be read back
  // as malformed and silently discarded — losing the very failure we recorded.
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
}

function currentByDir(): Record<string, SyncFailureRecord> {
  const out: Record<string, SyncFailureRecord> = {}
  for (const r of readSyncFailureRecords()) out[r.dir] = r
  return out
}

/** Record (REPLACING any previous record for the same project) a failed sync. */
export function recordSyncFailure(record: SyncFailureRecord): void {
  const all = currentByDir()
  const dir = keyFor(record.dir)
  all[dir] = { ...record, dir }
  writeAll(all)
}

/** Drop this project's record — its sync has since succeeded. */
export function clearSyncFailure(dir: string): void {
  const all = currentByDir()
  const key = keyFor(dir)
  if (!(key in all)) return
  delete all[key]
  writeAll(all)
}

// ─── Which channel ───────────────────────────────────────────────────────────

const CI_FLAGS = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'TF_BUILD']
const DISABLED = new Set(['', '0', 'false', 'no', 'off'])

/**
 * Is this a CI runner — somewhere with no next foreground command and no
 * surviving filesystem?
 *
 * `CI=false` is a real thing people set to opt OUT (npm, several actions), so a
 * mere "is the variable present" check would misread it and swallow the failure
 * on a machine that does have a next command.
 */
export function isNonInteractiveCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return CI_FLAGS.some((flag) => {
    const v = env[flag]
    return v !== undefined && !DISABLED.has(String(v).trim().toLowerCase())
  })
}

/**
 * Settle what a hook sync's outcome means for the world outside this process.
 *
 * Success clears any stale record, so a failure that has since been fixed stops
 * being reported. Failure takes whichever channel the environment has:
 * CI throws (the caller exits non-zero, the job log carries the message);
 * everywhere else records, and returns normally so git stays unblocked.
 */
export function settleHookSyncOutcome(
  dir: string,
  results: HookSyncOutcome[],
  opts: { env?: NodeJS.ProcessEnv; now?: Date } = {},
): void {
  // Nothing was attempted — a tags-only push, a branch deletion, a hook that
  // could not resolve a commit. That is not a success, and treating it as one
  // would clear a real pending failure that nobody has seen yet.
  if (results.length === 0) return

  const failed = results.filter((r) => !r.ok)
  if (failed.length === 0) {
    clearSyncFailure(dir)
    return
  }

  const branches = failed.map((r) => r.branch)
  // One line per distinct cause — the failures a hook produces are
  // overwhelmingly shared (unreachable server, expired key, mode refusal), and
  // repeating one sentence per branch buries the single thing worth reading.
  const causes = [...new Set(failed.map((r) => r.error ?? 'unknown error'))]
  const cause = causes.join('; ')

  if (isNonInteractiveCi(opts.env)) {
    throw new BackgroundSyncFailed(
      `Margins sync failed for ${branches.join(', ')} in ${dir} — ${cause}\n` +
      'Nothing was sent to Margins. This step fails rather than passing quietly: a CI ' +
      'runner has no later `margins` command to report it to, and the container does not ' +
      'outlive the job.',
    )
  }

  recordSyncFailure({
    dir,
    branches,
    cause,
    at: (opts.now ?? new Date()).toISOString(),
  })
}
