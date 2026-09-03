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

## The `test` check is required on `main`, and admins can still bypass it (2026-07-27)

**Priority:** P4 — *reference, not work*

Recorded because it is repo settings, invisible in the tree, and easy to be
surprised by. `main` requires the `test` status check. `strict` is off (no
forced rebase before merge) and `enforce_admins` is off, so an admin can still
merge over a red run.

That bypass is deliberate. This repo has a known intermittent failure in
`install-hook.test.ts` whose cause is unproven (see the entry below), and a hard
gate would mean disabling branch protection to land a hotfix during a flake.
The gate blocks anyone else; the owner keeps an escape hatch and the judgment
about when to use it.

Unlike `ai-review` — a free private repo where required checks are unavailable
at all — this one is public, so the mechanism genuinely exists here.

**If the flake is ever explained and fixed**, turning `enforce_admins` on is the
one-line follow-up that makes the gate absolute.

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

## README has no reference section for three top-level commands (document-release, 2026-07-20)

**Priority:** P3

`margins open`, `margins share`, and `margins runtime` are real top-level commands
with no `###` reference section in `README.md`. `share` and `runtime` are not
mentioned in the file at all; `open` appears only inside the new `### stop`
section, which names it as the command that starts the daemon.

**`margins stop` was closed in 0.19.0.** It was the clearest case: it shipped in
**0.16.0** specifically because the launcher had always told users to run it while
the command did not exist, and still had no README entry three releases later — a
command going from missing, to implemented, to released, without the README ever
noticing. 0.19.0 changed its behaviour (it now delegates to the runtime's launcher
and reports five outcomes), so the section was written then.

**Why they were not documented in 0.17.0.** That release was scoped to content
mode. It added a `### sync` section because the top-level `sync` command carries
one of the release's new flags and was otherwise undocumented, so the flag would
have had nowhere to live. The other four (as it was then — `stop` has since been
documented) are unrelated to content mode, and folding four command sections into
a feature PR puts work in front of a reviewer who signed up to review something
else.

**The fix:** one `###` section per remaining command in the Commands part of `README.md`,
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
