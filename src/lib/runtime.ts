/**
 * Margins Light runtime bootstrap (M2 U5–U7). Resolve the runtime version, install the private
 * npm package (@alvistar/margins-light) from GitHub Packages into a per-version cache under
 * ~/.margins/runtime/<version>/, and return the package root the CLI spawns (KTD4 launcher).
 *
 * The install is ATOMIC (temp dir → rename), CONCURRENCY-safe (a per-version lock so two
 * `margins open`s don't race), and the cache AUTO-PRUNES to the active + previous version so it
 * can't grow unbounded. Auth is a classic read:packages PAT (Codex #7) resolved from env or the
 * `gh` CLI; the isolated .npmrc forces the PUBLIC registry for the bundled deps' unscoped names
 * and GitHub Packages only for @alvistar (Codex #9).
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ghAuthToken, npmInstall, npmViewVersion, NpmExecError } from './npm.js'
import {
  NodeTooOldError,
  RuntimeAuthError,
  RuntimeIncompatibleError,
  RuntimeInstallError,
  RuntimeNotPublishedError,
} from './errors.js'

export const RUNTIME_PKG = '@alvistar/margins-light'
const RUNTIME_SCOPE = '@alvistar'
const RUNTIME_REGISTRY = 'https://npm.pkg.github.com'
export const MIN_NODE_MAJOR = 20
const KEEP_RUNTIMES = 2 // active + previous (rollback), older pruned
const STALE_MS = 10 * 60_000 // a lock/temp dir older than this (or whose holder is dead) is reclaimable

// ─── locations ──────────────────────────────────────────────────────────────
/** ~/.margins (or MARGINS_HOME) — the same root the daemon uses. */
function marginsHome(): string {
  return process.env['MARGINS_HOME'] || path.join(os.homedir(), '.margins')
}
export function runtimeRoot(): string {
  return path.join(marginsHome(), 'runtime')
}
function versionDir(version: string): string {
  return path.join(runtimeRoot(), version)
}
/** The installed package root (what U6 launches: <root>/scripts/launcher.mjs, <root>/server.js). */
export function pkgRootFor(version: string): string {
  return path.join(versionDir(version), 'node_modules', RUNTIME_PKG)
}
function isInstalled(version: string): boolean {
  return fs.existsSync(path.join(pkgRootFor(version), 'server.js'))
}

// ─── node + auth ──────────────────────────────────────────────────────────────
export function assertNode(nodeVersion: string = process.version): void {
  const major = Number(nodeVersion.replace(/^v/, '').split('.')[0])
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    throw new NodeTooOldError(nodeVersion, MIN_NODE_MAJOR)
  }
}

/** classic read:packages PAT: explicit env wins, else the ambient `gh` token (Codex #7). */
export async function resolveRuntimeToken(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return env['MARGINS_RUNTIME_TOKEN'] || env['GITHUB_TOKEN'] || (await ghAuthToken())
}

function npmrcContent(token: string): string {
  // public registry for the bundled deps' unscoped names; GitHub Packages ONLY for @alvistar.
  return (
    `registry=https://registry.npmjs.org/\n` +
    `${RUNTIME_SCOPE}:registry=${RUNTIME_REGISTRY}\n` +
    `//npm.pkg.github.com/:_authToken=${token}\n`
  )
}

/** Map an npm/gh exec failure to an actionable CLI error (never a raw stack). */
function classifyInstallError(err: unknown): Error {
  if (err instanceof NpmExecError) {
    const s = err.stderr
    if (/\b(401|403)\b|E401|E403|Unauthorized|Forbidden|Permission/i.test(s)) return new RuntimeAuthError()
    if (/\b404\b|Not Found|E404/i.test(s)) return new RuntimeNotPublishedError()
    return new RuntimeInstallError(err.message.split('\n')[0] || 'npm install failed')
  }
  return new RuntimeInstallError(err instanceof Error ? err.message : String(err))
}

/**
 * Run `fn` with a short-lived, 0600 `.npmrc` holding the token, then delete it. The credential
 * file lives in os.tmpdir (NEVER inside the cached runtime dir), is mode 0600 (not world-readable),
 * and is removed in `finally` — so the PAT is never persisted at rest in ~/.margins (Security F1/F2).
 */
