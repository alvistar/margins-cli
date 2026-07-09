/**
 * Thin exec wrappers for `npm` + `gh auth token` — the only child_process surface the runtime
 * bootstrap touches. Tests mock THIS module (like gh.ts) so runtime.ts stays pure logic. Every
 * call uses execFile (argv array), never a shell-interpolated string.
 */
import { execFile } from 'node:child_process'

const MAX_BUFFER = 64 * 1024 * 1024

/** A run failure carries npm/gh's stderr so runtime.ts can classify 401/403/404. */
export class NpmExecError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message)
    this.name = 'NpmExecError'
  }
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: MAX_BUFFER, cwd: opts.cwd, env: opts.env }, (err, stdout, stderr) => {
      if (err) {
        reject(new NpmExecError(stderr?.trim() || err.message, stderr ?? ''))
        return
      }
      resolve(stdout)
    })
  })
}

/** The operator's ambient GitHub token via `gh auth token`, or null if gh is absent/unauthed. */
export async function ghAuthToken(): Promise<string | null> {
  try {
    return (await run('gh', ['auth', 'token'])).trim() || null
  } catch {
    return null
  }
}

/** `npm view <pkg> version` against an isolated userconfig — the latest published version. */
export async function npmViewVersion(pkg: string, userconfig: string): Promise<string> {
  return (await run('npm', ['view', pkg, 'version', '--userconfig', userconfig])).trim()
}

/** `npm install <spec>` into `cwd` (which holds a package.json) against an isolated userconfig. */
export async function npmInstall(spec: string, cwd: string, userconfig: string): Promise<void> {
  await run(
    'npm',
    ['install', spec, '--userconfig', userconfig, '--no-audit', '--no-fund', '--omit=dev'],
    { cwd },
  )
}
