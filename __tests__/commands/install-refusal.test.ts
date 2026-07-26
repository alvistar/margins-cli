/**
 * A repo whose workspace exists but is not yours is SKIPPED, not failed, and never
 * aborts the run.
 *
 * `margins install` creates a workspace per repo. Its own lookup is sound — it parses
 * and compares owner/repo — so a non-member simply finds nothing and reaches the create,
 * which since Margins 0.60.0 answers `409 SLUG_CONFLICT`. That create had no handler at
 * all, and what happened next depended on a flag:
 *
 *   - without `--org`, the error reached `throw err` in the caller and **aborted the
 *     entire run**, so one inaccessible workspace stopped every remaining repo;
 *   - with `--org`, the generic per-repo catch recorded it as `failed` with the raw
 *     error text, conflating "you need an invite" with "the install broke".
 *
 * Both modes are covered below, because a test for either one alone would leave the
 * other regression live. The command already models `skipped` with a reason — the same
 * status it uses for a workspace on the wrong sync mode — and that is the honest shape
 * for a refusal the user can act on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

const SLUG_CONFLICT_BODY = {
  error: 'SLUG_CONFLICT',
  message:
    'SLUG_CONFLICT: A workspace already exists for this repository. ' +
    'Ask an editor to send you an invite link from the Collaborators tab.',
}

const BINDING_CONFLICT_BODY = {
  error: 'BINDING_CONFLICT',
  message: 'Another repository is already bound to this workspace.',
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

/**
 * Drive the per-repo pipeline through a stubbed transport. `createFails` decides what
 * the workspace-create POST answers; everything else succeeds so the refusal is the
 * only thing under test.
 */
function stubTransport(createResponse: () => Response, opts: { bindingConflict?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST' && url.endsWith('/api/workspaces')) return createResponse()
    if (url.includes('/binding') && init?.method === 'PUT') {
      return opts.bindingConflict
        ? new Response(JSON.stringify(BINDING_CONFLICT_BODY), { status: 409 })
        : new Response('{}', { status: 200 })
    }
    if (url.includes('/binding')) return new Response(JSON.stringify({ binding: null }), { status: 200 })
    if (url.includes('/api/workspaces')) return new Response('[]', { status: 200 })
    return new Response('{}', { status: 200 })
  }))
}

describe('margins install — a refused workspace create', () => {
  it('is classified as SLUG_CONFLICT rather than a generic conflict', async () => {
    // The discriminator this whole change rests on: the server's structural code
    // survives the transport and lands on the thrown error. Asserted directly,
    // because every command's branch is downstream of it.
    stubTransport(() => new Response(JSON.stringify(SLUG_CONFLICT_BODY), { status: 409 }))
    const { createApiClient } = await import('../../src/lib/api-client.js')
    const { ConflictError } = await import('../../src/lib/errors.js')

    const client = createApiClient({
      apiKey: 'mrgn_test', serverUrl: 'https://margins.test', json: false,
    } as never)

    const err = await client.post('/api/workspaces', { name: 'x' }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ConflictError)
    expect((err as { code?: string }).code).toBe('SLUG_CONFLICT')
    expect((err as { userMessage?: string }).userMessage).toMatch(/invite link/i)
  })

  it('a binding conflict stays a binding conflict — the catch is not over-broad', async () => {
    // The control that catches an over-broad handler. `install` raises a DIFFERENT
    // 409 later (the trust binding); swallowing it as a workspace refusal would
    // report "ask for an invite" for a problem an invite cannot fix.
    stubTransport(() => new Response(JSON.stringify(BINDING_CONFLICT_BODY), { status: 409 }))
    const { createApiClient } = await import('../../src/lib/api-client.js')

    const client = createApiClient({
      apiKey: 'mrgn_test', serverUrl: 'https://margins.test', json: false,
    } as never)

    const err = await client.post('/api/workspaces', { name: 'x' }).catch((e: unknown) => e)

    expect((err as { code?: string }).code).toBe('BINDING_CONFLICT')
    expect(
      (err as { code?: string }).code,
      'a non-SLUG_CONFLICT 409 must not be treated as a workspace refusal',
    ).not.toBe('SLUG_CONFLICT')
  })

  it('a codeless 409 carries no code, so the refusal branch cannot claim it', async () => {
    // An older server, or a proxy that flattened the body. Defaulting these to the
    // refusal path would tell users to ask for an invite they do not need.
    stubTransport(() => new Response(JSON.stringify({ message: 'already exists' }), { status: 409 }))
    const { createApiClient } = await import('../../src/lib/api-client.js')

    const client = createApiClient({
      apiKey: 'mrgn_test', serverUrl: 'https://margins.test', json: false,
    } as never)

    const err = await client.post('/api/workspaces', { name: 'x' }).catch((e: unknown) => e)

    expect((err as { code?: string }).code).toBeUndefined()
  })
})

// ─── The behaviour the plan actually asks for ────────────────────────────────
// The three tests above prove the discriminator survives the transport, which
// every command's branch depends on — but they would have passed before this
// change too. These drive the real per-repo pipeline through `handleInstall`
// and assert the OUTCOME, in both invocation modes, because the failure differs
// by flag and a test for either alone would leave the other regression live.

