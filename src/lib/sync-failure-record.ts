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
 * A THIRD reader: the installed hook itself. The person who pushes may never run
 * another `margins` command, so each record is mirrored into a plain-text
 * NOTICE in the repository's git directory (`<git-dir>/margins-sync-failed.txt`,
 * never tracked, never in `git status`), and the hook prints it, synchronously
 * and with no Node startup, before it backgrounds the next sync. The notice
 * stays until a sync of the failed branches succeeds, even after a foreground
 * command has reported (and so cleared) the record. Unlike the
 * record, the notice follows the repository, not `MARGINS_DATA_DIR`.
 *
 * A sync that SUCCEEDED can still leave a file out: a path the server refused
 * is skipped so the rest of the branch syncs. That file is missing on Margins
 * just as surely, so the hook prints a sibling notice for it
 * (`<git-dir>/margins-sync-skipped.txt`) under a rule of its own: it names the
 * skipped paths and the server's reason, and it clears for a branch when a
 * later sync of that branch skips nothing. A failed sync says nothing about
 * what it would skip, so it leaves the skip notice as it was.
 *
 * The record is REPLACED, not appended. A hook that fails on every push for a
 * week should leave one current record, not a log to page through; the useful
 * fact is "your syncs are failing, here is why", and the latest cause is the
 * truest one.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { registryPath } from './registry.js'
import { GIT_STDIO } from './git-branch.js'
import { MarginsError } from './errors.js'
import { printable, type RefusedPath } from './cas-sync.js'

// ─── Shape ───────────────────────────────────────────────────────────────────

/** One project's outstanding failed background syncs. */
export interface SyncFailureRecord {
  /** The project directory the sync was for. This is the record's key. */
  dir: string
  /** The branches that failed — not the ones that succeeded alongside them. */
  branches: string[]
  /** Why, in the words the failing layer used. */
  cause: string
  /** ISO 8601 timestamp of the failure. */
  at: string
  /**
   * The cause each branch failed with, individually.
   *
   * `branches` and `cause` are the flattened view the report prints, and they
   * cannot survive a partial clear on their own: when one of several branches
   * later succeeds, the record has to drop THAT branch and keep the others'
   * reasons intact. Written by this version and absent from files an older CLI
   * left behind, so every reader treats it as optional and falls back to
   * pairing every branch with the shared `cause`.
   */
  causeByBranch?: Record<string, string>
}

/** The outcome shape `handleHookSync` returns, narrowed to what we need. */
export interface HookSyncOutcome {
  branch: string
  ok: boolean
  error?: string
  /** Paths a successful sync left out because the server refused them. */
  refused?: RefusedPath[]
  /** Server paths that sync kept instead of deleting, because it refused a path. */
  heldBack?: string[]
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
    if (isRecord(value, dir)) out.push({ ...value, dir, causeByBranch: causeByBranchOf(value) })
  }
  return out
}

/**
 * A record's per-branch causes, however the file happens to spell them.
 *
 * A file written by an older CLI has only the flattened `branches` + `cause`,
 * which is exactly as much as it knew; pairing every branch with that shared
 * cause loses nothing it ever recorded.
 */
function causeByBranchOf(r: SyncFailureRecord): Record<string, string> {
  const stored = r.causeByBranch
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const clean: Record<string, string> = {}
    for (const [branch, cause] of Object.entries(stored)) {
      if (typeof cause === 'string') clean[branch] = cause
    }
    if (Object.keys(clean).length > 0) return clean
  }
  return Object.fromEntries(r.branches.map((b) => [b, r.cause]))
}

/** Read every record and clear the file — the report-once primitive. */
export function takeSyncFailureRecords(): SyncFailureRecord[] {
  // The hook's notice stays: the command that reported the record may be one
  // nobody reads (an agent session's `discuss wait`), so only a successful
  // sync of the failed branches removes it.
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
      `  ${printable(r.dir)} — ${printable(r.branches.join(', '))} — ${printable(r.cause)} (${printable(r.at)})`),
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
  //
  // The staging name carries the PID. It used to be a single fixed
  // `<file>.tmp`, shared by every process on the machine: two hooks writing at
  // once each staged over the other's file and each renamed it away, so one
  // record survived and the LOSERS DIED — `renameSync` throws ENOENT once the
  // file it is renaming has already been renamed by somebody else. The lock
  // below serializes the ordinary case; this makes the name unshareable so a
  // broken or bypassed lock degrades to a lost update rather than a crash.
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf-8')
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

function currentByDir(): Record<string, SyncFailureRecord> {
  const out: Record<string, SyncFailureRecord> = {}
  for (const r of readSyncFailureRecords()) out[r.dir] = r
  return out
}

