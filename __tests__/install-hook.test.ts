/**
 * Hook installation + hook EXECUTION (U6).
 *
 * The scenarios this unit exists for — ref-line parsing, tag skipping,
 * remote-name mapping, resolving the object id before backgrounding, and
 * installing into a linked worktree or a submodule — are only observable when a
 * hook actually runs. A string assertion over the generated script passes
 * happily while the hook is broken, so the tests below install the hook into a
 * REAL temporary git repository and let real `git commit` / `git push` fire it,
 * with a fake `margins` on PATH recording exactly what the hook invoked.
 *
 * Fixtures pin `core.autocrlf=false` and an explicit identity for the same
 * reason `collect-committed-files.test.ts` does: the developer's global
 * ~/.gitconfig otherwise leaks into the result.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { handleInstallHook } from '../src/commands/install-hook.js'
import { parsePrePushRefs } from '../src/commands/workspace/push.js'

let tmpDir: string
let originalCwd: string
let scratch: string[]

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-install-hook-'))
  originalCwd = process.cwd()
  scratch = [tmpDir]
  initRepo(tmpDir)
  process.chdir(tmpDir)
})

afterEach(() => {
  process.chdir(originalCwd)
  for (const d of scratch) fs.rmSync(d, { recursive: true, force: true })
})

// ─── Real-git helpers ────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...hookEnv },
  })
}

/**
 * Run a git command that FIRES A HOOK, letting the hook's background process
 * truly detach.
 *
 * This matters and is not a detail. `execFileSync` with piped stdio waits for
 * the pipes to reach EOF, not merely for git to exit — and a hook's backgrounded
 * child inherits those pipes. Capturing output therefore makes the parent block
 * until the "non-blocking" background sync finishes, which silently serializes
 * the very race these tests exist to catch: a mutant post-commit hook that
 * resolves `HEAD` in the background still passed, because the harness would not
 * let the second commit start until the first hook's background work was done.
 */
function gitFire(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, ...hookEnv } })
}

/** Extra env every git invocation inherits — set by `useFakeMargins()`. */
let hookEnv: NodeJS.ProcessEnv = {}

function initRepo(cwd: string): void {
  fs.mkdirSync(cwd, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd, stdio: 'ignore' })
  for (const kv of [
    ['user.email', 'test@margins.test'],
    ['user.name', 'Margins Test'],
    ['core.autocrlf', 'false'],
    ['commit.gpgsign', 'false'],
  ]) {
    execFileSync('git', ['config', kv[0]!, kv[1]!], { cwd, stdio: 'ignore' })
  }
}

function mkdtemp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  scratch.push(d)
  return d
}

