import { afterEach, describe, expect, it, vi } from 'vitest'
import { assignVariant, getStableVariant, resolveTreatmentAllocationPct } from './conversion-variant'

describe('resolveTreatmentAllocationPct', () => {
  it('defaults to 10 when unset', () => {
    expect(resolveTreatmentAllocationPct()).toBe(10)
  })
})

describe('assignVariant', () => {
  it('assigns baseline when the random draw exceeds the allocation', () => {
    expect(assignVariant(() => 0.99)).toBe('baseline')
  })

  it('assigns treatment when the random draw falls within the allocation', () => {
    expect(assignVariant(() => 0.0)).toBe('treatment')
  })
})

describe('getStableVariant', () => {
  afterEach(() => {
    window.sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('assigns once and reuses the same variant on subsequent calls', () => {
    const random = vi.fn().mockReturnValueOnce(0.0).mockReturnValueOnce(0.99)
    const first = getStableVariant(random)
    const second = getStableVariant(random)
    expect(first).toBe(second)
    expect(random).toHaveBeenCalledTimes(1)
  })

  it('persists the assignment in sessionStorage', () => {
    getStableVariant(() => 0.0)
    expect(window.sessionStorage.getItem('bh-conversion-variant')).toBe('treatment')
  })
})