// ─── The record-file lock ────────────────────────────────────────────────────
//
// Every write below is a read-modify-write of ONE shared file, and the hook
// path's own `withBranchLock` does not serialize them: it keys on (dir, branch),
// so two different repositories failing at the same moment — two independent
// `git push`es, two background processes — are not serialized at all. Measured
// before this lock existed: six concurrent writers, six distinct directories,
// four surviving records and five crashed processes.
//
// Same shape as `withBranchLock`: a DIRECTORY, because `mkdir` is atomic on
// every platform we run on where "exists? then create" is not; broken when
// stale so a killed holder cannot block the file forever; and taken anyway once
// the wait runs out, since a lost update is a better outcome than a hook that
// never returns.
//
// The timeouts are much shorter than the branch lock's, and deliberately: what
// this guards is a few filesystem calls, not a network sync. A holder still
// alive after seconds is not slow, it is dead.
const RECORD_LOCK_STALE_MS = 5_000
const RECORD_LOCK_WAIT_MS = 5_000
const RECORD_LOCK_POLL_MS = 5

function recordLockPath(): string {
  return `${syncFailureRecordPath()}.lock`
}

/**
 * Block this process for `ms`.
 *
 * The critical section is synchronous — callers are ordinary sync functions,
 * and `settleHookSyncOutcome` runs as the last act of a backgrounded hook — so
 * there is no event loop to yield to. `Atomics.wait` is the one primitive that
 * actually sleeps rather than spinning a core hot.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function withRecordLock<T>(fn: () => T): T {
  const lock = recordLockPath()
  fs.mkdirSync(path.dirname(lock), { recursive: true })

  let held = false
  const deadline = Date.now() + RECORD_LOCK_WAIT_MS
  while (!held) {
    try {
      fs.mkdirSync(lock)
      held = true
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > RECORD_LOCK_STALE_MS) {
        fs.rmSync(lock, { recursive: true, force: true })
        continue
      }
    } catch {
      continue  // vanished between the mkdir and the stat — try to take it
    }
    if (Date.now() > deadline) break
    sleepSync(RECORD_LOCK_POLL_MS)
  }

  try {
    return fn()
  } finally {
    if (held) fs.rmSync(lock, { recursive: true, force: true })
  }
}

// ─── Mutations ───────────────────────────────────────────────────────────────

/** Record (REPLACING any previous record for the same project) a failed sync. */
export function recordSyncFailure(record: SyncFailureRecord): void {
  withRecordLock(() => {
    const all = currentByDir()
    const dir = keyFor(record.dir)
    all[dir] = {
      ...record,
      dir,
      causeByBranch: record.causeByBranch ?? causeByBranchOf(record),
    }
    writeAll(all)
  })
}

/** Drop this project's record entirely — every branch of it. */
export function clearSyncFailure(dir: string): void {
  withRecordLock(() => {
    const all = currentByDir()
    const key = keyFor(dir)
    if (!(key in all)) return
    delete all[key]
    writeAll(all)
  })
}

/**
 * Fold one hook invocation's outcome into this project's record, PER BRANCH.
 *
 * The record is keyed by directory but written per-invocation, and those two
 * scopes do not line up: one repository has many branches and any given push
 * settles only the ones it touched. Clearing the whole directory on success
 * therefore deleted records nobody had seen — push `feature`, it fails and
 * records; push `main`, it succeeds and erases `feature`'s record, which only
 * ever surfaces on the NEXT FOREGROUND command and so had no chance to be read.
 *
 * So: remove exactly the branches this invocation covered, add back the ones
 * that failed in it, and delete the record only when nothing is left
 * outstanding.
 */
function updateSyncFailures(
  dir: string,
  coveredBranches: string[],
  failures: Record<string, string>,
  at: string,
): void {
  withRecordLock(() => {
    const all = currentByDir()
    const key = keyFor(dir)
    const existing = all[key]

    const causes = existing ? { ...causeByBranchOf(existing) } : {}
    for (const branch of coveredBranches) delete causes[branch]
    Object.assign(causes, failures)

    const branches = Object.keys(causes)
    if (branches.length === 0) {
      if (!(key in all)) return
      delete all[key]
      writeAll(all)
      return
    }

    all[key] = {
      dir: key,
      branches,
      // One line per distinct cause: the failures a hook produces are
      // overwhelmingly shared, and repeating one sentence per branch buries the
      // single thing worth reading.
      cause: [...new Set(Object.values(causes))].join('; '),
      // The timestamp moves only when this run added something. A record kept
      // alive purely by an older branch keeps that older branch's time, which
      // is when the failure it describes actually happened.
      at: Object.keys(failures).length > 0 ? at : (existing?.at ?? at),
      causeByBranch: causes,
    }
    writeAll(all)
  })
}