function write(cwd: string, rel: string, content: string): void {
  const full = path.join(cwd, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

function commit(cwd: string, msg: string): string {
  git(['add', '-A'], cwd)
  gitFire(['commit', '-q', '-m', msg], cwd)
  return git(['rev-parse', 'HEAD'], cwd).trim()
}

/**
 * Put a fake `margins` first on PATH. Every invocation writes its argv to a
 * fresh JSON file in a log directory, so a backgrounded hook that fires more
 * than once (a multi-ref push) is recorded once per invocation and argument
 * values containing newlines — the pre-push refs blob is exactly that — survive
 * intact.
 */
function useFakeMargins(): {
  calls: () => string[][]
  waitFor: (n: number) => Promise<string[][]>
  /** The fake binary itself, so harness-invariant tests can drive it without git. */
  marginsBin: string
  /** The log directory, so a test can plant a decoy record in it. */
  logDir: string
} {
  const binDir = mkdtemp('margins-fakebin-')
  const logDir = mkdtemp('margins-fakelog-')
  const recorder = path.join(binDir, 'record.cjs')
  fs.writeFileSync(
    recorder,
    // Write to a temp sibling and rename into place. `rename(2)` within one
    // directory is atomic, so a reader polling this directory either does not
    // see the record or sees it whole — it can never read a half-written one.
    // Plain writeFileSync makes the file visible at its final name the moment it
    // is created, before the contents land.
    `const fs=require('fs'),path=require('path');\n` +
    `const base=process.pid+'-'+Date.now()+'-'+Math.random().toString(36).slice(2)+'.json';\n` +
    `const tmp=path.join(${JSON.stringify(logDir)}, base+'.tmp');\n` +
    `fs.writeFileSync(tmp, JSON.stringify(process.argv.slice(2)));\n` +
    `fs.renameSync(tmp, path.join(${JSON.stringify(logDir)}, base));\n`,
  )
  fs.writeFileSync(
    path.join(binDir, 'margins'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)} "$@"\n`,
    { mode: 0o755 },
  )
  hookEnv = { PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}` }

  /** Completed records only — an in-flight `.json.tmp` is not a record yet. */
  const recordFiles = (): string[] =>
    fs.readdirSync(logDir).filter((f) => f.endsWith('.json')).sort()

  const calls = (): string[][] =>
    recordFiles()
      .map((f) => JSON.parse(fs.readFileSync(path.join(logDir, f), 'utf-8')) as string[])

  const waitFor = async (n: number): Promise<string[][]> => {
    const deadline = Date.now() + 10_000
    for (;;) {
      const c = calls()
      if (c.length >= n) return c
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${n} margins invocation(s); saw ${c.length}`)
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  return { calls, waitFor, marginsBin: path.join(binDir, 'margins'), logDir }
}

// ─── Harness invariants ──────────────────────────────────────────────────────
//
// These do not test the hook. They test `useFakeMargins` itself, because two
// intermittent suite failures were traced to the harness rather than to the code
// under test, and a harness defect looks exactly like a flaky feature.

describe('fake-margins recorder', () => {
  // A record is written under a temp name and renamed into place, so the reader
  // sees a record only once it is complete. Planting the in-flight name is the
  // deterministic form of "the reader caught a write mid-flight" — the timing
  // window that motivates this is real but far too narrow to provoke on demand
  // (measured at ~69 short reads in 3.4M stat samples, with payloads ~20x larger
  // than a real invocation's).
  it('ignores a record that is still being written', () => {
    const fake = useFakeMargins()
    fs.writeFileSync(path.join(fake.logDir, '999999-1-inflight.json.tmp'), '["hook-sync","--re')

    expect(() => fake.calls()).not.toThrow()
    expect(fake.calls()).toHaveLength(0)
  })

  it('records every concurrent invocation exactly once', async () => {
    const fake = useFakeMargins()
    const N = 40
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        new Promise<void>((resolve, reject) => {
          execFile(fake.marginsBin, ['hook-sync', '--rev', String(i)], (err) =>
            err ? reject(err) : resolve())
        })),
    )

    const seen = fake.calls().map((c) => flag(c, '--rev'))
    expect(seen.sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: N }, (_, i) => String(i)),
    )
  })
})

/** Read `--flag`'s value out of a recorded argv. */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

/** A bare repository usable as a push target, plus the branch pointed at it. */
function addRemote(cwd: string): string {
  const remote = mkdtemp('margins-remote-')
  execFileSync('git', ['init', '-q', '--bare', '.'], { cwd: remote, stdio: 'ignore' })
  git(['remote', 'add', 'origin', remote], cwd)
  return remote
}

// ─── Generated-script shape (as asserted today) ──────────────────────────────

describe('handleInstallHook — generated script', () => {
  it('generates a pre-push hook that calls `margins workspace ...` (not `margins push`)', async () => {
    await handleInstallHook({})
    const hook = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-push'), 'utf-8')
    // The CLI only registers subcommands under `margins workspace`. A bare
    // `margins push` errors with `unknown command 'push'`, silently failing the hook.
    expect(hook).toContain('margins workspace hook-sync')
    expect(hook).not.toMatch(/^margins push\b/m)
  })

  it('passes --branch, which `workspace push` and `hook-sync` both register', async () => {
    // REGRESSION, deliberate inversion. This assertion used to demand the hook
    // contain NO `--branch`, on the strength of a comment claiming `workspace
    // push` would reject the flag. It does not — `--branch <branch>` has been
    // registered on the command all along (src/index.ts), and detecting the
    // branch from `rev-parse --abbrev-ref HEAD` inside the background push is
    // the very bug U6 exists to fix: it syncs the checkout you are standing on
    // rather than the ref git named.
    await handleInstallHook({ on: 'commit' })
    const hook = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf-8')
    expect(hook).toContain('--branch')
  })

  it('generates an executable pre-push hook by default', async () => {
    await handleInstallHook({})
    const stat = fs.statSync(path.join(tmpDir, '.git', 'hooks', 'pre-push'))
    expect(stat.mode & 0o111).not.toBe(0)
  })

  it('runs the sync in the background and exits 0 (non-blocking)', async () => {
    await handleInstallHook({})
    const hook = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-push'), 'utf-8')
    expect(hook).toMatch(/&\s*$/m)
    expect(hook).toMatch(/^exit 0$/m)
  })

  it('with --on commit, installs a post-commit hook instead', async () => {
    await handleInstallHook({ on: 'commit' })
    expect(fs.existsSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, '.git', 'hooks', 'pre-push'))).toBe(false)
    const hook = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf-8')
    expect(hook).toContain('margins workspace hook-sync')
  })

  it('reads stdin before backgrounding anything', async () => {
    // Executed end to end below (the refs a real `git push` supplies arrive
    // intact); asserted here too because the ORDER is the invariant — git closes
    // the hook's stdin the moment the hook exits, so a `cat` that runs after the
    // `&` reads from a pipe nobody is writing to any more.
    await handleInstallHook({})
    const hook = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-push'), 'utf-8')
    const readAt = hook.indexOf('$(cat)')
    const bgAt = hook.search(/^margins .*&$/m)
    expect(readAt).toBeGreaterThan(-1)
    expect(bgAt).toBeGreaterThan(readAt)
  })

  it('does not bake a content mode into the hook (the workspace decides)', async () => {
    await handleInstallHook({})
    const hook = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-push'), 'utf-8')
    expect(hook).not.toContain('--content-mode')
  })
})

