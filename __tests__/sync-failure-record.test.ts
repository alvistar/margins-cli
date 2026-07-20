/**
 * The failure record (U7) — how a background sync that failed becomes findable.
 *
 * The hooks exit 0 so git is never blocked, which is exactly what makes a
 * refusal invisible: nothing is left behind and no exit code survives. A local
 * hook therefore writes a record in the CLI's OWN data directory, and the next
 * foreground `margins` command reports it once and clears it.
 *
 * Two properties are load-bearing and are asserted directly rather than implied:
 *
 *  - the record NEVER lands inside the user's project (it would show up in
 *    `git status`, and could be committed);
 *  - `MARGINS_DATA_DIR` fully isolates it, so a test run cannot touch — or
 *    report from — the developer's real state.
 *
 * CI gets no record at all. A runner is a fresh container destroyed with the
 * job, so the file does not survive and no foreground command follows it; the
 * only channel it has is a non-zero exit and the job log, so the tests at the
 * bottom drive the real CLI binary and assert the exit CODE and the MESSAGE.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

let dataDir: string
let projectDir: string
let prevDataDir: string | undefined
const CI_VARS = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'TF_BUILD']
let prevCi: Record<string, string | undefined> = {}

beforeEach(() => {
  prevDataDir = process.env['MARGINS_DATA_DIR']
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-failrec-data-'))
  process.env['MARGINS_DATA_DIR'] = dataDir
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-failrec-proj-'))
  // This suite asserts LOCAL (non-CI) behaviour by default. The repository's own
  // CI sets CI=true, which would otherwise flip every one of these tests onto
  // the CI branch and silently invert what they claim to prove.
  prevCi = {}
  for (const v of CI_VARS) {
    prevCi[v] = process.env[v]
    delete process.env[v]
  }
})

afterEach(() => {
  if (prevDataDir === undefined) delete process.env['MARGINS_DATA_DIR']
  else process.env['MARGINS_DATA_DIR'] = prevDataDir
  for (const v of CI_VARS) {
    if (prevCi[v] === undefined) delete process.env[v]
    else process.env[v] = prevCi[v]!
  }
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(projectDir, { recursive: true, force: true })
})

/** Every file under a directory, relative and sorted — the project-dir probe. */
function tree(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, prefix: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(d, e.name), rel)
      else out.push(rel)
    }
  }
  walk(dir, '')
  return out
}

function fail(branch: string, cause: string) {
  return { branch, rev: 'a'.repeat(40), ok: false as const, error: cause }
}

function ok(branch: string) {
  return { branch, rev: 'b'.repeat(40), ok: true as const }
}

// ─── Surfacing: reading, reporting, clearing ─────────────────────────────────
//
// Built and tested BEFORE anything writes a record. A record nothing reads is
// worse than none, because it looks handled.

