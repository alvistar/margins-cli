import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { version: string }

// Build first so the binary exists
import { execSync } from 'node:child_process'
try {
  execSync('npm run build', { cwd: ROOT, stdio: 'pipe' })
} catch {
  // ignore — if build fails tests will fail naturally
}

function run(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync('node', [join(ROOT, 'bin/margins.js'), ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env, NO_COLOR: '1', MARGINS_CONFIG_DIR: '/tmp/margins-integration-test' },
    cwd: ROOT,
  })
}

describe('CLI binary smoke tests', () => {
  it('--help shows usage', () => {
    const result = run(['--help'])
    expect(result.stdout + result.stderr).toContain('margins')
    expect(result.status).toBe(0)
  })

  it('--version prints version from package.json', () => {
    const result = run(['-v'])
    expect(result.stdout + result.stderr).toContain(pkg.version)
    expect(result.status).toBe(0)
  })

  it('unknown command exits 2', () => {
    const result = run(['unknowncmd123'])
    expect(result.status).not.toBe(0)
  })

  it('config show --json outputs valid JSON when no config', () => {
    const result = run(['config', 'show', '--json'], {
      MARGINS_API_KEY: '',
      MARGINS_SERVER_URL: '',
    })
    expect(() => JSON.parse(result.stdout)).not.toThrow()
    const parsed = JSON.parse(result.stdout)
    expect(parsed).toHaveProperty('apiKey')
    expect(result.status).toBe(0)
  })
})

describe('discuss propose: empty anchor context on the command line (#38)', () => {
  // An unreachable server, so the command fails after option parsing and never reaches a real
  // host; its own config dir, so the propose it leaves in the outbox stays out of shared state.
  const base = ['discuss', 'propose', '--send', 'snd_1', '--attempt', '1', '--workspace', 'ws_1', '--replacement', 'x', '--anchor-text', 't']
  function runPropose(args: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'margins-propose-'))
    try {
      return spawnSync('node', [join(ROOT, 'bin/margins.js'), ...base, ...args], {
        encoding: 'utf-8',
        env: { ...process.env, NO_COLOR: '1', MARGINS_CONFIG_DIR: dir, MARGINS_SERVER_URL: 'http://127.0.0.1:9', MARGINS_API_KEY: 'mk_test' },
        cwd: ROOT,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('accepts an empty --anchor-prefix and --anchor-suffix and sends the propose', () => {
    const result = runPropose(['--anchor-prefix', '', '--anchor-suffix', ''])
    expect(result.stderr).toMatch(/Cannot reach http:\/\/127\.0\.0\.1:9/)
    expect(result.stderr).toMatch(/The propose stays in the outbox/)
  })

  it('still refuses a missing --anchor-prefix', () => {
    const result = runPropose(['--anchor-suffix', ''])
    expect(result.stderr).toMatch(/required option '--anchor-prefix <text>' not specified/)
    expect(result.status).not.toBe(0)
  })
})