// ─── Hooks EXECUTED by real git ──────────────────────────────────────────────

describe('post-commit hook, executed by real git', () => {
  it('resolves the object id synchronously — a commit made immediately after does not change what was synced', async () => {
    const fake = useFakeMargins()
    await handleInstallHook({ on: 'commit' })

    write(tmpDir, 'a.md', '# one\n')
    const first = commit(tmpDir, 'first')

    // The hook backgrounds its sync. Commit AGAIN right away: if the hook had
    // handed a literal `HEAD` to the background process, the background process
    // would resolve it to THIS commit instead.
    write(tmpDir, 'b.md', '# two\n')
    const second = commit(tmpDir, 'second')
    expect(second).not.toBe(first)

    const calls = await fake.waitFor(2)
    const revs = calls.map((c) => flag(c, '--rev'))
    expect(revs).toContain(first)
    expect(revs).toContain(second)
    // Neither invocation was handed a symbolic ref to resolve later.
    for (const c of calls) expect(flag(c, '--rev')).toMatch(/^[0-9a-f]{40,64}$/)
  })

  it('names the branch the commit was made on', async () => {
    const fake = useFakeMargins()
    await handleInstallHook({ on: 'commit' })
    git(['checkout', '-q', '-b', 'feature-x'], tmpDir)
    write(tmpDir, 'a.md', '# one\n')
    commit(tmpDir, 'first')

    const calls = await fake.waitFor(1)
    expect(flag(calls[0]!, '--branch')).toBe('feature-x')
    expect(calls[0]).toContain('hook-sync')
  })
})

