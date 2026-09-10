# margins-stash-core

Shared internals of the Margins **stash** — a one-off, single-document workspace
for review.

Two programs publish stashes: the [`margins`
CLI](https://github.com/alvistar/margins-cli) and the Margins Light daemon that
backs the desktop app's **Share** button. They must reach the *same* stash from
the same file, so the parts where they could silently disagree live here rather
than twice:

- **Config directory resolution.** `MARGINS_CONFIG_DIR`, then an existing
  `$XDG_CONFIG_HOME/margins/`, then the platform default. Two copies of this walk
  would eventually look in different places, and the symptom would be a daemon
  reporting "no API key" on a machine where `margins auth` plainly works.
- **The binding store.** Which stash a file is bound to, the project-versus-global
  store choice, the trust rule for a binding this machine did not write, and the
  symlink guard on both.
- **The create/update recovery matrix.** What a 403, a 404, a 405 and a 409 each
  mean for a bound file, and which of them may safely create a fresh stash.

It prompts nothing and prints nothing. Every outcome is a return value, and the
two callers word it for their own user.

## Install

```sh
npm install margins-stash-core
```

## Use

```ts
import {
  createFetchStashHttp,
  resolveCredential,
  upsertStash,
  buildStashReviewUrl,
} from 'margins-stash-core'

const cred = resolveCredential()
if (!cred.ok) throw new Error(cred.problem) // NO_API_KEY | SESSION_ONLY

const result = await upsertStash({
  http: createFetchStashHttp({ serverUrl: cred.serverUrl, apiKey: cred.apiKey }),
  content: markdown,
  filePath: '/abs/path/to/notes.md', // omit for stdin: nothing to bind
  title: 'Notes',
  parentSha: lastKnownHead, // the server answers 409 rather than overwriting
})

if (!result.ok) {
  // UNAUTHORIZED | KEY_ROLE | OLD_SERVER | CONFLICT | SLUG_CONFLICT
  //   | VALIDATION | SERVER | NETWORK
  return handle(result.failure)
}
console.log(buildStashReviewUrl(cred.serverUrl, result.slug))
```

`result.rebound` means the bound stash was gone, foreign, or untrusted and a new
one was created: the previous link is dead, and `reboundReason` says which of the
three happened.

Publishing a stash needs an API key with the `edit` role. A `margins auth login`
session is deliberately **not** accepted — see `resolveCredential`.

## Licence

MIT
