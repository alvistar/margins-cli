/**
 * Committed-mode file source: read the markdown (and the images it references)
 * out of a git commit rather than off disk, so a sync sends content that matches
 * a real point in git history and git's ignore rules govern what leaves the
 * machine.
 *
 * It returns the same {@link CollectedSyncFiles} shape as the working-tree
 * collector on purpose: the filter, the image scan, the oversized skip, the sort
 * order and the hashing are a single downstream path
 * ({@link collectFromSource}, KTD6), so the two modes differ only in where the
 * bytes came from. What that invariant does NOT claim is byte identity — four
 * measured cases break it, and this module refuses or filters each of them
 * rather than diverging silently. See `REFUSALS` below.
 *
 * ── The two conventions git uses, and why they are pinned here ──────────────
 *
 * `git ls-tree` run from a subdirectory yields cwd-relative paths scoped to that
 * subtree, while the `<rev>:<path>` revision syntax resolves against the
 * REPOSITORY ROOT unless the path is `./`-prefixed. A collector that lists one
 * way and reads the other fails every read — and a spike proved that failure
 * mode produces an EMPTY collection, which the server's absent-path sweep reads
 * as "delete everything" (KTD10).
 *
 * So this module is root-relative throughout: `--full-tree` for the listing
 * (which cannot be flipped by the ambient environment), `<rev>:<rootPath>` for
 * every read, and the sync directory's prefix stripped once, at the edge.
 *
 * The prefix is resolved explicitly rather than inherited, and the environment
 * is scrubbed first, because `GIT_DIR` set without `GIT_WORK_TREE` — IDE git
 * clients, husky wrappers, `git submodule foreach` — makes git believe the cwd
 * IS the repository root. Verified against real git: under that environment
 * `rev-parse --show-prefix` returns empty and `--show-toplevel` returns the
 * subdirectory, so BOTH ways of deriving a prefix from the ambient environment
 * are wrong, and a subdirectory sync would silently widen to the whole repo.
 */
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { collectFromSource, type CollectedSyncFiles, type SyncFileSource } from './collect-sync-files.js'
import { mimeFromPath } from './image-scanner.js'
import { ValidationError } from './errors.js'

export interface CollectCommittedOptions {
  /** The revision to collect. Defaults to `HEAD`; hooks pass an exact object id. */
  rev?: string
  /** Overridable for tests; defaults to the server blob cap. */
  maxBlobSize?: number
}

/** Tree entry modes this collector will read. See REFUSALS for the rest. */
const REGULAR_FILE_MODES = new Set(['100644', '100755'])

/**
 * stdout ceiling for one batched read. The CLI's usual `execSync` idiom cannot
 * be used here at all: its default `maxBuffer` is 1 MB against a 2 MB blob cap,
 * so a single legal-sized image throws `ENOBUFS`, and `encoding: 'utf-8'`
 * corrupts binary content (KTD11). Reads run with an explicit ceiling and raw
 * Buffer output, and an overflow is surfaced rather than silently truncated —
 * spawnSync TRUNCATES on overflow, which would otherwise reach the frame parser
 * as a short read.
 */
const MAX_BATCH_BUFFER = 512 * 1024 * 1024

/**
 * Test-only observability for the two-phase read contract (KTD12): exactly one
 * batch process for markdown, and one for images ONLY when content named some.
 * Exported so that contract is assertable without mocking git — which would
 * defeat the point, since every claim in this module was established by running
 * git, not by reasoning about it.
 *
 * `metadata` counts the one O(1) extra read this module makes: `.marginsignore`
 * out of the commit, which cannot join the markdown batch because the filter it
 * produces is what DECIDES that batch's contents. It is counted rather than
 * ignored so "two batched reads" stays a measured claim, not a definition.
 * None of the three grows with the number of files, which is what the 5,000-file
 * ceiling actually needs.
 */
export const batchReadCounters = { markdown: 0, images: 0, metadata: 0 }