describe('reportPendingSyncFailures — the foreground half', () => {
  it('says nothing when there is no record', async () => {
    const { reportPendingSyncFailures } = await import('../src/lib/sync-failure-record.js')
    const lines: string[] = []
    expect(reportPendingSyncFailures((s) => lines.push(s))).toBe(false)
    expect(lines).toEqual([])
  })

  it('reports a record once, then clears it — a second command says nothing', async () => {
    const { recordSyncFailure, reportPendingSyncFailures, syncFailureRecordPath } =
      await import('../src/lib/sync-failure-record.js')

    recordSyncFailure({
      dir: projectDir,
      branches: ['main'],
      cause: 'this workspace is in committed mode',
      at: new Date().toISOString(),
    })

    const first: string[] = []
    expect(reportPendingSyncFailures((s) => first.push(s))).toBe(true)
    const firstText = first.join('')
    expect(firstText).toContain('main')
    expect(firstText).toContain('this workspace is in committed mode')
    expect(firstText).toContain(projectDir)

    // Cleared: the record is gone from disk, and the next command is silent.
    expect(fs.existsSync(syncFailureRecordPath())).toBe(false)
    const second: string[] = []
    expect(reportPendingSyncFailures((s) => second.push(s))).toBe(false)
    expect(second).toEqual([])
  })

  it('never breaks the command reading it when the record is malformed', async () => {
    const { reportPendingSyncFailures, syncFailureRecordPath } =
      await import('../src/lib/sync-failure-record.js')
    const p = syncFailureRecordPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })

    for (const junk of ['{ not json', '[]', 'null', '{"/x": 42}', '{"/x": {"branches": "nope"}}']) {
      fs.writeFileSync(p, junk)
      const lines: string[] = []
      expect(() => reportPendingSyncFailures((s) => lines.push(s))).not.toThrow()
      // …and the unreadable file is cleared rather than left to fail forever.
      expect(fs.existsSync(p)).toBe(false)
    }
  })

  it('reports failures from two different projects in one go', async () => {
    const { recordSyncFailure, reportPendingSyncFailures } =
      await import('../src/lib/sync-failure-record.js')
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-failrec-other-'))
    try {
      recordSyncFailure({ dir: projectDir, branches: ['main'], cause: 'cause A', at: new Date().toISOString() })
      recordSyncFailure({ dir: other, branches: ['dev'], cause: 'cause B', at: new Date().toISOString() })
      const lines: string[] = []
      reportPendingSyncFailures((s) => lines.push(s))
      const text = lines.join('')
      expect(text).toContain('cause A')
      expect(text).toContain('cause B')
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})

// ─── Writing: what a failing hook leaves behind ──────────────────────────────

describe('settleHookSyncOutcome — the background half', () => {
  it('writes a record naming the reason when a hook sync is refused (R16)', async () => {
    const { settleHookSyncOutcome, readSyncFailureRecords } =
      await import('../src/lib/sync-failure-record.js')

    settleHookSyncOutcome(projectDir, [
      fail('main', '--content-mode working-tree contradicts this workspace, which is in committed mode'),
    ])

    const records = readSyncFailureRecords()
    expect(records).toHaveLength(1)
    expect(records[0]!.branches).toEqual(['main'])
    expect(records[0]!.cause).toContain('committed mode')
    expect(Date.parse(records[0]!.at)).not.toBeNaN()
  })

  it('replaces rather than accumulates when a hook fails repeatedly', async () => {
    const { settleHookSyncOutcome, readSyncFailureRecords } =
      await import('../src/lib/sync-failure-record.js')

    settleHookSyncOutcome(projectDir, [fail('main', 'first cause')])
    settleHookSyncOutcome(projectDir, [fail('main', 'second cause')])
    settleHookSyncOutcome(projectDir, [fail('main', 'third cause')])

    const records = readSyncFailureRecords()
    expect(records).toHaveLength(1)
    expect(records[0]!.cause).toContain('third cause')
    expect(records[0]!.cause).not.toContain('first cause')
  })

  it('clears an existing record when the sync succeeds', async () => {
    const { settleHookSyncOutcome, readSyncFailureRecords } =
      await import('../src/lib/sync-failure-record.js')

    settleHookSyncOutcome(projectDir, [fail('main', 'server unreachable')])
    expect(readSyncFailureRecords()).toHaveLength(1)

    settleHookSyncOutcome(projectDir, [ok('main')])
    expect(readSyncFailureRecords()).toEqual([])
  })

  it('clears only the project that succeeded, leaving another project’s record', async () => {
    const { settleHookSyncOutcome, readSyncFailureRecords } =
      await import('../src/lib/sync-failure-record.js')
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-failrec-other-'))
    try {
      settleHookSyncOutcome(projectDir, [fail('main', 'cause A')])
      settleHookSyncOutcome(other, [fail('dev', 'cause B')])
      settleHookSyncOutcome(projectDir, [ok('main')])

      const records = readSyncFailureRecords()
      expect(records).toHaveLength(1)
      expect(records[0]!.cause).toContain('cause B')
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  it('does not erase ANOTHER branch’s unseen record when this branch succeeds', async () => {
    // The record is keyed by DIRECTORY but written per-invocation, and the two
    // do not line up: one repository has many branches and each push settles
    // only its own. Push `feature`, it fails, a record is written — and nobody
    // has seen it yet, because git exited 0 and the record only surfaces on the
    // next FOREGROUND command. Push `main`, it succeeds; a whole-directory clear
    // would delete `feature`'s record on the strength of a run that never went
    // near `feature`. The failure is then permanently invisible.
    const { settleHookSyncOutcome, readSyncFailureRecords } =
      await import('../src/lib/sync-failure-record.js')

    settleHookSyncOutcome(projectDir, [fail('feature', 'server unreachable')])
    settleHookSyncOutcome(projectDir, [ok('main')])

    const records = readSyncFailureRecords()
    expect(records).toHaveLength(1)
    expect(records[0]!.branches).toEqual(['feature'])
    expect(records[0]!.cause).toContain('server unreachable')
  })

  it('clears only the branches THIS invocation covered, and drops the record when none remain', async () => {
    const { settleHookSyncOutcome, readSyncFailureRecords, syncFailureRecordPath } =
      await import('../src/lib/sync-failure-record.js')

    settleHookSyncOutcome(projectDir, [fail('one', 'boom'), fail('two', 'boom')])
    expect(readSyncFailureRecords()[0]!.branches).toEqual(['one', 'two'])

    // A later push fixes `one` only — `two` is still broken and still unseen.
    settleHookSyncOutcome(projectDir, [ok('one')])
    expect(readSyncFailureRecords()[0]!.branches).toEqual(['two'])

    // …and once the last outstanding branch succeeds the record goes entirely,
    // rather than lingering as an empty husk that reports nothing.
    settleHookSyncOutcome(projectDir, [ok('two')])
    expect(readSyncFailureRecords()).toEqual([])
    expect(fs.existsSync(syncFailureRecordPath())).toBe(false)
  })

  it('a partial run clears its successes and records its failures in one pass', async () => {
    const { settleHookSyncOutcome, readSyncFailureRecords } =
      await import('../src/lib/sync-failure-record.js')

    settleHookSyncOutcome(projectDir, [fail('one', 'old cause'), fail('two', 'old cause')])
    settleHookSyncOutcome(projectDir, [ok('one'), fail('two', 'new cause')])

    const records = readSyncFailureRecords()
    expect(records).toHaveLength(1)
    expect(records[0]!.branches).toEqual(['two'])
    expect(records[0]!.cause).toContain('new cause')
  })

  it('leaves an unseen record alone when nothing was attempted at all', async () => {
    // A tags-only push, a branch deletion, a hook that could not resolve a
    // commit: `handleHookSync` returns []. That is not a successful sync, and
    // clearing on it would throw away a real failure before anyone saw it.
    const { settleHookSyncOutcome, readSyncFailureRecords } =
      await import('../src/lib/sync-failure-record.js')

    settleHookSyncOutcome(projectDir, [fail('main', 'server unreachable')])
    settleHookSyncOutcome(projectDir, [])

    expect(readSyncFailureRecords()).toHaveLength(1)
  })

  it('records a partial failure: the branches that failed, not the ones that did not', async () => {
    const { settleHookSyncOutcome, readSyncFailureRecords } =
      await import('../src/lib/sync-failure-record.js')

    settleHookSyncOutcome(projectDir, [ok('one'), fail('two', 'boom'), ok('three')])

    const records = readSyncFailureRecords()
    expect(records[0]!.branches).toEqual(['two'])
  })

  it('writes NOTHING inside the project directory on any failure path', async () => {
    const { settleHookSyncOutcome } = await import('../src/lib/sync-failure-record.js')
    fs.writeFileSync(path.join(projectDir, 'a.md'), '# a\n')
    const before = tree(projectDir)

    settleHookSyncOutcome(projectDir, [fail('main', 'refused')])
    settleHookSyncOutcome(projectDir, [fail('main', 'refused again')])
    settleHookSyncOutcome(projectDir, [ok('main')])

    expect(tree(projectDir)).toEqual(before)
  })

  it('is fully isolated by MARGINS_DATA_DIR', async () => {
    const { settleHookSyncOutcome, syncFailureRecordPath, readSyncFailureRecords } =
      await import('../src/lib/sync-failure-record.js')

    // The record path lives under the override, not the platform data dir.
    expect(syncFailureRecordPath().startsWith(dataDir + path.sep)).toBe(true)

    settleHookSyncOutcome(projectDir, [fail('main', 'refused')])

    // Everything written went into the override…
    expect(fs.existsSync(syncFailureRecordPath())).toBe(true)
    // …and pointing the override elsewhere yields a clean slate, so a real
    // developer's state is neither read nor cleared by a test run.
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-failrec-alt-'))
    try {
      process.env['MARGINS_DATA_DIR'] = elsewhere
      expect(readSyncFailureRecords()).toEqual([])
    } finally {
      process.env['MARGINS_DATA_DIR'] = dataDir
      fs.rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})

// ─── CI: no record, a failed step instead ────────────────────────────────────

describe('settleHookSyncOutcome — CI', () => {
  it('throws instead of recording, because no foreground command follows in CI', async () => {
    const { settleHookSyncOutcome, readSyncFailureRecords } =
      await import('../src/lib/sync-failure-record.js')

    expect(() => settleHookSyncOutcome(
      projectDir,
      [fail('main', 'workspace is in committed mode')],
      { env: { CI: 'true' } },
    )).toThrow(/committed mode/)

    expect(readSyncFailureRecords()).toEqual([])
  })

  it('records instead of throwing when CI is explicitly false', async () => {
    const { settleHookSyncOutcome, readSyncFailureRecords } =
      await import('../src/lib/sync-failure-record.js')

    expect(() => settleHookSyncOutcome(
      projectDir, [fail('main', 'refused')], { env: { CI: 'false' } },
    )).not.toThrow()
    expect(readSyncFailureRecords()).toHaveLength(1)
  })

  it('does not throw in CI when every branch succeeded', async () => {
    const { settleHookSyncOutcome } = await import('../src/lib/sync-failure-record.js')
    expect(() => settleHookSyncOutcome(
      projectDir, [ok('main')], { env: { CI: 'true' } },
    )).not.toThrow()
  })
})

describe('isNonInteractiveCi', () => {
  it('recognises the runners that actually set a flag, and ignores a disabled one', async () => {
    const { isNonInteractiveCi } = await import('../src/lib/sync-failure-record.js')
    expect(isNonInteractiveCi({})).toBe(false)
    expect(isNonInteractiveCi({ CI: 'true' })).toBe(true)
    expect(isNonInteractiveCi({ CI: '1' })).toBe(true)
    expect(isNonInteractiveCi({ CI: 'false' })).toBe(false)
    expect(isNonInteractiveCi({ CI: '0' })).toBe(false)
    expect(isNonInteractiveCi({ CI: '' })).toBe(false)
    expect(isNonInteractiveCi({ GITHUB_ACTIONS: 'true' })).toBe(true)
    expect(isNonInteractiveCi({ GITLAB_CI: 'true' })).toBe(true)
  })
})

// ─── End to end, through the real CLI ────────────────────────────────────────
//
// The exit code and the message ARE the CI failure channel, so they are asserted
// against a spawned process rather than inferred from a unit call. Driven from
// `src/` via tsx so the assertions describe the source under edit, not a stale
// committed `dist/`.

interface StubOpts {
  /** What the preflight GET reports as the workspace's content mode. */
  contentMode?: string
  /** Fail every request with this status instead of answering. */
  status?: number
  /** 401 any request that arrives without an Authorization header. */
  requireAuth?: boolean
}

/**
 * A stub Margins server in ITS OWN PROCESS.
 *
 * It cannot live in the test process. `spawnSync` blocks node's event loop for
 * the whole life of the child, so an in-process server would never accept the
 * child's connection — the CLI would hang until its own request timeout and the
 * test would "fail" 60 seconds later for a reason that has nothing to do with
 * the behaviour under test.
 */
async function stubServer(opts: StubOpts): Promise<{ url: string; close: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-failrec-stub-'))
  const portFile = path.join(dir, 'port')
  const script = path.join(dir, 'stub.mjs')
  fs.writeFileSync(script, `
import http from 'node:http'
import fs from 'node:fs'
const opts = ${JSON.stringify(opts)}
const server = http.createServer((req, res) => {
  if (opts.requireAuth) {
    // An EMPTY bearer, not just a missing header: with no key configured the
    // client still sends \`Authorization: Bearer \`, and a real server rejects
    // that exactly as it rejects no header at all.
    const token = String(req.headers['authorization'] ?? '').replace(/^Bearer\\s*/i, '').trim()
    if (!token) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'missing credentials' } }))
      return
    }
  }
  if (opts.status) {
    res.writeHead(opts.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'BOOM', message: 'stub failure' } }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    files: {}, headSha: null,
    ...(opts.contentMode ? { contentMode: opts.contentMode } : {}),
  }))
})
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(${JSON.stringify(portFile)}, String(server.address().port))
})
`)
  const child = spawn(process.execPath, [script], { stdio: 'ignore' })

  const deadline = Date.now() + 10_000
  while (!fs.existsSync(portFile)) {
    if (Date.now() > deadline) throw new Error('stub server did not start')
    await new Promise((r) => setTimeout(r, 20))
  }
  const port = fs.readFileSync(portFile, 'utf-8').trim()

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      child.kill()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * A stub GitHub Actions OIDC token endpoint, in its own process (same reason as
 * `stubServer`).
 *
 * This exists to simulate a real Actions runner, where `permissions: id-token:
 * write` makes GitHub inject ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN into the job.
 * Without a *working* mint endpoint the api-client's re-mint throws and the
 * behaviour under test never changes — so a regression test for ambient-OIDC
 * leakage has to serve a real token, not just set the variables.
 */
async function oidcMintStub(): Promise<{ url: string; close: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-failrec-oidc-'))
  const portFile = path.join(dir, 'port')
  const script = path.join(dir, 'oidc.mjs')
  fs.writeFileSync(script, `
import http from 'node:http'
import fs from 'node:fs'
// The api-client appends &audience=... and sends Authorization: Bearer <request token>.
// Shape per GitHub's OIDC contract: { value: <jwt> }.
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ value: 'stub-actions-oidc-token' }))
})
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(${JSON.stringify(portFile)}, String(server.address().port))
})
`)
  const child = spawn(process.execPath, [script], { stdio: 'ignore' })

  const deadline = Date.now() + 10_000
  while (!fs.existsSync(portFile)) {
    if (Date.now() > deadline) throw new Error('oidc stub did not start')
    await new Promise((r) => setTimeout(r, 20))
  }
  const port = fs.readFileSync(portFile, 'utf-8').trim()

  return {
    url: `http://127.0.0.1:${port}/token?foo=bar`,
    close: () => {
      child.kill()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

function cli(args: string[], env: NodeJS.ProcessEnv, cwd = projectDir) {
  // tsx is resolved by ABSOLUTE path: `--import tsx/esm` is resolved relative to
  // the child's cwd, which here is a temp project directory with no node_modules.
  return spawnSync(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'src', 'index.ts'), ...args],
    {
      encoding: 'utf-8',
      cwd,
      env: {
        ...process.env,
        NO_COLOR: '1',
        // Never the developer's real config or data: both are redirected into
        // this test's temp dirs.
        MARGINS_CONFIG_DIR: path.join(dataDir, 'config'),
        MARGINS_DATA_DIR: dataDir,
        MARGINS_API_KEY: 'mrgn_test',
        // …and never the RUNNER's identity. GitHub injects these into any job
        // holding `permissions: id-token: write` — which our release workflow
        // needs for npm Trusted Publishing — and `...process.env` above would
        // hand them to the child. The api-client treats them as credentials
        // (auth-env.ts hasOidcAuth; api-client.ts canRemintOidc re-mints on a
        // 401), so a test that means "no usable credentials" silently gets
        // usable ones on Actions and asserts the wrong branch. Scrubbed here
        // rather than in beforeEach so it holds no matter what the ambient
        // process picked up, and listed to match hasOidcAuth exactly.
        MARGINS_OIDC_TOKEN: '',
        ACTIONS_ID_TOKEN_REQUEST_URL: '',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
        ...env,
      },
    },
  )
}

function recordFile(): string {
  return path.join(dataDir, 'sync-failures.json')
}

describe('end to end — the CI channel is the exit code and the log', () => {
  it('exits non-zero naming the mode mismatch and the remedy, and writes NO record (R16)', async () => {
    const stub = await stubServer({ contentMode: 'committed' })
    try {
      fs.writeFileSync(path.join(projectDir, 'a.md'), '# a\n')
      const before = tree(projectDir)

      const r = cli(
        ['workspace', 'push', '--workspace', 'ws-1', '--branch', 'main',
          '--content-mode', 'working-tree'],
        { MARGINS_SERVER_URL: stub.url, CI: 'true', GITHUB_ACTIONS: 'true' },
      )

      // The channel CI actually has.
      expect(r.status).not.toBe(0)
      // Naming BOTH the mismatch and the remedy — a bare error would leave a
      // job log saying only that something failed.
      expect(r.stderr).toContain('working-tree')
      expect(r.stderr).toContain('committed mode')
      expect(r.stderr).toContain('margins workspace content-mode')
      // No record: nothing in CI would ever read it.
      expect(fs.existsSync(recordFile())).toBe(false)
      // And nothing inside the project.
      expect(tree(projectDir)).toEqual(before)
    } finally {
      stub.close()
    }
  }, 60_000)

  it('fails the hook-sync step in CI instead of recording it', async () => {
    const stub = await stubServer({ status: 500 })
    try {
      fs.writeFileSync(
        path.join(projectDir, '.margins.json'),
        JSON.stringify({ workspace_id: 'ws-1', syncMode: 'client' }),
      )
      const r = cli(
        ['workspace', 'hook-sync', '--event', 'pre-push',
          '--refs', `refs/heads/main ${'a'.repeat(40)} refs/heads/main ${'0'.repeat(40)}`],
        { MARGINS_SERVER_URL: stub.url, CI: 'true', GITHUB_ACTIONS: 'true' },
      )

      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('main')
      expect(fs.existsSync(recordFile())).toBe(false)
    } finally {
      stub.close()
    }
  }, 60_000)
})

// ─── Concurrency: two repositories failing at the same moment ────────────────
//
// The per-branch lock in `push.ts` keys on (dir, branch), so it does not
// serialize these AT ALL: two different repositories mid-`git push` are two
// unrelated background processes writing one shared file. `recordSyncFailure`
// is a read-modify-write, so the loser of every interleaving is a record that
// was written and then silently overwritten by a writer holding a stale read.
//
// Real processes, because that is the only place the race exists: one event
// loop cannot interleave a synchronous read-modify-write with itself.

describe('recordSyncFailure — concurrent hook processes', () => {
  it('keeps every record when several repositories fail at once', async () => {
    const N = 6
    const dirs = Array.from({ length: N }, (_, i) => path.join(projectDir, `repo-${i}`))
    for (const d of dirs) fs.mkdirSync(d, { recursive: true })

    const script = path.join(dataDir, 'writer.mjs')
    fs.writeFileSync(script, `
import { pathToFileURL } from 'node:url'
const mod = await import(pathToFileURL(process.argv[2]).href)
const dir = process.argv[3]
const startAt = Number(process.argv[4])
// A barrier, so the writers genuinely overlap instead of queueing behind each
// other's process startup — the interleaving IS the test.
while (Date.now() < startAt) {}
mod.recordSyncFailure({
  dir, branches: ['main'], cause: 'cause for ' + dir, at: new Date().toISOString(),
})
`)

    const modulePath = path.join(ROOT, 'src', 'lib', 'sync-failure-record.ts')
    const startAt = Date.now() + 1500
    const children = dirs.map((dir) => new Promise<number>((resolve) => {
      const c = spawn(
        process.execPath,
        [
          path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
          script, modulePath, dir, String(startAt),
        ],
        {
          stdio: 'ignore',
          env: { ...process.env, MARGINS_DATA_DIR: dataDir },
        },
      )
      c.on('exit', (code) => resolve(code ?? 1))
    }))

    expect(await Promise.all(children)).toEqual(Array(N).fill(0))

    const { readSyncFailureRecords } = await import('../src/lib/sync-failure-record.js')
    const got = readSyncFailureRecords().map((r) => r.dir).sort()
    expect(got).toEqual(dirs.map((d) => path.resolve(d)).sort())
  }, 60_000)
})

describe('end to end — a human push keeps its exit code', () => {
  it('still exits non-zero with the same message on a server-sync workspace', async () => {
    // The server-sync refusal became a thrown error so a hook can record it per
    // branch (R17) instead of the whole background process dying on
    // `process.exit(1)`. The behaviour a human sees must not have changed —
    // and only a real process can prove an exit code.
    fs.writeFileSync(
      path.join(projectDir, '.margins.json'),
      JSON.stringify({ workspace_id: 'ws-srv', syncMode: 'server' }),
    )
    fs.writeFileSync(path.join(projectDir, 'a.md'), '# a\n')

    const r = cli(['workspace', 'push', '--branch', 'main'], {
      // Unreachable on purpose: the refusal must land before any network call.
      MARGINS_SERVER_URL: 'http://127.0.0.1:1',
      CI: '',
    })

    expect(r.status).toBe(1)
    expect(r.stderr).toContain(
      'This workspace uses server-managed sync. Use `margins workspace sync` instead.',
    )
  }, 60_000)
})

describe('end to end — a hook with no usable credentials', () => {
  it('records the auth failure instead of dying before the record is written', async () => {
    // The one cause the findability feature structurally could not see.
    //
    // `hook-sync` runs under the root `workspace` command, which is not in
    // `NO_AUTH_COMMANDS`, so the `preAction` auth gate called `process.exit(1)`
    // BEFORE `handleHookSync` — and therefore before `settleHookSyncOutcome` —
    // ever ran. `install-hook` IS exempt from that gate, so a hook can be
    // installed before credentials exist; and a rotated API key drops a working
    // install straight into this state. Either way git exits 0, nothing is
    // recorded, and every push after it is silently not syncing.
    const stub = await stubServer({ requireAuth: true })
    try {
      fs.writeFileSync(
        path.join(projectDir, '.margins.json'),
        JSON.stringify({ workspace_id: 'ws-1', syncMode: 'client' }),
      )
      fs.writeFileSync(path.join(projectDir, 'a.md'), '# a\n')
      const before = tree(projectDir)

      const hook = cli(
        ['workspace', 'hook-sync', '--event', 'pre-push',
          '--refs', `refs/heads/main ${'a'.repeat(40)} refs/heads/main ${'0'.repeat(40)}`],
        {
          MARGINS_SERVER_URL: stub.url,
          CI: '',
          // No credentials at all — an empty config dir and no env key.
          MARGINS_CONFIG_DIR: path.join(dataDir, 'empty-config'),
          MARGINS_API_KEY: '',
        },
      )

      // Still non-blocking: a hook must not fail the developer's git command.
      expect(hook.status).toBe(0)
      // …and the failure is findable rather than silent.
      expect(fs.existsSync(recordFile())).toBe(true)
      const text = fs.readFileSync(recordFile(), 'utf-8')
      expect(text).toContain('main')
      // Nothing landed in the project.
      expect(tree(projectDir)).toEqual(before)

      // The next foreground command surfaces it.
      const next = cli(['config', 'show'], { CI: '' })
      expect(next.stderr).toContain('main')
    } finally {
      stub.close()
    }
  }, 60_000)

  // REGRESSION (2026-07-20). The suite above scrubs six CI flags so the local
  // channel is what gets asserted — but it did NOT scrub the ambient credential
  // GitHub hands a job that has `permissions: id-token: write`. Our own release
  // workflow needs exactly that permission for npm Trusted Publishing, so on the
  // runner ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN were present, `cli()` passed them
  // through with `...process.env`, and the api-client re-minted a real token on
  // the 401 (api-client.ts canRemintOidc). The stub accepts any NON-EMPTY
  // bearer, so the retry got a 200: the "no usable credentials" push quietly
  // SUCCEEDED, there was no failure to record, and the assertion that a record
  // exists failed. `expect(hook.status).toBe(0)` passed throughout — for the
  // wrong reason, since exit 0 cannot tell "recorded a failure" from "succeeded".
  //
  // This reproduces that on ANY machine by supplying the ambient pair plus a
  // working mint endpoint. Delete the scrubbing in `cli()` and this test fails
  // locally, not only on Actions.
  it('ignores ambient GitHub Actions OIDC credentials rather than silently authenticating with them', async () => {
    const stub = await stubServer({ requireAuth: true })
    const oidc = await oidcMintStub()
    const prevUrl = process.env['ACTIONS_ID_TOKEN_REQUEST_URL']
    const prevToken = process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN']
    // Stand the process up as a runner with OIDC available, exactly as Actions does.
    process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] = oidc.url
    process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = 'stub-request-token'
    try {
      fs.writeFileSync(
        path.join(projectDir, '.margins.json'),
        JSON.stringify({ workspace_id: 'ws-1', syncMode: 'client' }),
      )
      fs.writeFileSync(path.join(projectDir, 'a.md'), '# a\n')

      const hook = cli(
        ['workspace', 'hook-sync', '--event', 'pre-push',
          '--refs', `refs/heads/main ${'a'.repeat(40)} refs/heads/main ${'0'.repeat(40)}`],
        {
          MARGINS_SERVER_URL: stub.url,
          CI: '',
          MARGINS_CONFIG_DIR: path.join(dataDir, 'empty-config'),
          MARGINS_API_KEY: '',
        },
      )

      expect(hook.status).toBe(0)
      // The point of the test: with no credentials of its own, the CLI must not
      // reach for the runner's identity. If it does, this push succeeds and the
      // record never appears — which is how the bug presented.
      expect(fs.existsSync(recordFile())).toBe(true)
      expect(fs.readFileSync(recordFile(), 'utf-8')).toContain('main')
    } finally {
      if (prevUrl === undefined) delete process.env['ACTIONS_ID_TOKEN_REQUEST_URL']
      else process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] = prevUrl
      if (prevToken === undefined) delete process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN']
      else process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = prevToken
      oidc.close()
      stub.close()
    }
  }, 60_000)
})

describe('end to end — the local channel is the record', () => {
  it('leaves git unblocked, records, then reports once on the next command', async () => {
    const stub = await stubServer({ status: 500 })
    try {
      fs.writeFileSync(
        path.join(projectDir, '.margins.json'),
        JSON.stringify({ workspace_id: 'ws-1', syncMode: 'client' }),
      )
      const before = tree(projectDir)

      const hook = cli(
        ['workspace', 'hook-sync', '--event', 'pre-push',
          '--refs', `refs/heads/main ${'a'.repeat(40)} refs/heads/main ${'0'.repeat(40)}`],
        { MARGINS_SERVER_URL: stub.url, CI: '' },
      )

      // Non-blocking: the hook path never fails the developer's git command.
      expect(hook.status).toBe(0)
      expect(fs.existsSync(recordFile())).toBe(true)
      // The record is in the CLI's data dir — NOT in the project, where it would
      // show up in `git status` and could be committed.
      expect(tree(projectDir)).toEqual(before)

      // The next foreground command reports it…
      const first = cli(['config', 'show'], { CI: '' })
      expect(first.stderr).toContain('main')
      expect(first.stderr.toLowerCase()).toContain('sync')

      // …once. The one after it says nothing.
      const second = cli(['config', 'show'], { CI: '' })
      expect(second.stderr).not.toContain('main')
      expect(fs.existsSync(recordFile())).toBe(false)
    } finally {
      stub.close()
    }
  }, 60_000)
})
