# Changelog

All notable changes to margins-cli will be documented in this file.

## [0.5.1] - 2026-04-21

### Added
- `margins sync [dir]` top-level command for terminal and agent-driven folder setup
- Shared registry module (`src/lib/registry.ts`) with atomic writes (.tmp + rename)
- Git remote detection ported from Rust (`src/lib/detect-git-remote.ts`)
- Tests for registry and git remote detection

### Changed
- Extracted registry logic from `unsync.ts` into shared module

## [0.5.0] - 2026-04-20

### Added
- Published to npm registry (`@anthropic/margins-cli`)
- Global install documentation