// ─── Running git ─────────────────────────────────────────────────────────────

/**
 * Environment variables that redirect git's repository discovery. They are
 * stripped so `cwd` alone decides which repository we are in and what the
 * prefix is. Object-store and namespace variables are deliberately NOT stripped:
 * they do not affect discovery, and removing them could break reads in a
 * quarantine environment.
 */
const DISCOVERY_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
] as const

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of DISCOVERY_ENV_VARS) delete env[key]
  return env
}

interface GitResult {
  ok: boolean
  stdout: Buffer
  stderr: string
}

function runGit(dir: string, args: string[], input?: string): GitResult {
  const res = spawnSync('git', args, {
    cwd: dir,
    env: gitEnv(),
    ...(input === undefined ? {} : { input }),
    maxBuffer: MAX_BATCH_BUFFER,
    windowsHide: true,
  })
  if (res.error) {
    // ENOENT (no git), ENOBUFS (output over the ceiling — spawnSync truncates,
    // so this must never be mistaken for a short but valid response).
    throw new ValidationError(
      `Could not run git in ${dir} (${(res.error as NodeJS.ErrnoException).code ?? res.error.message}) ` +
      '— nothing was collected or sent.',
    )
  }
  return {
    ok: res.status === 0,
    stdout: res.stdout ?? Buffer.alloc(0),
    stderr: (res.stderr ?? Buffer.alloc(0)).toString('utf-8'),
  }
}

/** Run git, requiring success, and return trimmed stdout as text. */
function gitText(dir: string, args: string[]): string {
  const res = runGit(dir, args)
  if (!res.ok) {
    throw new ValidationError(
      `git ${args.join(' ')} failed in ${dir}: ${res.stderr.trim() || 'unknown error'} ` +
      '— nothing was collected or sent.',
    )
  }
  return res.stdout.toString('utf-8').trim()
}

/** Run git, tolerating a non-zero exit (e.g. `config --get` on an unset key). */
function gitTextOrNull(dir: string, args: string[]): string | null {
  const res = runGit(dir, args)
  return res.ok ? res.stdout.toString('utf-8').trim() : null
}

// ─── The batched read (KTD11) ────────────────────────────────────────────────

/**
 * Read many blobs in ONE `git cat-file --batch` process, framed by the byte
 * length git declares — never by scanning for delimiters, which binary content
 * would break.
 *
 * Returns one entry per requested spec, IN ORDER — `--batch` echoes the object
 * id rather than the spec it was given, so results correlate positionally and
 * never by name. `null` means git reported the spec as unreadable (`missing`,
 * `ambiguous`, …). Callers decide whether that is fatal: it is in phase one,
 * where the specs came from our own tree listing, and it is not in phase two,
 * whose specs came from parsing markdown (KTD12).
 *
 * `--batch` exits 0 even when EVERY requested path is missing — verified
 * against real git — so the exit status proves nothing and the response body is
 * the only evidence there is.
 */