async function withNpmrc<T>(token: string, fn: (npmrcPath: string) => Promise<T>): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-npmrc-'))
  const npmrc = path.join(tmp, '.npmrc')
  try {
    fs.writeFileSync(npmrc, npmrcContent(token), { mode: 0o600 })
    return await fn(npmrc)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// ─── version resolution ─────────────────────────────────────────────────────
/** The latest published runtime version (private registry, authed). 404 → not-published. */
export async function resolveRuntimeVersion(token: string): Promise<string> {
  try {
    return await withNpmrc(token, (npmrc) => npmViewVersion(RUNTIME_PKG, npmrc))
  } catch (err) {
    throw classifyInstallError(err)
  }
}

// ─── per-version install lock (concurrency) ───────────────────────────────────
/** True if a lockfile is abandoned: its holder PID is dead, or it is older than STALE_MS. */
function isStaleLock(lock: string): boolean {
  let st: fs.Stats
  try {
    st = fs.statSync(lock)
  } catch {
    return false // lock vanished — nothing to reclaim
  }
  if (Date.now() - st.mtimeMs > STALE_MS) return true
  const pid = Number(fs.readFileSync(lock, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) return true // unreadable/empty PID → abandoned
  try {
    process.kill(pid, 0) // signal 0 = liveness probe, no signal delivered
    return false // holder alive
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH' // no such process → dead → stale
  }
}

/** Sweep abandoned install state a crash/Ctrl-C left behind (stale locks + orphaned temp dirs). */
function sweepOrphans(): void {
  const root = runtimeRoot()
  let entries: string[]
  try {
    entries = fs.readdirSync(root)
  } catch {
    return
  }
  for (const name of entries) {
    const p = path.join(root, name)
    try {
      if (name.startsWith('.lock-')) {
        if (isStaleLock(p)) fs.rmSync(p, { force: true })
      } else if (name.startsWith('.tmp-') && Date.now() - fs.statSync(p).mtimeMs > STALE_MS) {
        fs.rmSync(p, { recursive: true, force: true }) // a killed install's half-written node_modules
      }
    } catch {
      // best-effort — another process may be racing the same sweep
    }
  }
}

async function withVersionLock<T>(version: string, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(runtimeRoot(), { recursive: true })
  const lock = path.join(runtimeRoot(), `.lock-${version}`)
  for (let i = 0; i < 600; i++) {
    // ~60s
    let fd: number
    try {
      fd = fs.openSync(lock, 'wx') // O_EXCL — fails if another holder exists
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Held by another install. Reclaim it if the holder died mid-install (Ctrl-C/OOM/crash),
      // otherwise wait — but if the runtime appeared meanwhile, the caller re-checks and returns.
      if (isStaleLock(lock)) {
        fs.rmSync(lock, { force: true })
        continue // retry the O_EXCL create immediately
      }
      if (isInstalled(version)) return fn() // fn() re-checks and returns the cached path
      await new Promise((r) => setTimeout(r, 100))
      continue
    }
    // Acquired. Record the holder PID (for stale detection), guaranteeing the fd + lock are freed
    // even if the write fails (e.g. ENOSPC) — otherwise the lockfile would wedge every future run.
    try {
      fs.writeFileSync(fd, String(process.pid))
    } catch (err) {
      fs.closeSync(fd)
      fs.rmSync(lock, { force: true })
      throw err
    }
    fs.closeSync(fd)
    try {
      return await fn()
    } finally {
      fs.rmSync(lock, { force: true })
    }
  }
  throw new RuntimeInstallError(
    `timed out waiting for a concurrent install of ${version}. If no other \`margins open\` is ` +
      `running, delete ${lock} and retry.`,
  )
}

// ─── ensureRuntime (the core) ─────────────────────────────────────────────────
export interface EnsureOpts {
  /** Pin a specific version; default resolves the latest published. */
  version?: string
  /** Progress callback (a first-run install is multi-second — surface it). */
  log?: (msg: string) => void
  env?: NodeJS.ProcessEnv
}

/** Ensure the runtime is cached and return its package root. Installs (authed, atomic) if missing. */
export async function ensureRuntime(opts: EnsureOpts = {}): Promise<{ version: string; pkgRoot: string }> {
  assertNode()
  const token = await resolveRuntimeToken(opts.env)
  if (!token) throw new RuntimeAuthError()
  sweepOrphans() // reclaim stale locks + orphaned temp dirs a prior crash/Ctrl-C left behind

  let version: string
  if (opts.version) {
    version = opts.version
  } else {
    try {
      version = await resolveRuntimeVersion(token)
    } catch (err) {
      // Only fall back to a cached runtime for a genuine registry/network failure — NOT for auth
      // (expired token) or not-published (yanked), which must SURFACE rather than silently pin the
      // user to a stale cached runtime with no signal (Correctness P3).
      if (!(err instanceof RuntimeInstallError)) throw err
      const cached = listRuntimes()[0]
      if (!cached) throw err
      opts.log?.(`Registry unreachable — using the cached runtime ${cached.version}.`)
      version = cached.version
    }
  }

  if (isInstalled(version)) return { version, pkgRoot: pkgRootFor(version) }

  await withVersionLock(version, async () => {
    if (isInstalled(version)) return // won the race
    const tmp = fs.mkdtempSync(path.join(runtimeRoot(), `.tmp-${version}-`))
    try {
      // NOTE: the token .npmrc is intentionally NOT written here — it would be renamed into the
      // persistent cache. withNpmrc keeps it in an ephemeral 0600 file (Security F1/F2).
      fs.writeFileSync(
        path.join(tmp, 'package.json'),
        JSON.stringify({ name: 'margins-runtime-cache', private: true }) + '\n',
      )
      opts.log?.(`Installing Margins Light runtime ${version}…`)
      await withNpmrc(token, (npmrc) => npmInstall(`${RUNTIME_PKG}@${version}`, tmp, npmrc))
      if (!fs.existsSync(path.join(tmp, 'node_modules', RUNTIME_PKG, 'server.js'))) {
        throw new RuntimeInstallError('server.js missing after install (corrupt package)')
      }
      // atomic promote: a half-installed temp dir is NEVER seen as cached
      fs.rmSync(versionDir(version), { recursive: true, force: true })
      fs.renameSync(tmp, versionDir(version))
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true })
      throw classifyInstallError(err)
    }
  })

  pruneRuntimes()
  return { version, pkgRoot: pkgRootFor(version) }
}

