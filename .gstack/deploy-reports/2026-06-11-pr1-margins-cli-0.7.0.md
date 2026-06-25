# LAND & DEPLOY REPORT — margins-cli PR #1 (0.7.0)

PR:          #1 — v0.7.0 credentialless OIDC sync, install, audit
Merged:      2026-06-11 (rebase) — f68ff42
Published:   margins-cli@0.7.0 → npm (Trusted Publishing, provenance, hermetic)
Final SHA:   57b8192

Deploy = npm publish via release.yaml (push to main, paths: package.json).

Publish took 4 attempts — 3 gate failures, each a distinct real issue:
  1. Non-hermetic OIDC test: "no mint attempt" asserted 1 fetch, but the release
     job's id-token:write env let the client re-mint (2 calls). Fixed: beforeEach
     clears ACTIONS_ID_TOKEN_REQUEST_* in the OIDC describe block (c5a2123).
  2. check:dist failed on stale committed dist/ (0.7.0 version bump not rebuilt).
     Rebuilt dist (4ed4077).
  3. check:dist failed again — cross-platform build nondeterminism: dev macOS/arm64
     bundle hashes != CI Linux/x64. Unwinnable from a dev machine. Dropped
     check:dist from prepublishOnly; npm tarball is rebuilt fresh by CI regardless,
     and the git-URL install (sole consumer of committed dist) is being retired
     for npm (57b8192).

Verification:
  npm view margins-cli@0.7.0   → 0.7.0, latest
  runtime dependencies         → none (hermetic)
  published tarball --version  → 0.7.0 (correct)

VERDICT: DEPLOYED AND VERIFIED — margins-cli@0.7.0 live on npm.