// ─── The hook's notices ──────────────────────────────────────────────────────

/** The failure notice's name inside a repository's git directory. The hook scripts name it too. */
export const SYNC_FAILURE_NOTICE = 'margins-sync-failed.txt'

/** The skip notice's name inside a repository's git directory. The hook scripts name it too. */
export const SYNC_SKIP_NOTICE = 'margins-sync-skipped.txt'

/**
 * The per-branch entries behind each notice, beside it in the git directory.
 * The notice is the text the hook prints; this is what lets one branch's sync
 * settle that branch's lines and keep the others'. It is NOT the record: a
 * foreground command takes (and so empties) the record, and the notice must
 * outlive that.
 */
const SYNC_FAILURE_STATE = 'margins-sync-failed.json'
const SYNC_SKIP_STATE = 'margins-sync-skipped.json'

interface BranchFailure {
  cause: string
  at: string
}

interface BranchSkips {
  refused: RefusedPath[]
  /** Deletions the sync held back because it refused a path. */
  heldBack?: string[]
  at: string
}

function parseFailure(v: unknown): BranchFailure | undefined {
  const e = v as Partial<BranchFailure> | null
  return e && typeof e.cause === 'string' && typeof e.at === 'string'
    ? { cause: e.cause, at: e.at }
    : undefined
}

function parseSkips(v: unknown): BranchSkips | undefined {
  const e = v as Partial<BranchSkips> | null
  if (!e || typeof e.at !== 'string' || !Array.isArray(e.refused)) return undefined
  const refused = e.refused.filter((r): r is RefusedPath =>
    !!r && typeof r.path === 'string' && typeof r.reason === 'string')
  const heldBack = Array.isArray(e.heldBack) ? e.heldBack.filter((p): p is string => typeof p === 'string') : []
  return refused.length > 0 ? { refused, ...(heldBack.length > 0 ? { heldBack } : {}), at: e.at } : undefined
}

/** The words the hook prints at the next push. */
function formatSyncFailureNotice(failures: Map<string, BranchFailure>): string {
  const lines = ['margins: the last background sync did not reach Margins.']
  for (const [branch, { cause, at }] of failures) {
    lines.push(`  ${printable(branch)} — ${printable(cause)} (${printable(at)})`)
  }
  lines.push('  The next sync runs in the background; this notice clears once a sync of the branch succeeds.')
  return lines.join('\n') + '\n'
}

/** The words the hook prints at the next push. */
function formatSyncSkipNotice(skips: Map<string, BranchSkips>): string {
  const lines = ['margins: the last background sync left files out of Margins.']
  for (const [branch, { refused, heldBack, at }] of skips) {
    for (const r of refused) {
      lines.push(`  ${printable(branch)}: ${printable(r.path)} — the server refused it: ${printable(r.reason)} (${printable(at)})`)
    }
    if (heldBack && heldBack.length > 0) {
      lines.push(`  ${printable(branch)}: ${heldBack.length} deletion(s) held back until those paths are fixed: ${heldBack.map(printable).join(', ')}`)
    }
  }
  lines.push('  Rename or remove them; this notice clears once a sync of the branch skips nothing.')
  return lines.join('\n') + '\n'
}

/**
 * `dir`'s git directory and the branch names that still exist there, or
 * undefined outside a git repository. A pre-push sync is named after the
 * REMOTE ref (`git push origin feat:release` syncs `release`), so a name counts
 * while a local branch or a remote-tracking ref (`refs/remotes/<remote>/<name>`)
 * carries it.
 */
function gitLayout(dir: string): { gitDir: string; branches: Set<string> } | undefined {
  try {
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: GIT_STDIO })
    const gitDir = git(['rev-parse', '--absolute-git-dir']).trim()
    if (!gitDir) return undefined
    const refs = git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])
    const branches = new Set<string>()
    for (const ref of refs.split('\n')) {
      if (ref.startsWith('refs/heads/')) branches.add(ref.slice('refs/heads/'.length))
      else if (ref.startsWith('refs/remotes/')) {
        const rest = ref.slice('refs/remotes/'.length)
        const slash = rest.indexOf('/')
        if (slash > 0) branches.add(rest.slice(slash + 1))
      }
    }
    return { gitDir, branches }
  } catch {
    return undefined
  }
}

/** The stored entries, keyed by branch. A Map, so a branch named `__proto__` is an entry. */
function readBranchState<E>(file: string, parse: (v: unknown) => E | undefined): Map<string, E> {
  const out = new Map<string, E>()
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return out
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [branch, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = parse(v)
    if (e) out.set(branch, e)
  }
  return out
}

/** Staged and renamed, so the hook's `cat` never reads a half-written notice. */
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, content, 'utf-8')
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