// ─── management (U7) ──────────────────────────────────────────────────────────
export interface CachedRuntime {
  version: string
  path: string
  sizeBytes: number
}

function dirSize(dir: string): number {
  let total = 0
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name)
    const st = fs.lstatSync(abs)
    if (st.isDirectory()) total += dirSize(abs)
    else total += st.size
  }
  return total
}

/** Cached runtime versions (newest first by semver-ish string sort), with on-disk sizes. */
export function listRuntimes(): CachedRuntime[] {
  const root = runtimeRoot()
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root)
    .filter((n) => !n.startsWith('.') && fs.existsSync(path.join(pkgRootFor(n), 'server.js')))
    .sort(compareVersionsDesc)
    .map((version) => ({ version, path: versionDir(version), sizeBytes: dirSize(versionDir(version)) }))
}

/** Semver-ish descending compare (newest first); non-numeric falls back to string. */
export function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (Number.isNaN(x) || Number.isNaN(y)) return b.localeCompare(a)
    if (x !== y) return y - x
  }
  return 0
}

// A live daemon may have booted from an OLDER cached runtime than the newest; deleting that dir
// out from under it crashes the process on its next lazy require() (M4). The daemon records the
// dir it is serving from, and we must never prune/clean that version while its PID is alive.
const DISCOVERY_MARKER = 'margins-daemon'

/**
 * Every runtime dir a currently-live daemon booted from.
 *
 * PLURAL since runtime 0.15.0. There used to be one global `~/.margins/daemon.json`, so one
 * daemon and one answer. Each store now publishes `~/.margins/daemons/<storeKey>.json`, and
 * the desktop app's daemon and the CLI's can run at the same time — from DIFFERENT cached
 * runtimes. A single answer would protect one and let prune delete the other's dir out from
 * under it.
 *
 * Both formats are read, deliberately, and the direction matters: the risk this guards is
 * DELETING a directory a live process is executing from, so every scrap of liveness evidence
 * should protect. That is the opposite of the attach path, where reading a global record
 * would let a client bind the wrong store — there, dual-reading is fail-open and forbidden.
 * Same files, opposite safety direction.
 */