function batchReadBlobs(dir: string, specs: string[]): Array<Buffer | null> {
  if (specs.length === 0) return []

  // stdin is newline-framed (`--batch -z` needs a newer git than we require), so
  // a path containing a newline would silently split into two requests and shift
  // every subsequent positional correlation. Git permits such paths; refuse.
  for (const spec of specs) {
    if (spec.includes('\n') || spec.includes('\r')) {
      throw new ValidationError(
        `Cannot collect a committed tree containing a path with a line break (${JSON.stringify(spec)}) ` +
        '— nothing was collected or sent.',
      )
    }
  }

  const res = runGit(dir, ['cat-file', '--batch'], specs.join('\n') + '\n')
  const out = res.stdout
  const results: Array<Buffer | null> = []
  let offset = 0

  for (let i = 0; i < specs.length; i++) {
    const nl = out.indexOf(0x0a, offset)
    if (nl === -1) {
      throw new ValidationError(
        `git cat-file returned a truncated response while reading ${specs[i]} ` +
        `(${results.length} of ${specs.length} entries) — nothing was collected or sent.`,
      )
    }
    const header = out.toString('utf-8', offset, nl)
    offset = nl + 1

    // `<oid> <type> <size>` for a readable object; anything else (`<spec>
    // missing`, `<spec> ambiguous`) is a failure line with no body following it.
    const match = /^([0-9a-f]{40,64}) ([a-z]+) (\d+)$/.exec(header)
    if (!match) {
      results.push(null)
      continue
    }

    const size = Number(match[3])
    const body = out.subarray(offset, offset + size)
    if (body.length !== size) {
      throw new ValidationError(
        `git cat-file returned ${body.length} of ${size} bytes for ${specs[i]} ` +
        '— nothing was collected or sent.',
      )
    }
    offset += size + 1  // git writes a trailing newline after each body
    results.push(match[2] === 'blob' ? body : null)
  }

  return results
}

// ─── REFUSALS: the cases where committed bytes would diverge silently ────────

/**
 * Refuse a repository whose configuration makes committed bytes differ from
 * what the working tree holds (KTD6). Each of these would otherwise produce a
 * sync that is neither the commit nor the checkout:
 *
 * - `core.autocrlf` `true`/`input` rewrites line endings when content enters the
 *   object store, so the blob and the file on disk are different bytes.
 * - A `text` or `eol` attribute does the same, per path.
 * - A clean/smudge `filter` — git-LFS above all — stores a POINTER STUB in the
 *   object store. Reading the blob would sync a 130-byte text file in place of
 *   the image.
 *
 * `core.eol` is deliberately not checked: it only takes effect on paths whose
 * `text` attribute is set, and those are already refused above.
 *
 * Attributes are resolved with `git check-attr`, i.e. against the attributes in
 * effect for this checkout. That is the correct frame for this question: the
 * divergence being guarded against is between the blob and the file git wrote to
 * disk, and it is the checkout's attributes that governed that write.
 */
/**
 * The repository root, derived from the sync directory and the prefix already
 * resolved for it. Computed rather than asked for: `rev-parse --show-toplevel`
 * is exactly the query that lies under a stray `GIT_DIR` (see the module
 * docblock), and the prefix has already been established safely.
 */
function repoRootOf(dir: string, prefix: string): string {
  const up = prefix.split('/').filter(Boolean).map(() => '..')
  return up.length === 0 ? dir : path.resolve(dir, ...up)
}

