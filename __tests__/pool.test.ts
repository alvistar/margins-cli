import { describe, it, expect } from 'vitest'
import { poolMap } from '../src/lib/pool.js'

describe('poolMap', () => {
  it('preserves input order even when later items finish first', async () => {
    const items = [50, 5, 20, 1, 10]
    const result = await poolMap(items, 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
      return `done-${ms}`
    })
    expect(result).toEqual(['done-50', 'done-5', 'done-20', 'done-1', 'done-10'])
  })

  it('never runs more than `concurrency` workers at once', async () => {
    let inFlight = 0
    let peak = 0
    await poolMap([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    })
    expect(peak).toBe(2)
  })

  it('a single failure rejects the whole pool', async () => {
    await expect(
      poolMap([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom on 2')
        return n
      }),
    ).rejects.toThrow('boom on 2')
  })

  it('returns an empty array for empty input without invoking the worker', async () => {
    let calls = 0
    const result = await poolMap([], 5, async () => { calls++ })
    expect(result).toEqual([])
    expect(calls).toBe(0)
  })
})