interface BranchNotice<E> {
  notice: string
  state: string
  parse: (v: unknown) => E | undefined
  /** A branch's new entry, `null` to clear it, `undefined` to leave it as it was. */
  update: (r: HookSyncOutcome) => E | null | undefined
  format: (entries: Map<string, E>) => string
}

/**
 * Fold one hook invocation into a per-branch notice. This run speaks for the
 * branches it attempted and for no others. A stored branch that no longer
 * exists (no local branch, no remote-tracking ref) gets no later sync to clear
 * its lines, so it is dropped; a branch this run just settled stays even
 * without a ref of that name.
 */
function settleBranchNotice<E>(
  layout: { gitDir: string; branches: Set<string> },
  results: HookSyncOutcome[],
  n: BranchNotice<E>,
): void {
  const notice = path.join(layout.gitDir, n.notice)
  const state = path.join(layout.gitDir, n.state)
  const settled = new Set(results.map((r) => r.branch))
  const entries = readBranchState(state, n.parse)
  for (const r of results) {
    const e = n.update(r)
    if (e === null) entries.delete(r.branch)
    else if (e !== undefined) entries.set(r.branch, e)
  }
  for (const branch of entries.keys()) {
    if (!settled.has(branch) && !layout.branches.has(branch)) entries.delete(branch)
  }
  if (entries.size === 0) {
    fs.rmSync(notice, { force: true })
    fs.rmSync(state, { force: true })
    return
  }
  writeAtomic(state, JSON.stringify(Object.fromEntries(entries), null, 2))
  writeAtomic(notice, n.format(entries))
}

/**
 * Settle `dir`'s two notices for one hook invocation, PER BRANCH.
 *
 * The failure notice: a failed sync writes its branch's cause, a successful
 * one clears it. The skip notice: a successful sync's skips replace its
 * branch's entry and no skips clear it; a failed sync posted nothing, so it
 * leaves the branch's skips as they were. In CI only the skips are settled
 * (a failure there throws instead). Only hook syncs settle them. Best effort:
 * a notice that cannot be written must never fail the hook.
 */
function settleNotices(dir: string, results: HookSyncOutcome[], at: string, failures: boolean): void {
  // The git calls run before the lock: it is sized for a few filesystem calls.
  const layout = gitLayout(dir)
  if (!layout) return
  try {
    withRecordLock(() => {
      settleBranchNotice(layout, results, {
        notice: SYNC_SKIP_NOTICE,
        state: SYNC_SKIP_STATE,
        parse: parseSkips,
        update: (r) => !r.ok ? undefined
          : r.refused && r.refused.length > 0
            ? { refused: r.refused, ...(r.heldBack && r.heldBack.length > 0 ? { heldBack: r.heldBack } : {}), at }
            : null,
        format: formatSyncSkipNotice,
      })
      if (!failures) return
      settleBranchNotice(layout, results, {
        notice: SYNC_FAILURE_NOTICE,
        state: SYNC_FAILURE_STATE,
        parse: parseFailure,
        update: (r) => r.ok ? null : { cause: r.error ?? 'unknown error', at },
        format: formatSyncFailureNotice,
      })
    })
  } catch {
    // Best effort — a notice that cannot be written must never fail the hook.
  }
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

  const at = (opts.now ?? new Date()).toISOString()
  const ci = isNonInteractiveCi(opts.env)
  // Before the CI throw: a skip is not a failure, and the branches that
  // succeeded beside a failed one still settle their skips.
  settleNotices(dir, results, at, !ci)

  const failed = results.filter((r) => !r.ok)
  const branches = failed.map((r) => r.branch)
  // One line per distinct cause — the failures a hook produces are
  // overwhelmingly shared (unreachable server, expired key, mode refusal), and
  // repeating one sentence per branch buries the single thing worth reading.
  const causes = [...new Set(failed.map((r) => r.error ?? 'unknown error'))]
  const cause = causes.join('; ')

  if (failed.length > 0 && ci) {
    throw new BackgroundSyncFailed(
      `Margins sync failed for ${printable(branches.join(', '))} in ${printable(dir)} — ${printable(cause)}\n` +
      'Nothing was sent to Margins. This step fails rather than passing quietly: a CI ' +
      'runner has no later `margins` command to report it to, and the container does not ' +
      'outlive the job.',
    )
  }

  // Per BRANCH, not per directory. This run speaks for the branches it actually
  // attempted and for no others: a success here clears those branches' entries
  // and leaves any other branch's unseen failure exactly where it is.
  const failures: Record<string, string> = {}
  for (const r of failed) failures[r.branch] = r.error ?? 'unknown error'
  updateSyncFailures(
    dir,
    results.map((r) => r.branch),
    failures,
    at,
  )
}