export function liveRuntimeDirs(): string[] {
  const dirs = new Set<string>()
  const consider = (raw: string) => {
    let rec: { marker?: string; pid?: unknown; runtimeDir?: unknown }
    try {
      rec = JSON.parse(raw)
    } catch {
      return // unreadable or corrupt names no owner
    }
    if (rec?.marker !== DISCOVERY_MARKER || typeof rec.runtimeDir !== 'string') return
    const pid = Number(rec.pid)
    if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return
    dirs.add(rec.runtimeDir)
  }

  // Per-store records (runtime 0.15.0+).
  const daemonsDir = path.join(marginsHome(), 'daemons')
  try {
    for (const name of fs.readdirSync(daemonsDir)) {
      if (!name.endsWith('.json')) continue
      try {
        consider(fs.readFileSync(path.join(daemonsDir, name), 'utf8'))
      } catch {
        // a record that vanished mid-scan protects nothing; skip it
      }
    }
  } catch {
    // no daemons dir — either no 0.15.0+ daemon has ever run, or the home is empty
  }

  // The pre-0.15.0 global file. Still read because a cached older runtime can be serving
  // right now, and prune must not delete the dir it is running from.
  try {
    consider(fs.readFileSync(path.join(marginsHome(), 'daemon.json'), 'utf8'))
  } catch {
    // absent is the normal case once every daemon is 0.15.0+
  }

  return [...dirs]
}

/** True if `version`'s cache dir is one a live daemon is serving from (path-prefix match). */
function isVersionInUse(version: string, live: string[]): boolean {
  const dir = versionDir(version)
  return live.some((l) => l === dir || l.startsWith(dir + path.sep))
}

/** A cached version a live daemon is serving from (for `runtime list`/`clean` UI), or null. */
export function liveRuntimeVersion(): string | null {
  const live = liveRuntimeDirs()
  if (live.length === 0) return null
  for (const r of listRuntimes()) if (isVersionInUse(r.version, live)) return r.version
  return null
}

/** Liveness probe (matches liveRuntimeDirs): alive unless the PID is gone (ESRCH). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH' // EPERM etc. = exists → alive
  }
}

export interface StopResult {
  stopped: boolean
  pid?: number
  /** 'stopped' = SIGTERM sent; 'not-running' = no daemon file/marker; 'stale' = dead PID, file cleaned. */
  reason: 'stopped' | 'not-running' | 'stale'
}

/**
 * Stop the running Margins Light daemon by DELEGATING to the runtime's own launcher.
 *
 * This used to read `~/.margins/daemon.json` and SIGTERM the pid itself. Runtime 0.15.0
 * removed that file — each store now publishes `~/.margins/daemons/<storeKey>.json` — so a
 * CLI that keeps its own copy of the discovery format reports "no running daemon" about a
 * daemon that is running, and leaves it holding `.margins.lock`.
 *
 * Porting the new format here would fix today and break at the next one. The launcher ships
 * INSIDE each runtime, so it always knows that runtime's format: 0.14.x reads the global
 * file, 0.15.0+ reads the per-store record and falls back to `.margins.lock`. Delegating is
 * what `margins open` already does (KTD4) and it makes this command version-agnostic by
 * construction rather than by keeping two implementations in step.
 *
 * The launcher also does what this never did: it signals the process GROUP, health-checks
 * before signalling, refuses a recycled pid, and waits for the process to actually be gone.
 *
 * No cached runtime means no daemon can be running, so that is `not-running`, not an error —
 * and we never DOWNLOAD one just to ask.
 */
