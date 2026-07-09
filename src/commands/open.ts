/**
 * `margins open <target>` (M2 U6) — the ONE ergonomic entry:
 *   - a local filesystem path  → Margins Light: ensure the runtime (U5), then invoke its
 *     launcher to find-or-start the local daemon, seed the folder, and open the reader;
 *   - anything else (a hosted workspace slug) → the existing hosted `workspace open`.
 *
 * The launcher (shipped IN the runtime, KTD4) owns the daemon spawn + seed + browser open, so
 * this command is a thin: disambiguate → ensureRuntime → spawn `node <pkgRoot>/scripts/launcher.mjs`.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import type { ResolvedConfig } from '../lib/config.js'
import {
  ensureRuntime,
  runtimeSchemaVersion,
  assertRuntimeCompat,
  recordStoreSchemaHead,
} from '../lib/runtime.js'
import { MarginsError } from '../lib/errors.js'

/**
 * Local filesystem path (→ Margins Light) vs hosted workspace slug (→ hosted open). R6:
 * an explicit path shape (`.`, `./`, `../`, `/`, `~`) OR an existing path is local; a bare
 * `margins open` (no target) opens the cwd locally; everything else is a hosted slug.
 */
export function isLocalTarget(target: string | undefined): boolean {
  if (!target || target === '.') return true
  if (/^(\.\.?[/\\]|[/\\]|~)/.test(target)) return true
  try {
    return fs.existsSync(path.resolve(target))
  } catch {
    return false
  }
}

export async function handleOpen(cfg: ResolvedConfig, target: string | undefined): Promise<void> {
  if (!isLocalTarget(target)) {
    // Hosted workspace — unchanged behavior (needs Margins auth; the API surfaces 401 if absent).
    const { handleOpen: handleHostedOpen } = await import('./workspace/open.js')
    await handleHostedOpen(cfg, target)
    return
  }
  await openLocal(target ?? '.')
}

async function openLocal(target: string): Promise<void> {
  const abs = path.resolve(target)
  if (!fs.existsSync(abs)) {
    throw new MarginsError(`Path not found: ${target}`, `Path not found: ${target}`, 1)
  }
  // ensureRuntime asserts Node >= min (KTD6), resolves the read:packages token, installs +
  // caches the runtime if missing, and returns its package root (U5). Progress → stderr.
  const { version, pkgRoot } = await ensureRuntime({ log: (m) => process.stderr.write(m + '\n') })

  // PRE-boot compat gate (U7): refuse a runtime OLDER than the store's recorded schema head,
  // before the daemon opens/migrates the store (Codex #1). Newer is fine (forward-migrates).
  const schema = runtimeSchemaVersion(pkgRoot)
  assertRuntimeCompat(schema)

  const launcher = path.join(pkgRoot, 'scripts', 'launcher.mjs')
  if (!fs.existsSync(launcher)) {
    throw new MarginsError(
      'runtime launcher missing',
      `Runtime ${version} is missing its launcher. Run \`margins runtime clean\` and retry.`,
      1,
    )
  }
  // The launcher find-or-starts the daemon (standalone), seeds the folder, and opens the reader.
  // stdio:inherit so its progress + the reader URL reach the user directly.
  await new Promise<void>((resolve, reject) => {
    const child = spawn('node', [launcher, 'open', abs], { stdio: 'inherit' })
    child.on('error', (err) =>
      reject(new MarginsError(`launcher spawn failed: ${err.message}`, `Could not start Margins Light: ${err.message}`, 1)),
    )
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new MarginsError(`launcher exited ${code}`, `Margins Light exited with code ${code ?? 1}.`, code ?? 1)),
    )
  })

  // The runtime that just ran IS the store's new schema head — record it so a later open with an
  // OLDER runtime is refused (self-contained downgrade protection).
  if (schema) recordStoreSchemaHead(schema)
}
