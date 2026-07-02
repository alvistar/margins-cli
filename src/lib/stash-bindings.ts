import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from './config.js'

// ─── Stash bindings (stash update path R10/R13) ───────────────────────────────
//
// The CLI's remembered file→stash identity: re-running `margins stash <file>`
// on a bound file UPDATES the existing stash instead of forking a duplicate.
//
// Hybrid store resolution, per file:
//   • Inside a project (a walk-up hit on `.margins.json` or `.git`):
//     `<root>/.margins/stash-bindings.json`, keyed by the file's ROOT-RELATIVE
//     path — relocatable when the repo directory moves. Gitignored on first
//     write (bindings are per-account and must never be committed).
//   • Outside any project: `stash-bindings.json` next to the global config,
//     keyed by ABSOLUTE path.
//
// Trust (R13): honoring a binding is an overwrite capability, so bindings the
// CLI did not itself record (e.g. a committed/planted project file in a fresh
// clone) are untrusted until the user confirms once. Acceptance is remembered
// per stash slug in the GLOBAL file only — machine-local, never committed —
// and bindings written by this CLI are auto-accepted at write time.
//
// Corrupt or future-versioned files degrade to empty with a warning — never a
// crash; the next bind rewrites a valid v1 file.

const BINDINGS_VERSION = 1
const PROJECT_DIRNAME = '.margins'
const BINDINGS_BASENAME = 'stash-bindings.json'

export interface StashBinding {
  slug: string
  workspaceId: string
}

interface BindingsFile {
  version: number
  bindings: Record<string, StashBinding>
  /** Global file only: per-slug trust acceptances (R13). */
  accepted?: Record<string, true>
}

export interface ResolvedBindingStore {
  kind: 'project' | 'global'
  /** Absolute path of the bindings file. */
  storePath: string
  /** Binding key for the file this store was resolved for. */
  key: string
  /** Project root when kind === 'project'. */
  root?: string
}

function emptyFile(): BindingsFile {
  return { version: BINDINGS_VERSION, bindings: {} }
}

/** Walk up from `dir` for a project root: the first directory containing
 *  `.margins.json` (a Margins-synced project) or `.git` (any repo). */
function findProjectRoot(dir: string): string | null {
  let cur = path.resolve(dir)
  const fsRoot = path.parse(cur).root
  while (true) {
    if (fs.existsSync(path.join(cur, '.margins.json')) || fs.existsSync(path.join(cur, '.git'))) {
      return cur
    }
    if (cur === fsRoot) return null
    cur = path.dirname(cur)
  }
}

/** Resolve which store (and key) governs a given document file. */
export function resolveBindingStore(filePath: string): ResolvedBindingStore {
  const abs = path.resolve(filePath)
  const root = findProjectRoot(path.dirname(abs))
  if (root) {
    return {
      kind: 'project',
      storePath: path.join(root, PROJECT_DIRNAME, BINDINGS_BASENAME),
      key: path.relative(root, abs),
      root,
    }
  }
  return {
    kind: 'global',
    storePath: globalBindingsPath(),
    key: abs,
  }
}

function globalBindingsPath(): string {
  return path.join(getConfigDir(), BINDINGS_BASENAME)
}

/** Tolerant read: a missing, corrupt, wrong-shape, or future-versioned file
 *  behaves as empty (with a one-line warning for the corrupt/future cases). */
function readBindingsFile(storePath: string): BindingsFile {
  let raw: string
  try {
    raw = fs.readFileSync(storePath, 'utf-8')
  } catch {
    return emptyFile() // missing — the normal first-run case
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BindingsFile> | null
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.version !== 'number' ||
      typeof parsed.bindings !== 'object' ||
      parsed.bindings === null
    ) {
      console.error(`Warning: ${storePath} is not a valid stash-bindings file; treating it as empty.`)
      return emptyFile()
    }
    if (parsed.version !== BINDINGS_VERSION) {
      console.error(
        `Warning: ${storePath} has unsupported version ${parsed.version} (this CLI supports ${BINDINGS_VERSION}); treating it as empty.`,
      )
      return emptyFile()
    }
    return { version: BINDINGS_VERSION, bindings: parsed.bindings as Record<string, StashBinding>, ...(parsed.accepted ? { accepted: parsed.accepted as Record<string, true> } : {}) }
  } catch {
    console.error(`Warning: ${storePath} is corrupt; treating it as empty. The next stash rewrites it.`)
    return emptyFile()
  }
}

function writeBindingsFile(storePath: string, file: BindingsFile): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true })
  fs.writeFileSync(storePath, `${JSON.stringify(file, null, 2)}\n`, 'utf-8')
}

/** Look up the binding for a document file, if any. */
export function lookupBinding(filePath: string): { store: ResolvedBindingStore; binding: StashBinding } | null {
  const store = resolveBindingStore(filePath)
  const file = readBindingsFile(store.storePath)
  const binding = file.bindings[store.key]
  return binding ? { store, binding } : null
}

/** Record (or replace) the binding for a document file. Bindings written by
 *  this CLI are auto-accepted (R13). Project-local first-writes append the
 *  store to .gitignore, idempotently. */
export function recordBinding(filePath: string, binding: StashBinding): ResolvedBindingStore {
  const store = resolveBindingStore(filePath)
  const file = readBindingsFile(store.storePath)
  file.bindings[store.key] = binding
  writeBindingsFile(store.storePath, file)
  recordAcceptance(binding.slug)
  if (store.kind === 'project' && store.root) ensureGitignored(store.root)
  return store
}

/** Remove a binding (e.g. after declining an untrusted one and forking fresh). */
export function removeBinding(filePath: string): void {
  const store = resolveBindingStore(filePath)
  const file = readBindingsFile(store.storePath)
  if (store.key in file.bindings) {
    delete file.bindings[store.key]
    writeBindingsFile(store.storePath, file)
  }
}

// ─── Trust acceptances (R13, global file only) ────────────────────────────────

export function isAccepted(slug: string): boolean {
  const file = readBindingsFile(globalBindingsPath())
  return file.accepted?.[slug] === true
}

export function recordAcceptance(slug: string): void {
  const storePath = globalBindingsPath()
  const file = readBindingsFile(storePath)
  file.accepted = { ...(file.accepted ?? {}), [slug]: true }
  writeBindingsFile(storePath, file)
}

// ─── .gitignore upkeep ────────────────────────────────────────────────────────

const GITIGNORE_ENTRY = `${PROJECT_DIRNAME}/${BINDINGS_BASENAME}`

/** Append the project bindings file to .gitignore once (idempotent). Also
 *  satisfied by a broader existing rule that ignores the whole .margins dir. */
function ensureGitignored(root: string): void {
  const gitignorePath = path.join(root, '.gitignore')
  let existing = ''
  try {
    existing = fs.readFileSync(gitignorePath, 'utf-8')
  } catch {
    // no .gitignore yet — create one below
  }
  const lines = existing.split('\n').map((l) => l.trim())
  const covered = lines.some(
    (l) => l === GITIGNORE_ENTRY || l === `/${GITIGNORE_ENTRY}` || l === PROJECT_DIRNAME || l === `${PROJECT_DIRNAME}/` || l === `/${PROJECT_DIRNAME}/` || l === `/${PROJECT_DIRNAME}`,
  )
  if (covered) return
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
  fs.writeFileSync(
    gitignorePath,
    `${existing}${sep}\n# Margins stash bindings are per-account — never commit them.\n${GITIGNORE_ENTRY}\n`,
    'utf-8',
  )
}
