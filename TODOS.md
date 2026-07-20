# TODOS

Deferred work for `margins-cli`, newest first. Same convention as the server
repo's `TODOS.md`: each entry says what the gap is, why it was not fixed at the
time, and what the real fix looks like.

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