function refuseDivergentFilters(root: string, relPaths: string[]): void {
  if (relPaths.length === 0) return

  // ─── Content-substituting filters ────────────────────────────────────────
  // A clean/smudge filter replaces the content outright, so this is not an
  // end-of-line question and cannot be measured as one: an LFS pointer stub is
  // the wrong content even when its line endings agree perfectly.
  const attrs = runGit(root, ['check-attr', '--stdin', '-z', 'filter'], relPaths.join('\0') + '\0')
  if (attrs.ok) {
    // `-z` output is a flat stream of NUL-terminated <path> <attr> <value> triples.
    const fields = attrs.stdout.toString('utf-8').split('\0')
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const filePath = fields[i]!
      const value = fields[i + 2]!
      if (fields[i + 1] !== 'filter' || value === 'unspecified') continue
      throw new ValidationError(
        value === 'lfs'
          ? `${filePath} is tracked by git-LFS, so its committed content is a pointer stub rather ` +
            'than the file itself — a committed sync would upload the stub. Nothing was collected ' +
            'or sent. Use working-tree content mode for this repository.'
          : `${filePath} has a git content filter configured (filter=${value}), so its committed ` +
            'bytes differ from the file on disk. Nothing was collected or sent. Use working-tree ' +
            'content mode for this repository.',
      )
    }
  }

  // ─── End-of-line divergence ──────────────────────────────────────────────
  // Measured, not inferred from configuration. `ls-files --eol` reports each
  // file's line endings as stored in the index (`i/`) and as written to the
  // working tree (`w/`); they differ exactly when a committed sync's bytes
  // would differ from a working-tree sync's, which is the whole concern.
  const eol = runGit(root, ['ls-files', '--eol', '-z', '--', ...relPaths])
  if (!eol.ok) return  // advisory — an unreadable index is caught by the read phase

  for (const record of eol.stdout.toString('utf-8').split('\0')) {
    if (record === '') continue
    // Each record is `i/<eol>  w/<eol>  attr/<text>\t<path>` — path after a TAB,
    // the fields space-padded to a fixed width.
    const tab = record.indexOf('\t')
    if (tab === -1) continue
    const parsed = /^i\/(\S+)\s+w\/(\S+)/.exec(record.slice(0, tab))
    // A file in the index but absent from the working tree reports no `w/`
    // value. There is nothing to diverge from — a working-tree sync could not
    // have sent it either — so it is skipped rather than refused. This is the
    // normal shape of a pre-push syncing a ref the user is not standing on.
    if (!parsed) continue

    const [, indexEol, worktreeEol] = parsed
    // `none` on both sides is a binary file: absence of line endings on each
    // side is agreement, not divergence.
    if (indexEol === worktreeEol) continue

    throw new ValidationError(
      `${record.slice(tab + 1)} has different line endings in the commit (${indexEol}) than in the ` +
      `working tree (${worktreeEol}), so a committed sync's bytes would differ from what you see on ` +
      'disk. Nothing was collected or sent. Normalise the file (`git add --renormalize .` and ' +
      'commit), or use working-tree content mode for this repository.',
    )
  }
}

// ─── Resolving the repository, the prefix, and the commit ────────────────────

interface CommittedContext {
  /** Repo-root-relative prefix of the sync directory: `''` or `docs/`. */
  prefix: string
  /** The resolved object id of the commit being collected. */
  commitSha: string
  gitObjectFormat: 'sha1' | 'sha256'
}

