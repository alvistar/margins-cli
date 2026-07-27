# TODOS

Deferred work for `margins-cli`, newest first. Same convention as the server
repo's `TODOS.md`: each entry says what the gap is, why it was not fixed at the
time, and what the real fix looks like.

## An intermittent `install-hook` failure was reported and never explained (2026-07-27)

**Priority:** P3 — *open, but do not act on it without new evidence*

While shipping 0.18.0, `__tests__/install-hook.test.ts` was reported to fail once
in five full-suite runs at the tag-push assertion, and to pass 5/5 in isolation.
Two real harness defects were found and fixed on the strength of that report — a
pid-lexicographic sort used as if it were chronological, and a non-atomic record
write. **Neither of them explains the reported rate**, and the report itself does
not survive scrutiny:

| candidate | measured | verdict |
|---|---|---|
| pid-sort inversion | 0 in 500 sequential spawns; <1% computed at a power-of-ten boundary | far too rare |
| non-atomic write | 69 short reads in 3.4M stat samples | far too rare, and throws a JSON parse error rather than failing the reported assertion |
| reproduction attempt | 0 failures in 12 full-suite runs on the unfixed harness | nothing |

The failure output was **never captured**. The only record of it is prose. "One
in five" was one event in five runs, which is consistent with a true rate
anywhere from roughly 0.5% to 45%. A second opinion from another model, given the
harness source and these measurements, returned "NO HIGH-RATE MECHANISM FOUND".

**Leading untested hypothesis:** `waitFor`/`waitForCall` use a fixed 10-second
deadline. Under a full suite — 49 files across parallel workers — a backgrounded
hook exceeding that would fail and would pass in isolation, which matches the one
thing actually observed. It is deliberately **not** fixed: hardening it would be
treating an unfalsifiable hypothesis as a diagnosis, which is the mistake this
entry exists to avoid repeating.

**What to do instead:** nothing, until it recurs. `waitForCall` now prints every
recorded call on timeout, so the next occurrence yields a real failure to reason
from. Capture that output before changing anything.

## The typecheck baseline is 14 errors, so the PR lane cannot gate on types (2026-07-27)

**Priority:** P3

`npx tsc --noEmit` reports 14 errors on `main`. There is no `typecheck` script in
`package.json` and nothing in CI runs one, so the baseline has been free to grow.

`tests.yaml` deliberately does **not** include a typecheck job. A lane that is red
on its first run teaches everyone to ignore it, and an ignored lane is worse than
an absent one — it looks like coverage while providing none.

**The fix:** clear the 14 errors, add a `typecheck` script, then add the job to
`tests.yaml`. Doing it in that order matters; adding the job first just moves the
red into everyone's PR.

**Worth knowing:** `npm run build` (tsdown) passes with those errors present, so
the build is not a backstop for type correctness here — the same trap documented
on the server side, where `next build` stayed green through 66 type errors.

## The PR test lane is advisory; branch protection is available but unset (2026-07-27)

**Priority:** P3

`tests.yaml` runs on every pull request, but nothing requires it to be green
before a merge. `gh pr merge` will happily merge over a red or still-pending run.

Unlike `ai-review` — a free private repo where required status checks are simply
unavailable — this repo is **public**, so branch protection can genuinely enforce
the check. The switch is deliberately unset: making a check required changes the
merge flow for every future PR, and that is a repo-owner decision rather than
something a test-infrastructure PR should decide on its own.

**The fix, if wanted:** a branch protection rule on `main` requiring the `test`
job. No code change. Until then, "CI gates the PR" is discipline here, not a
mechanism — wait for the lane yourself before merging.

## `margins-sync-action`'s pin can trail a release, and nothing in this repo notices (0.18.0, 2026-07-27)

**Priority:** P3 — *partially addressed; see below*

`margins-sync-action` installs an exact `MARGINS_CLI_VERSION` — deliberately, so
`npx` cannot resolve mutable code into a consumer's run. The cost is that a
published CLI release and the action's pin can diverge indefinitely with both
repositories green.

**A monthly drift report now exists** in `margins-sync-action`
(`.github/workflows/pin-drift.yaml`). It compares the pin against
`npm view margins-cli version` and reports; it never fails a build. What remains
open is only whether a monthly summary is a strong enough signal to be noticed.

**Do not size this by the last incident.** 0.18.0's pin was bumped within minutes
of the publish, and the practical consequence would have been zero either way,
because the action never calls the affected command. Drift matters when it strands
a fix on a path the action actually uses, and a version-string comparison cannot
tell those apart — it can only see that two strings differ.

### Correction: what the 0.18.0 version of this entry got wrong

This entry previously claimed P1 urgency on the grounds that "every CI sync keeps
running 0.17.0, which is the version that turns a server refusal into a private
workspace," and that bumping the pin should "expect assertions to move." **Both
halves were wrong**, and are recorded here rather than deleted because the
mistake is more reusable than the entry was.

`margins install` — the command that creates a workspace, and therefore the only
one that can hit the `SLUG_CONFLICT` refusal — runs on the **operator's machine**.
`margins-sync-action` runs `workspace push` and `workspace archive-branch`
against a `workspace-id` that already exists, and `src/commands/workspace/push.ts`
is untouched by 0.18.0. The action's CI runs never reach the bug. Its e2e asserts
on `workspace push`, so no assertion moved either; the bump landed as
`margins-sync-action@v1.2.1` with a passing suite and no consumer-visible change.

The error was assuming a fix reaches everyone downstream because the fix is
important. It was made three times in one session, each time corrected only by
reading the actual call path. **Before claiming a release reaches a consumer,
name the command that consumer runs and check the release touched it.**

## README has no reference section for four top-level commands (document-release, 2026-07-20)

**Priority:** P3

`margins open`, `margins share`, `margins stop`, and `margins runtime` are real
top-level commands with no `###` reference section in `README.md`. `share` and
`runtime` are not mentioned in the file at all; `open` appears once in passing.

`margins stop` is the clearest case. It shipped in **0.16.0** specifically because
the launcher had always told users to run it while the command did not exist — and
it still has no README entry. A command can therefore go from missing, to
implemented, to released, without the README ever noticing.

**Why they were not documented in 0.17.0.** That release was scoped to content
mode. It added a `### sync` section because the top-level `sync` command carries
one of the release's new flags and was otherwise undocumented, so the flag would
have had nowhere to live. The other four are unrelated to content mode, and
folding four command sections into a feature PR puts work in front of a reviewer
who signed up to review something else.

**The fix:** one `###` section per command in the Commands part of `README.md`,
matching the existing shape — one-line purpose, a short `sh` block, a flag table,
and any behavior a reader cannot guess. Verify each against the command's own
`--help` rather than from memory; that is how the flag list stays true.

**Worth considering alongside it:** nothing checks that a registered command has
a README section. The command list is available at runtime (`margins --help`), so
a test could compare it against the `###` headings in `README.md` and fail when a
command has no section. That would turn this class of drift into a failing test
instead of something a person has to notice. It is also the same shape as the
command-manifest idea recorded on the server side for the website's CLI reference
page, so the two are worth designing together rather than twice.