describe('pre-push hook, executed by real git', () => {
  it('syncs to the REMOTE branch name when it differs from the local one (R7)', async () => {
    const fake = useFakeMargins()
    await handleInstallHook({})
    addRemote(tmpDir)

    write(tmpDir, 'a.md', '# one\n')
    const sha = commit(tmpDir, 'first')
    git(['branch', 'local-name'], tmpDir)
    // Standing on `main`, push `local-name` to a differently-named remote branch.
    gitFire(['push', '-q', 'origin', 'local-name:remote-name'], tmpDir)

    const calls = await fake.waitFor(1)
    const refs = flag(calls[0]!, '--refs')!
    // The bytes below came out of real git, through the installed hook.
    expect(refs).toContain('refs/heads/remote-name')
    expect(refs).toContain(sha)

    const planned = parsePrePushRefs(refs)
    expect(planned).toEqual([{ rev: sha, branch: 'remote-name' }])
  })

  it('produces no sync for a tag push (R7)', async () => {
    const fake = useFakeMargins()
    await handleInstallHook({})
    addRemote(tmpDir)
    write(tmpDir, 'a.md', '# one\n')
    commit(tmpDir, 'first')
    gitFire(['push', '-q', 'origin', 'main'], tmpDir)
    const afterBranchPush = (await fake.waitFor(1)).length

    git(['tag', 'v1'], tmpDir)
    gitFire(['push', '-q', 'origin', 'v1'], tmpDir)

    const calls = await fake.waitFor(afterBranchPush + 1)
    const tagCall = calls[calls.length - 1]!
    const refs = flag(tagCall, '--refs')!
    expect(refs).toContain('refs/tags/v1')
    expect(parsePrePushRefs(refs)).toEqual([])
  })

  it('produces no sync for a branch deletion (R7)', async () => {
    const fake = useFakeMargins()
    await handleInstallHook({})
    addRemote(tmpDir)
    write(tmpDir, 'a.md', '# one\n')
    commit(tmpDir, 'first')
    git(['branch', 'doomed'], tmpDir)
    gitFire(['push', '-q', 'origin', 'main', 'doomed'], tmpDir)
    const before = (await fake.waitFor(1)).length

    gitFire(['push', '-q', 'origin', ':doomed'], tmpDir)

    const calls = await fake.waitFor(before + 1)
    const refs = flag(calls[calls.length - 1]!, '--refs')!
    expect(refs).toContain('refs/heads/doomed')
    expect(refs).toMatch(/(^| )0{40,64}( |$)/m)
    expect(parsePrePushRefs(refs)).toEqual([])
  })

  it('carries every ref of a multi-ref push in one invocation', async () => {
    const fake = useFakeMargins()
    await handleInstallHook({})
    addRemote(tmpDir)
    write(tmpDir, 'a.md', '# one\n')
    const shaA = commit(tmpDir, 'first')
    git(['checkout', '-q', '-b', 'two'], tmpDir)
    write(tmpDir, 'b.md', '# two\n')
    const shaB = commit(tmpDir, 'second')

    gitFire(['push', '-q', 'origin', 'main', 'two'], tmpDir)

    const calls = await fake.waitFor(1)
    const planned = parsePrePushRefs(flag(calls[0]!, '--refs')!)
    expect(planned.map((p) => p.branch).sort()).toEqual(['main', 'two'])
    expect(planned.find((p) => p.branch === 'main')!.rev).toBe(shaA)
    expect(planned.find((p) => p.branch === 'two')!.rev).toBe(shaB)
  })
})

// ─── Hooks directory resolution (the ENOTDIR fix) ────────────────────────────

describe('hooks directory resolution', () => {
  it('installs into a linked worktree, where .git is a FILE', async () => {
    write(tmpDir, 'a.md', '# one\n')
    commit(tmpDir, 'first')
    const wt = path.join(mkdtemp('margins-wt-parent-'), 'wt')
    git(['worktree', 'add', '-q', wt, '-b', 'wt-branch'], tmpDir)
    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true)

    process.chdir(wt)
    await handleInstallHook({ force: true })

    // Worktrees share the main repository's hooks directory.
    const shared = path.join(tmpDir, '.git', 'hooks', 'pre-push')
    expect(fs.existsSync(shared)).toBe(true)
    expect(fs.statSync(shared).mode & 0o111).not.toBe(0)
    // And nothing was written into the worktree's own .git FILE path.
    expect(fs.existsSync(path.join(wt, '.git', 'hooks'))).toBe(false)
  })

  it('installs into a submodule, where .git is also a FILE', async () => {
    write(tmpDir, 'a.md', '# one\n')
    commit(tmpDir, 'first')

    const outer = mkdtemp('margins-outer-')
    initRepo(outer)
    write(outer, 'r.md', '# root\n')
    commit(outer, 'root')
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', tmpDir, 'mods'], outer)
    const sub = path.join(outer, 'mods')
    expect(fs.statSync(path.join(sub, '.git')).isFile()).toBe(true)

    process.chdir(sub)
    await handleInstallHook({ force: true })

    const expected = path.join(outer, '.git', 'modules', 'mods', 'hooks', 'pre-push')
    expect(fs.existsSync(expected)).toBe(true)
  })

  it('installs from a subdirectory of the working tree', async () => {
    write(tmpDir, 'docs/a.md', '# one\n')
    commit(tmpDir, 'first')
    process.chdir(path.join(tmpDir, 'docs'))
    await handleInstallHook({ force: true })
    expect(fs.existsSync(path.join(tmpDir, '.git', 'hooks', 'pre-push'))).toBe(true)
  })

  it('reads .margins.json from the repository root, not the cwd', async () => {
    fs.writeFileSync(path.join(tmpDir, '.margins.json'), JSON.stringify({ syncMode: 'server' }))
    write(tmpDir, 'docs/a.md', '# one\n')
    commit(tmpDir, 'first')
    process.chdir(path.join(tmpDir, 'docs'))
    await handleInstallHook({ force: true })
    // Server-sync workspaces need no hook — nothing installed.
    expect(fs.existsSync(path.join(tmpDir, '.git', 'hooks', 'pre-push'))).toBe(false)
  })
})