function resolveContext(dir: string, rev: string): CommittedContext {
  const bare = gitTextOrNull(dir, ['rev-parse', '--is-bare-repository'])
  if (bare === null) {
    throw new ValidationError(
      `${dir} is not inside a git repository, so there is no commit to collect — nothing was sent. ` +
      'Committed content mode requires git; use working-tree content mode for a plain folder.',
    )
  }
  if (bare === 'true') {
    // A bare repository has no working tree, so a "sync directory" inside it
    // means nothing: there is no prefix to scope the collection to, and git
    // rejects the `<rev>:./<path>` form outright ("relative path syntax can't be
    // used outside working tree"). Refuse with its own message rather than
    // collecting the whole repository by accident.
    throw new ValidationError(
      `${dir} is a bare git repository, which has no working tree for a sync directory to refer ` +
      'to — nothing was collected or sent. Run the sync from a normal checkout.',
    )
  }
  if (gitTextOrNull(dir, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    throw new ValidationError(
      `${dir} is not inside a git working tree, so there is no commit to collect — nothing was sent.`,
    )
  }

  const rawFormat = gitTextOrNull(dir, ['rev-parse', '--show-object-format'])
  // KTD9: carry the repository's ACTUAL object format; never assume SHA-1. A
  // repository older than `--show-object-format` (pre-2.29) can only be sha1.
  const gitObjectFormat = rawFormat === 'sha256' ? 'sha256' : 'sha1'

  const commitSha = gitTextOrNull(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
  if (!commitSha) {
    // An unborn HEAD is the single most dangerous input this collector can get:
    // it has no tree, so "collect it" would return a legitimate-looking EMPTY
    // manifest, and the server's absent-path sweep reads an empty manifest as
    // "delete every file on the branch". Refuse loudly instead (KTD10).
    const hasAnyCommit = gitTextOrNull(dir, ['rev-list', '-n', '1', '--all'])
    throw new ValidationError(
      hasAnyCommit
        ? `Cannot resolve "${rev}" to a commit in this repository — nothing was collected or sent.`
        : 'This repository has no commits yet, so there is nothing committed to sync — nothing was ' +
          'sent. Make a commit first, or use working-tree content mode.',
    )
  }

  const prefix = gitTextOrNull(dir, ['rev-parse', '--show-prefix']) ?? ''
  return { prefix, commitSha, gitObjectFormat }
}

// ─── The listing ─────────────────────────────────────────────────────────────

interface TreeListing {
  /** Every regular-file path in the commit, DIR-relative, under the prefix. */
  listed: Set<string>
  /** The markdown subset, sorted the way the working-tree walker sorts. */
  mdPaths: string[]
}

/**
 * List the commit's regular files, scoped to the sync directory.
 *
 * `--full-tree` makes the listing root-relative and repository-wide regardless
 * of cwd, so the output shape cannot be flipped by the environment; the prefix
 * scoping is then applied here, against the prefix we resolved explicitly.
 *
 * Non-regular modes never enter collection (KTD6):
 *   - `120000` symlink — its blob content is the link's TARGET PATH, so a
 *     symlinked `foo.md` would sync as a markdown file whose entire content is
 *     the string `bar.md`. Verified against real git.
 *   - `160000` submodule (type `commit`) — its blob read returns `missing`,
 *     which under phase one's fatal rule would abort every committed sync in
 *     any repository containing a submodule, permanently. Verified against real
 *     git.
 */
function listTree(dir: string, ctx: CommittedContext): TreeListing {
  const raw = gitText(dir, ['ls-tree', '-r', '-z', '--full-tree', ctx.commitSha])
  const listed = new Set<string>()
  const mdPaths: string[] = []

  for (const entry of raw.split('\0')) {
    if (!entry) continue
    const tab = entry.indexOf('\t')
    if (tab === -1) continue
    const mode = entry.slice(0, entry.indexOf(' '))
    if (!REGULAR_FILE_MODES.has(mode)) continue

    const rootPath = entry.slice(tab + 1)
    if (ctx.prefix && !rootPath.startsWith(ctx.prefix)) continue
    const relPath = rootPath.slice(ctx.prefix.length)
    if (!relPath) continue

    listed.add(relPath)
    if (relPath.endsWith('.md')) mdPaths.push(relPath)
  }

  // Match the working-tree walker's ordering exactly: it sorts the joined
  // relative paths with a plain lexicographic sort, and git's tree order is not
  // the same comparison. Both sources must agree on order.
  return { listed, mdPaths: mdPaths.sort() }
}

// ─── The source ──────────────────────────────────────────────────────────────

function committedSource(
  dir: string,
  ctx: CommittedContext,
  listing: TreeListing,
): SyncFileSource {
  const spec = (relPath: string): string => `${ctx.commitSha}:${ctx.prefix}${relPath}`

  return {
    // Only used to resolve markdown-relative image references into
    // directory-relative paths; the scanner does not read through it for
    // content. It does consult the filesystem to reject symlinked references,
    // which for committed mode is the one place the checkout still shows
    // through — see the note in collectCommittedFiles.
    scanRoot: dir,

    list: () => {
      // `.marginsignore` comes from the COMMIT, never from disk. Reading the
      // checkout's copy would filter commit X by whatever happens to be checked
      // out, so the same commit pushed from two machines — or a pre-push of a
      // branch whose ignore file differs from the checkout — would send
      // different file sets under one git sha.
      let ignoreText: string | null = null
      if (listing.listed.has('.marginsignore')) {
        batchReadCounters.metadata++
        const [blob] = batchReadBlobs(dir, [spec('.marginsignore')])
        if (!blob) {
          throw new ValidationError(
            'The commit lists a .marginsignore that could not be read — nothing was collected or ' +
            'sent, because collecting under the wrong filter would send the wrong files.',
          )
        }
        ignoreText = blob.toString('utf-8')
      }
      return { mdPaths: listing.mdPaths, ignoreText }
    },

    // Phase one. Every path here came from our own tree listing, so a miss means
    // the listing and the read disagree — a bug in this module. Skipping it is
    // what turns a one-token path bug into an empty manifest, which the server's
    // absent-path sweep reads as "delete everything" (KTD10). Fatal.
    readMarkdown: (relPaths) => {
      if (relPaths.length === 0) return new Map()
      batchReadCounters.markdown++
      const blobs = batchReadBlobs(dir, relPaths.map(spec))
      const out = new Map<string, Buffer>()
      relPaths.forEach((relPath, i) => {
        const blob = blobs[i]
        if (!blob) {
          throw new ValidationError(
            `${relPath} is listed in the commit being synced but its content could not be read ` +
            '— nothing was collected or sent. Sending the rest would have published a manifest ' +
            'missing that file, which deletes it on the server.',
          )
        }
        out.set(relPath, blob)
      })
      return out
    },

    // Phase two. These paths came from the image scanner, which deliberately
    // emits references that may not resolve. Applying phase one's fatal rule
    // here would let ONE stale image link in one markdown file abort every
    // committed sync in the repository, permanently — so unlisted references are
    // skipped, exactly as the filesystem source skips ones that do not exist.
    readImages: (relPaths) => {
      const present = relPaths.filter((relPath) => listing.listed.has(relPath))
      if (present.length === 0) return new Map()
      batchReadCounters.images++
      const blobs = batchReadBlobs(dir, present.map(spec))
      const out = new Map<string, Buffer>()
      present.forEach((relPath, i) => {
        const blob = blobs[i]
        if (blob) out.set(relPath, blob)
      })
      return out
    },
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Collect the syncable files of a commit, scoped to `dir`.
 *
 * Residual asymmetry, recorded deliberately: the shared image scanner rejects a
 * reference whose path is a symlink ON DISK. In committed mode the disk is not
 * authoritative, so an image that is a regular blob in the commit but a symlink
 * in the current checkout is dropped. The effect is a missing image, never wrong
 * content, and the scanner is shared on purpose (KTD6) — adapting it is a wider
 * change than this unit owns.
 */
export function collectCommittedFiles(
  dir: string,
  opts: CollectCommittedOptions = {},
): CollectedSyncFiles {
  const ctx = resolveContext(dir, opts.rev ?? 'HEAD')
  const listing = listTree(dir, ctx)

  // Refuse before a single blob is read. The check covers what this collector
  // could send — markdown plus anything with a syncable image mime — rather than
  // every path in the repository, so an LFS-tracked archive nobody syncs does
  // not refuse a markdown sync.
  const collectable = [...listing.listed].filter(
    (relPath) => relPath.endsWith('.md') || mimeFromPath(relPath) !== null,
  )
  // Run from the repository ROOT, because `listed` holds root-relative paths
  // (--full-tree) while `dir` may be a subdirectory. git resolves both pathspecs
  // and check-attr's stdin paths against the cwd, so passing root-relative paths
  // from a nested cwd would silently match nothing and check nothing.
  refuseDivergentFilters(repoRootOf(dir, ctx.prefix), collectable)

  const collected = collectFromSource(committedSource(dir, ctx, listing), opts)

  // Git provenance rides ALONGSIDE the content-derived sha, never in place of it
  // (wire contract §6): `commitSha`/`parentSha` stay sha256-over-the-sorted-
  // manifest, because the manifest is a FILTERED subset of the commit and the
  // idempotency and divergence checks depend on sha-means-content.
  return {
    ...collected,
    gitProvenance: { gitCommitSha: ctx.commitSha, gitObjectFormat: ctx.gitObjectFormat },
  }
}
