import { describe, expect, it } from 'vitest'
import { isCapped, nextCursor } from '~/lib/discovery/worker'

describe('isCapped', () => {
  it('is not capped below the cap', () => {
    expect(isCapped(0, 1500)).toBe(false)
    expect(isCapped(1499, 1500)).toBe(false)
  })

  it('is capped exactly at the cap and beyond', () => {
    expect(isCapped(1500, 1500)).toBe(true)
    expect(isCapped(1501, 1500)).toBe(true)
  })
})

describe('nextCursor', () => {
  it('advances within bounds', () => {
    expect(nextCursor(0, 1, 60)).toBe(1)
    expect(nextCursor(5, 2, 60)).toBe(7)
  })

  it('wraps past the matrix length back to 0', () => {
    expect(nextCursor(59, 1, 60)).toBe(0)
    expect(nextCursor(60, 1, 60)).toBe(1)
  })

  it('handles a zero-length matrix without throwing', () => {
    expect(nextCursor(0, 1, 0)).toBe(0)
  })

  it('handles a negative starting cursor safely', () => {
    expect(nextCursor(-1, 1, 60)).toBe(0)
  })
})
