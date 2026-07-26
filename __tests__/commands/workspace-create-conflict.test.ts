/**
 * `margins workspace create` must not flatten the two 409s into one string.
 *
 * Since Margins 0.60.0 a 409 from `POST /api/workspaces` means one of two things, and
 * they have different fixes:
 *
 *   SLUG_CONFLICT      — a workspace exists for this repo and you are not a member.
 *                        Ask an editor for an invite link. You cannot fix this yourself.
 *   SYNC_MODE_CONFLICT — it exists and uses a different sync mode. A setup problem you
 *                        can act on directly.
 *
 * The command caught `ConflictError` and rethrew a bare `Workspace already exists for
 * <url>`, discarding the server's message *and* its structural code — so both causes
 * arrived at the user as the same sentence, and the one piece of actionable guidance
 * (the invite link) was the part thrown away.
 *
 * The two cases are compared against each other in one assertion rather than matched
 * separately, so a future edit that re-collapses them fails here instead of passing two
 * independently-loose regexes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

const SLUG_CONFLICT_BODY = {
  error: 'SLUG_CONFLICT',
  message:
    'SLUG_CONFLICT: A workspace already exists for this repository. ' +
    'Ask an editor to send you an invite link from the Collaborators tab.',
}

const SYNC_MODE_CONFLICT_BODY = {
  error: 'SYNC_MODE_CONFLICT',
  message: 'SYNC_MODE_CONFLICT: A workspace for this repo already exists with a different sync mode.',
}

const REPO_URL = 'https://github.com/acme/docs'

function stub(body: unknown, status = 409) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST' && url.endsWith('/api/workspaces')) {
      return new Response(JSON.stringify(body), { status })
    }
    return new Response('{}', { status: 200 })
  }))
}

function cfg() {
  return { apiKey: 'mrgn_test', serverUrl: 'https://margins.test', json: false } as never
}

async function createAndCatch(): Promise<Error> {
  const { handleCreate } = await import('../../src/commands/workspace/create.js')
  return await handleCreate(cfg(), REPO_URL).then(
    () => { throw new Error('expected a rejection') },
    (e: Error) => e,
  )
}

afterEach(() => { vi.unstubAllGlobals() })

describe('margins workspace create — 409 handling', () => {
  it('keeps the server\'s guidance on a slug conflict', async () => {
    stub(SLUG_CONFLICT_BODY)
    const err = await createAndCatch()

    expect(
      (err as { userMessage?: string }).userMessage,
      'the invite-link guidance is the only actionable part; it must survive',
    ).toMatch(/invite link/i)
    expect((err as { code?: string }).code).toBe('SLUG_CONFLICT')
  })

  it('keeps the repo URL as context, without replacing the message', async () => {
    stub(SLUG_CONFLICT_BODY)
    const err = await createAndCatch()
    const text = (err as { userMessage?: string }).userMessage ?? ''

    expect(text).toContain(REPO_URL)
    expect(text).toMatch(/Collaborators/i)
  })

  it('the two causes are DISTINGUISHABLE — the assertion that stops a re-collapse', async () => {
    stub(SLUG_CONFLICT_BODY)
    const slug = await createAndCatch()
    vi.unstubAllGlobals()

    stub(SYNC_MODE_CONFLICT_BODY)
    const mode = await createAndCatch()

    const slugText = (slug as { userMessage?: string }).userMessage ?? ''
    const modeText = (mode as { userMessage?: string }).userMessage ?? ''

    // One comparison, not two loose regexes: if a future edit makes either
    // generic, these converge and this fails.
    expect(slugText).not.toBe(modeText)
    expect((slug as { code?: string }).code).not.toBe((mode as { code?: string }).code)
    expect(modeText).toMatch(/sync mode/i)
  })

  it('a codeless 409 still fails, with no code to claim', async () => {
    stub({ message: 'already exists' })
    const err = await createAndCatch()

    expect((err as { code?: string }).code).toBeUndefined()
    expect((err as Error).message).toBeTruthy()
  })
})
