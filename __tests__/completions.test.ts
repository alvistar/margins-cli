import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from '@commander-js/extra-typings'
import { handleCompletions } from '../src/commands/completions.js'

function makeProgram(): Command {
  const prog = new Command().name('margins')
  const ws = prog.command('workspace').description('Workspace management')
  ws.command('list').description('List all workspaces')
  ws.command('sync [slug]').description('Trigger a git sync')
  prog.command('config').description('Manage CLI configuration')
  return prog
}

describe('handleCompletions', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit') }) as () => never)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('generates zsh completion script containing command names', () => {
    const prog = makeProgram()
    handleCompletions(prog, 'zsh')
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
    expect(output).toContain('_margins')
    expect(output).toContain('workspace')
    expect(output).toContain('config')
  })

  it('generates bash completion script', () => {
    const prog = makeProgram()
    handleCompletions(prog, 'bash')
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
    expect(output).toContain('_margins_completions')
    expect(output).toContain('workspace')
  })

  it('generates fish completion script', () => {
    const prog = makeProgram()
    handleCompletions(prog, 'fish')
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
    expect(output).toContain('complete -c margins')
    expect(output).toContain('workspace')
  })

  it('exits 1 for unsupported shell', () => {
    const prog = makeProgram()
    expect(() => handleCompletions(prog, 'powershell')).toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('prints install hint to stderr', () => {
    const prog = makeProgram()
    handleCompletions(prog, 'zsh')
    const errOutput = stderrSpy.mock.calls.map((c) => c[0]).join('')
    expect(errOutput).toContain('~/.zshrc')
  })
})
