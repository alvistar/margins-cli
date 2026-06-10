import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Resolve the CLI's own version from package.json (same source `--version`
 * uses in src/index.ts). Two candidate paths because this module lives at
 * `dist/` (bundled, package.json one level up) in releases and at `src/lib/`
 * (two levels up) in dev/tests.
 */
function readVersion(): string {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(join(__dirname, rel), 'utf-8')) as {
        name?: string
        version?: string
      }
      if (pkg.name === 'margins-cli' && pkg.version) return pkg.version
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0'
}

export const CLI_VERSION = readVersion()
