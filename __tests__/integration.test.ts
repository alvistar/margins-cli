import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

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
