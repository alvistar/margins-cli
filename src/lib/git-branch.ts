/**
 * Which branch is checked out — asked once, in one place.
 *
 * This existed twice, in `workspace/push.ts` and `workspace/content-mode.ts`,
 * and the two copies had DRIFTED: the newer one appended `|| 'main'` and the
 * older one returned git's output verbatim. Same question, two answers, and the
 * difference only shows up in the case neither author was thinking about.
 *
 * `|| 'main'` is the behaviour that survived. An empty answer is not a branch
 * name, and every caller here uses the result as one — `handlePush` passes it
 * straight to `casSync` as the branch to write. Returning `''` would create a
 * workspace branch named "", which the hook orchestrator already goes out of its
 * way to avoid on the detached-HEAD path ("Drop it rather than pushing to a
 * branch named ''"). Folding the empty case into the same fallback the FAILURE
 * case already uses makes the two agree; the alternative propagates a value no
 * caller can use.
 *
 * Note this is deliberately NOT the detached-HEAD case. There `rev-parse`
 * succeeds and answers `HEAD`, which is a real answer to a real question, and
 * callers that care (`workspace push` in CI) pass an explicit `--branch`.
 */
import { execFileSync, type StdioOptions } from 'node:child_process'

/**
 * stdio: ['ignore', 'pipe', 'ignore'] — capture stdout, discard stderr so git's
 * error output (e.g. 'fatal: ambiguous argument HEAD' in a repository with no
 * commits) does not leak past the caller's try/catch into the user's terminal.
 */
export const GIT_STDIO: StdioOptions = ['ignore', 'pipe', 'ignore']

/** The checked-out branch of `cwd`, or `'main'` when git cannot name one. */
export function currentGitBranch(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, encoding: 'utf-8', stdio: GIT_STDIO,
    }).trim() || 'main'
  } catch {
    return 'main'
  }
}