export function stopDaemon(): StopResult {
  const cached = listRuntimes()
  if (cached.length === 0) return { stopped: false, reason: 'not-running' }

  // The newest cached launcher. Any launcher can stop any daemon it can find: the store is
  // resolved from the environment, not from which runtime happens to be newest.
  const launcher = path.join(pkgRootFor(cached[0]!.version), 'scripts', 'launcher.mjs')
  if (!fs.existsSync(launcher)) return { stopped: false, reason: 'not-running' }

  const res = spawnSync(process.execPath, [launcher, 'stop', '--json'], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  const line = (res.stdout || '').trim().split('\n').filter(Boolean).pop()
  if (!line) return { stopped: false, reason: 'not-running' }

  let out: { outcome?: string; pid?: unknown }
  try {
    out = JSON.parse(line)
  } catch {
    return { stopped: false, reason: 'not-running' }
  }
  const pid = Number(out.pid)
  const withPid = Number.isInteger(pid) && pid > 0 ? { pid } : {}
  switch (out.outcome) {
    case 'stopped':
      return { stopped: true, reason: 'stopped', ...withPid }
    case 'not-running':
      return { stopped: false, reason: 'not-running', ...withPid }
    default:
      // 'refused' (a wedged or unidentifiable daemon) and 'timed-out' (signalled, still
      // alive). Neither is "stopped" and neither is "nothing was there" — surface them as
      // stale so the user is told rather than reassured. `margins stop` has no --force yet;
      // the launcher's own `stop --force` is the escape hatch.
      return { stopped: false, reason: 'stale', ...withPid }
  }
}

/** Keep the newest KEEP_RUNTIMES; delete older — but NEVER a version a live daemon booted from. */
export function pruneRuntimes(keep: number = KEEP_RUNTIMES): string[] {
  const versions = listRuntimes().map((r) => r.version)
  const live = liveRuntimeDirs()
  const removed: string[] = []
  for (const v of versions.slice(keep)) {
    if (isVersionInUse(v, live)) continue // a live daemon is serving from it (M4)
    fs.rmSync(versionDir(v), { recursive: true, force: true })
    removed.push(v)
  }
  return removed
}

/** Remove all cached runtimes except the active one (and any a live daemon is serving from — M4). */
export function cleanRuntimes(keepVersion?: string): string[] {
  const live = liveRuntimeDirs()
  const removed: string[] = []
  for (const r of listRuntimes()) {
    if (r.version === keepVersion) continue
    if (isVersionInUse(r.version, live)) continue // don't yank a running daemon's files (M4)
    fs.rmSync(r.path, { recursive: true, force: true })
    removed.push(r.version)
  }
  return removed
}

// ─── compat gate (U7) ───────────────────────────────────────────────────────
// PRE-boot skew protection (Codex #1): compare the runtime's static schemaVersion (from its
// package.json `margins` field) against the store's recorded head — a newer runtime is fine
// (it migrates forward + self-heals), an OLDER runtime than the store is REFUSED (never a silent
// downgrade). Self-contained: the CLI records the head after a successful open (the runtime that
// just migrated the store IS its new head), so a later open with an older runtime is caught.
export interface SchemaVersion {
  count: number
  tag?: string
  when?: number
}

/**
 * The Margins Light store directory the daemon should use. Explicit `MARGINS_PGLITE` wins;
 * otherwise it follows `marginsHome()` (so `MARGINS_HOME` isolates the store too). `open` passes
 * this to the launcher's env — the runtime's own default is a hardcoded `~/.margins/store` that
 * does NOT read `MARGINS_HOME`, so without this the store would escape an isolated home.
 */
export function storeDir(): string {
  return process.env['MARGINS_PGLITE'] || path.join(marginsHome(), 'store')
}
function storeHeadPath(): string {
  return path.join(storeDir(), '.schema-head.json')
}

/** The runtime's declared schema identity (package.json → margins.schemaVersion), or null. */
export function runtimeSchemaVersion(pkgRoot: string): SchemaVersion | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
    return (pkg?.margins?.schemaVersion as SchemaVersion) ?? null
  } catch {
    return null
  }
}

/** The store's recorded schema head (written after the last successful open), or null. */
export function readStoreSchemaHead(): SchemaVersion | null {
  try {
    const j = JSON.parse(fs.readFileSync(storeHeadPath(), 'utf8'))
    return (j?.schemaVersion as SchemaVersion) ?? null
  } catch {
    return null
  }
}

/** Record the runtime schema that just migrated/ran against the store (best-effort). */
export function recordStoreSchemaHead(schema: SchemaVersion): void {
  try {
    fs.mkdirSync(storeDir(), { recursive: true })
    fs.writeFileSync(storeHeadPath(), JSON.stringify({ schemaVersion: schema }) + '\n')
  } catch {
    // best-effort — a missing sidecar just means no downgrade protection until the next success
  }
}

/** Refuse an older runtime than the store's recorded head (RuntimeIncompatibleError). */
export function assertRuntimeCompat(runtimeSchema: SchemaVersion | null): void {
  const head = readStoreSchemaHead()
  if (
    head &&
    runtimeSchema &&
    typeof head.count === 'number' &&
    typeof runtimeSchema.count === 'number' &&
    runtimeSchema.count < head.count
  ) {
    throw new RuntimeIncompatibleError(runtimeSchema.count, head.count)
  }
}
