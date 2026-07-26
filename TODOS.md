# TODOS

Deferred work for `margins-cli`, newest first. Same convention as the server
repo's `TODOS.md`: each entry says what the gap is, why it was not fixed at the
time, and what the real fix looks like.

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
and passed 5/5 when that file was run alone. The shape of the test explains it:
it waits for the call *count* to increase (`fake.waitFor(afterBranchPush + 1)`)
and then asserts on `calls[calls.length - 1]`, so if the branch push's hook
invocation is still in flight the last call is the branch's, not the tag's.
Nothing pins the assertion to the call it means. The same "wait for N, take the
last" pattern appears in the neighbouring branch-deletion and multi-ref tests.

**Why it was not fixed in 0.18.0.** That PR is about 409 refusal handling and
touches none of these files. Rewriting the synchronisation of a test file the
PR does not otherwise change would put unreviewed work in front of a reviewer
who signed up for something else, and the flake predates it.

**The fix, in two parts:**
1. Make the waits content-addressed — wait for a call whose `--refs` contains
   the ref under test, instead of waiting for a count and taking the last call.
2. Add a PR test workflow, so the suite runs on a fresh Linux runner before
   merge rather than during publish. Both known flakes were found by a
   non-laptop environment; neither had a chance to be found earlier, because
   no such environment ran until the release did.

Until part 2 exists, treat a red release run as "re-run it once and read the
failure" rather than as a broken build — and do not assume a green local suite
predicts a green publish.

## `margins-sync-action` pins the CLI version, so 0.18.0 reaches no workflow until the pin moves (0.18.0, 2026-07-26)

**Priority:** P1

`margins-sync-action` installs a pinned `MARGINS_CLI_VERSION`. Publishing 0.18.0
to npm therefore changes nothing for any repository using the action: every CI
sync keeps running 0.17.0, which is the version that turns a server refusal into
a private workspace nobody asked for. The bug 0.18.0 exists to fix is *most*
harmful in CI, because that is where the only warning about it is suppressed
under `--json` — so the population still exposed after this release is exactly
the population it was written for.

**Why it is not in this PR.** The pin lives in a different repository, and the
bump cannot be validated until 0.18.0 is actually published to npm — the action's
e2e suite installs the pinned version and asserts against its runtime behavior,
so a pin bumped ahead of the publish fails against a version the registry does
not yet have.

**The fix:** after `margins-cli@0.18.0` is on npm, bump `MARGINS_CLI_VERSION` in
`margins-sync-action` and run its e2e suite. Expect assertions to move: this
release changes `margins install`'s refused-repo exit code from 1 to 0 and adds a
`serverCode` field to the `--json` error envelope, and that suite asserts on the
pinned CLI's observable behavior rather than mocking it.

**Worth considering alongside it:** nothing tells this repo when the pin has
drifted. A published CLI release and the action's pin can diverge indefinitely
with both repositories green, which is how a fix ships and does not arrive. A
scheduled check comparing the action's pin against the latest npm version would
turn that silence into a signal.

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
