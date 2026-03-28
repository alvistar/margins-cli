import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { formatJson, formatError, maskKey, formatTable } from '../src/lib/output.js'
import { AuthMissing, NetworkError } from '../src/lib/errors.js'

describe('maskKey', () => {
  it('masks middle of key', () => {
    expect(maskKey('mrgn_abcdefghijklmnop')).toBe('mrgn_...nop')
  })

  it('masks short keys too (no full exposure for any length)', () => {
    expect(maskKey('short')).toBe('sh...')
  })

  it('handles undefined', () => {
    expect(maskKey(undefined)).toBe('(not set)')
  })
})

describe('formatJson', () => {
  it('returns valid JSON string for object', () => {
    const result = formatJson({ key: 'value', count: 3 })
    expect(JSON.parse(result)).toEqual({ key: 'value', count: 3 })
  })

  it('returns valid JSON string for array', () => {
    const result = formatJson([1, 2, 3])
    expect(JSON.parse(result)).toEqual([1, 2, 3])
  })
})

describe('formatError', () => {
  it('returns user message in human mode', () => {
    const e = new AuthMissing()
    const result = formatError(e, false)
    expect(result).toContain('margins auth login')
  })

  it('returns JSON in json mode', () => {
    const e = new NetworkError('https://margins.app')
    const result = formatError(e, true)
    const parsed = JSON.parse(result)
    expect(parsed).toHaveProperty('error')
    expect(parsed.error).toContain('https://margins.app')
    expect(parsed).toHaveProperty('code')
  })

  it('handles plain Error in json mode', () => {
    const e = new Error('plain error')
    const result = formatError(e, true)
    const parsed = JSON.parse(result)
    expect(parsed).toHaveProperty('error')
  })
})

describe('formatTable', () => {
  it('renders headers and rows', () => {
    const result = formatTable(
      ['Name', 'Status'],
      [['workspace-1', 'synced'], ['workspace-2', 'pending']],
    )
    expect(result).toContain('Name')
    expect(result).toContain('workspace-1')
    expect(result).toContain('synced')
  })

  it('returns empty message when no rows', () => {
    const result = formatTable(['Name'], [], 'No items found.')
    expect(result).toBe('No items found.')
  })
})
