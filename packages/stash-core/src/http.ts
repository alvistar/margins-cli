// ─── Transport contract ───────────────────────────────────────────────────────
//
// The stash recovery matrix classifies a RESPONSE, so the transport hands it one
// and never throws for an HTTP status. That inversion is what lets two very
// different callers share one matrix:
//
//   • the CLI, whose own client refreshes a Keycloak session mid-request and
//     throws typed errors — it adapts those back into this shape;
//   • the Margins Light daemon, which has no session to refresh and uses the
//     plain `fetch` transport below.
//
// A transport may still THROW for a transport-level failure (DNS, connection
// refused, timeout): there is no response to classify, and `upsertStash` turns it
// into a `NETWORK` failure.

export interface StashResponse {
  status: number
  /**
   * The `error` code from an enveloped body (`{ error, message }` or
   * `{ error: { code } }`), when the response carried one.
   *
   * Its ABSENCE on a 404 is load-bearing, not incidental: `PUT /api/stash` on a
   * server too old to have the route answers 405, and a proxy that rewrites
   * statuses can turn that into a bare, body-less 404. A 404 WITH a code means
   * the stash is genuinely gone. The two take opposite recoveries — recreate
   * versus refuse — so a transport that invents a code here breaks the matrix.
   */
  code?: string
  /** The server's own `message`, when the body carried one. */
  message?: string
  /** The parsed body, for the success paths that read fields off it. */
  body?: unknown
}

export interface StashHttp {
  post(path: string, body: unknown): Promise<StashResponse>
  put(path: string, body: unknown): Promise<StashResponse>
}

export interface FetchStashHttpOptions {
  serverUrl: string
  apiKey: string
  /** Milliseconds before the request is aborted. Default 30s. */
  timeoutMs?: number
  /** Sent as `X-Margins-Client`, so the server can tell callers apart. */
  clientHeader?: string
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 30_000

/** Pull `{ error, message }` out of a body in either of the shapes the API uses. */
function readEnvelope(body: unknown): { code?: string; message?: string } {
  if (typeof body !== 'object' || body === null) return {}
  const rec = body as Record<string, unknown>
  const message = typeof rec['message'] === 'string' ? rec['message'] : undefined
  const err = rec['error']
  if (typeof err === 'string') return { code: err, message }
  if (typeof err === 'object' && err !== null) {
    const code = (err as Record<string, unknown>)['code']
    const nested = (err as Record<string, unknown>)['message']
    return {
      code: typeof code === 'string' ? code : undefined,
      message: message ?? (typeof nested === 'string' ? nested : undefined),
    }
  }
  return { message }
}

/**
 * A minimal `fetch` transport for the stash routes.
 *
 * Bearer only. It does not refresh anything, and that is deliberate — see
 * `resolveCredential`'s note on why a background caller must not ride a Keycloak
 * access token.
 */
export function createFetchStashHttp(opts: FetchStashHttpOptions): StashHttp {
  const base = opts.serverUrl.replace(/\/$/, '')
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function send(method: 'POST' | 'PUT', path: string, body: unknown): Promise<StashResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
          ...(opts.clientHeader ? { 'X-Margins-Client': opts.clientHeader } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      // A body-less or non-JSON response is not an error here. The matrix needs
      // to tell "404 with a code" from "404 with nothing", and throwing on the
      // second would erase that distinction before it was ever read.
      let parsed: unknown = undefined
      const text = await res.text()
      if (text) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = undefined
        }
      }
      const { code, message } = readEnvelope(parsed)
      return { status: res.status, code, message, body: parsed }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    post: (path, body) => send('POST', path, body),
    put: (path, body) => send('PUT', path, body),
  }
}