vi.mock('../../src/lib/gh.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/gh.js')>('../../src/lib/gh.js')
  return {
    ...actual,
    getRepo: vi.fn(async (fullName: string) => ({
      id: 1, ownerId: 2, fullName, defaultBranch: 'main',
    })),
    listTree: vi.fn(async () => ({ entries: [{ path: 'README.md', type: 'blob', size: 10 }] })),
    listOrgRepos: vi.fn(async () => ['acme/one', 'acme/two']),
    branchExists: vi.fn(async () => false),
    fileExists: vi.fn(async () => false),
    getFileSha: vi.fn(async () => null),
    getFileContent: vi.fn(async () => null),
    getLatestReleaseTag: vi.fn(async () => 'v1.0.0'),
    listTags: vi.fn(async () => ['v1.0.0']),
  }
})

function installCfg() {
  return { apiKey: 'mrgn_test', serverUrl: 'https://margins.test', json: true } as never
}

/** Capture what the command printed, which is where the per-repo results land. */
function captureStdout() {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  return lines
}

describe('margins install — refusal outcome (drives the real pipeline)', () => {
  it('single repo: skipped with the server\'s reason, and does NOT abort', async () => {
    stubTransport(() => new Response(JSON.stringify(SLUG_CONFLICT_BODY), { status: 409 }))
    const lines = captureStdout()
    const { handleInstall } = await import('../../src/commands/install.js')

    // Before this change the refusal reached `throw err` and this rejected.
    await expect(handleInstall(installCfg(), 'acme/one', { yes: true })).resolves.toBeUndefined()

    const out = lines.join('\n')
    expect(out).toMatch(/skipped/i)
    expect(out, 'the skip reason must carry the server\'s guidance').toMatch(/invite link/i)
    expect(out).not.toMatch(/"status"\s*:\s*"failed"/)
  })

  it('--org: the refused repo is skipped and the others are still processed', async () => {
    stubTransport(() => new Response(JSON.stringify(SLUG_CONFLICT_BODY), { status: 409 }))
    const lines = captureStdout()
    const { handleInstall } = await import('../../src/commands/install.js')

    await expect(handleInstall(installCfg(), undefined, { org: 'acme', yes: true })).resolves.toBeUndefined()

    const out = lines.join('\n')
    // Both repos reached a verdict; neither is a generic `failed`.
    expect(out).toMatch(/acme\/one/)
    expect(out).toMatch(/acme\/two/)
    expect(out, 'a refusal is not an install failure').not.toMatch(/"status"\s*:\s*"failed"/)
  })
})

// ─── The narrowing itself, and the exit code ─────────────────────────────────

describe('margins install — the SLUG_CONFLICT narrowing is load-bearing', () => {
  it('a DIFFERENT 409 on the create is not swallowed as skipped', async () => {
    // Without this, widening the catch to a bare `err instanceof ConflictError`
    // leaves the whole suite green while any create-time 409 — a binding
    // conflict, a codeless one — is reported as a per-repo skip with exit 0.
    // CI would then go green having installed nothing.
    stubTransport(() => new Response(JSON.stringify(BINDING_CONFLICT_BODY), { status: 409 }))
    captureStdout()
    const { handleInstall } = await import('../../src/commands/install.js')

    // Single-repo mode has no per-repo continuation, so a non-SLUG_CONFLICT
    // error must reach the caller rather than becoming a skip.
    await expect(handleInstall(installCfg(), 'acme/one', { yes: true })).rejects.toThrow()
  })

  it('a codeless 409 on the create is not swallowed either', async () => {
    stubTransport(() => new Response(JSON.stringify({ message: 'already exists' }), { status: 409 }))
    captureStdout()
    const { handleInstall } = await import('../../src/commands/install.js')

    await expect(handleInstall(installCfg(), 'acme/one', { yes: true })).rejects.toThrow()
  })

  it('a refusal leaves the exit code clean — a skip is not a failure', async () => {
    // Pinned deliberately. Turning the refusal from an uncaught error into a
    // `skipped` also flipped the process exit code from 1 to 0, which is
    // consistent with every other skip this command already emits (over-cap,
    // PR-creation blocked) but was not an explicit decision until now. The
    // assertion exists so a later change to either side is a conscious one.
    const prior = process.exitCode
    process.exitCode = undefined
    try {
      stubTransport(() => new Response(JSON.stringify(SLUG_CONFLICT_BODY), { status: 409 }))
      captureStdout()
      const { handleInstall } = await import('../../src/commands/install.js')

      await handleInstall(installCfg(), 'acme/one', { yes: true })

      expect(
        process.exitCode === 0 || process.exitCode === undefined,
        'a refusal is a skip, not an install failure',
      ).toBe(true)
    } finally {
      process.exitCode = prior
    }
  })
})

describe('margins install — the serverMessage fallback', () => {
  it('a coded 409 with NO message uses our wording, not the transport placeholder', async () => {
    stubTransport(() => new Response(JSON.stringify({ error: 'SLUG_CONFLICT' }), { status: 409 }))
    const lines = captureStdout()
    const { handleInstall } = await import('../../src/commands/install.js')

    await handleInstall(installCfg(), 'acme/one', { yes: true })

    const out = lines.join('\n')
    expect(out, 'never surface the transport placeholder').not.toMatch(/Conflict while calling/)
    expect(out).toMatch(/invite link/i)
  })
})

