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
    if (/\b(401|403)\b|Unauthorized|Forbidden|Permission/i.test(s)) return new RuntimeAuthError()
    if (/\b404\b|Not Found|E404/i.test(s)) return new RuntimeNotPublishedError()
    return new RuntimeInstallError(err.message.split('\n')[0] || 'npm install failed')
  }
  return new RuntimeInstallError(err instanceof Error ? err.message : String(err))
}

// ─── version resolution ─────────────────────────────────────────────────────
/** The latest published runtime version (private registry, authed). 404 → not-published. */
export async function resolveRuntimeVersion(token: string): Promise<string> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-npmrc-'))
  const npmrc = path.join(tmp, '.npmrc')
  try {
    fs.writeFileSync(npmrc, npmrcContent(token))
    return await npmViewVersion(RUNTIME_PKG, npmrc)
  } catch (err) {
    throw classifyInstallError(err)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// ─── per-version install lock (concurrency) ───────────────────────────────────
async function withVersionLock<T>(version: string, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(runtimeRoot(), { recursive: true })
  const lock = path.join(runtimeRoot(), `.lock-${version}`)
  for (let i = 0; i < 600; i++) {
    // ~60s
    try {
      const fd = fs.openSync(lock, 'wx') // O_EXCL — fails if another holder exists
      fs.writeFileSync(fd, String(process.pid))
      fs.closeSync(fd)
      try {
        return await fn()
      } finally {
        fs.rmSync(lock, { force: true })
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // held by another install: if the runtime appeared meanwhile, the caller re-checks.
      if (isInstalled(version)) return fn() // fn() re-checks and returns the cached path
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new RuntimeInstallError(`timed out waiting for a concurrent install of ${version}`)
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

  let version: string
  if (opts.version) {
    version = opts.version
  } else {
    try {
      version = await resolveRuntimeVersion(token)
    } catch (err) {
      // Offline / not-yet-published: fall back to the newest cached runtime if we have one,
      // so `margins open` still works without the registry.
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
      fs.writeFileSync(path.join(tmp, '.npmrc'), npmrcContent(token))
      fs.writeFileSync(
        path.join(tmp, 'package.json'),
        JSON.stringify({ name: 'margins-runtime-cache', private: true }) + '\n',
      )
      opts.log?.(`Installing Margins Light runtime ${version}…`)
      await npmInstall(`${RUNTIME_PKG}@${version}`, tmp, path.join(tmp, '.npmrc'))
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

/** Keep the newest KEEP_RUNTIMES; delete older. The non-deferrable slice (KTD, plan U7). */
export function pruneRuntimes(keep: number = KEEP_RUNTIMES): string[] {
  const versions = listRuntimes().map((r) => r.version)
  const removed: string[] = []
  for (const v of versions.slice(keep)) {
    fs.rmSync(versionDir(v), { recursive: true, force: true })
    removed.push(v)
  }
  return removed
}

/** Remove all cached runtimes except the active one (or all if none active). */
export function cleanRuntimes(keepVersion?: string): string[] {
  const removed: string[] = []
  for (const r of listRuntimes()) {
    if (r.version === keepVersion) continue
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
