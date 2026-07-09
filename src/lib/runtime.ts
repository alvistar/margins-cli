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
// dir it is serving from in ~/.margins/daemon.json (margins-cli M4 contract) — read it and never
// prune/clean that version while its PID is alive.
const DISCOVERY_MARKER = 'margins-daemon'

/** The runtime dir a currently-live daemon booted from (from the discovery file), or null. */
export function liveRuntimeDir(): string | null {
  let disc: { marker?: string; pid?: unknown; runtimeDir?: unknown }
  try {
    disc = JSON.parse(fs.readFileSync(path.join(marginsHome(), 'daemon.json'), 'utf8'))
  } catch {
    return null // no daemon, or unreadable/corrupt discovery
  }
  if (disc?.marker !== DISCOVERY_MARKER || typeof disc.runtimeDir !== 'string') return null
  const pid = Number(disc.pid)
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0) // liveness probe
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return null // daemon is gone
  }
  return disc.runtimeDir
}

/** True if `version`'s cache dir is the one the live daemon is serving from (path-prefix match). */
function isVersionInUse(version: string, live: string | null): boolean {
  if (!live) return false
  const dir = versionDir(version)
  return live === dir || live.startsWith(dir + path.sep)
}

/** The cached version a live daemon is currently serving from (for `runtime list`/`clean` UI), or null. */
export function liveRuntimeVersion(): string | null {
  const live = liveRuntimeDir()
  if (!live) return null
  for (const r of listRuntimes()) if (isVersionInUse(r.version, live)) return r.version
  return null
}

/** Keep the newest KEEP_RUNTIMES; delete older — but NEVER a version a live daemon booted from. */
export function pruneRuntimes(keep: number = KEEP_RUNTIMES): string[] {
  const versions = listRuntimes().map((r) => r.version)
  const live = liveRuntimeDir()
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
  const live = liveRuntimeDir()
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

function storeDir(): string {
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
