# TODOS

Deferred work for `margins-cli`, newest first. Same convention as the server
repo's `TODOS.md`: each entry says what the gap is, why it was not fixed at the
time, and what the real fix looks like.

## Nothing here notices when `margins-sync-action`'s pin has drifted (0.18.0, 2026-07-27)

**Priority:** P3

`margins-sync-action` installs an exact `MARGINS_CLI_VERSION` — deliberately, so
`npx` cannot resolve mutable code into a consumer's run. The cost is that a
published CLI release and the action's pin can diverge indefinitely with both
repositories green. Nothing in either one is wrong; the pin is simply older, and
no check anywhere compares the two.

**The fix:** a scheduled workflow comparing the action's pinned version against
`npm view margins-cli version`, failing (or opening an issue) past some drift
threshold. It belongs in `margins-sync-action`, which owns the pin — this entry
is here because this is the repo whose releases create the drift.

**Do not size this by the last incident.** See the correction below: 0.18.0's pin
was bumped within minutes of the publish and the practical consequence would have
been zero either way, because the action never calls the affected command. Drift
matters when it strands a fix on a path the action actually uses, and a scheduled
check cannot tell those apart — it can only see that two version strings differ.
That argues for a low-noise signal (a monthly nudge) over a red build.

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

## The publish gate is the only test lane, and it runs a suite with a known flake (0.18.0, 2026-07-26)

**Priority:** P2

There is no PR test workflow in this repo. `release.yaml` is the only workflow,
it fires on a push to `main` that touches `package.json`, and the suite runs
inside it via `prepublishOnly`. So the first time the tests run on a machine
that is not a developer's laptop is *during the release*, and a failure there
does not fail a check — it blocks the publish.

That has already happened once. The 0.17.0 release failed on
`__tests__/sync-failure-record.test.ts:646` on 2026-07-20 and succeeded on a
re-run 29 minutes later, with no code change in between.

**A second one was observed while shipping 0.18.0.** In five full-suite runs,
`__tests__/install-hook.test.ts` failed once at the tag-push case (~line 300),
and passed 5/5 when that file was run alone.

The cause is not a race — it is an ordering bug in the harness. `useFakeMargins`
records each fake CLI invocation as a file named
`` `${process.pid}-${Date.now()}-${random}.json` `` (line 116) and reads them back
with `fs.readdirSync(logDir).sort()` (line 127). That sort is **lexicographic,
with the pid first**, and each hook invocation is a separate process — so the
ordering of `calls()` has no reliable relationship to the order the calls were
made. A pid that crosses a power of ten (`9999` then `10001`) or a lower pid
allocated later (`50210` then `4312`) silently inverts it:

```
chronological 9999 → 10001   sorted last = 9999   ← the FIRST call
chronological 50210 → 4312   sorted last = 50210  ← the FIRST call
```

The tests then wait for the call *count* to increase
(`fake.waitFor(afterBranchPush + 1)`, which returns as soon as `c.length >= n`,
line 134) and assert on `calls[calls.length - 1]` as though it meant "the newest
call". It means "the filename that sorted last". So the tag-push case can read
the *branch* push's call and fail. The same "wait for N, take the last" pattern
appears in the neighbouring branch-deletion and multi-ref tests, so the defect is
not confined to the case that happened to fail.

**Why it was not fixed in 0.18.0.** That PR is about 409 refusal handling and
touches none of these files. Rewriting the synchronisation of a test file the
PR does not otherwise change would put unreviewed work in front of a reviewer
who signed up for something else, and the flake predates it.

**The fix, in two parts:**
1. Make the waits content-addressed — wait for a call whose `--refs` contains
   the ref under test, instead of waiting for a count and taking the last call.
   Sorting the log filenames correctly (timestamp first, zero-padded) would make
   the flake rarer without fixing it: "the newest call" is still the wrong thing
   to assert on when the test means "the call for this ref".
2. Add a PR test workflow, so the suite runs on a fresh Linux runner before
   merge rather than during publish. Both known flakes were found by a
   non-laptop environment; neither had a chance to be found earlier, because
   no such environment ran until the release did.

Until part 2 exists, treat a red release run as "re-run it once and read the
failure" rather than as a broken build — and do not assume a green local suite
predicts a green publish.

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
