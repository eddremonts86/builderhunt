import { describe, expect, it, vi } from 'vitest'
import { checkPoolDrainAndEmit, computeSeatShare, detectPoolDrain } from './credit-abuse'

describe('computeSeatShare', () => {
  it('returns 0 when the pool total is zero or negative', () => {
    expect(computeSeatShare({ seatUnits: 50, poolTotalUnits: 0 })).toBe(0)
    expect(computeSeatShare({ seatUnits: 50, poolTotalUnits: -10 })).toBe(0)
  })

  it('returns the seat\'s fraction of the pool', () => {
    expect(computeSeatShare({ seatUnits: 25, poolTotalUnits: 100 })).toBe(0.25)
    expect(computeSeatShare({ seatUnits: 100, poolTotalUnits: 100 })).toBe(1)
  })
})

describe('detectPoolDrain', () => {
  it('never flags a single-seat org, no matter how much it consumes', () => {
    expect(detectPoolDrain({ seatUnits: 100_000, cap: 2000, seatCount: 1 })).toBe(false)
  })

  it('never flags a multi-seat org whose seat stays at or under the cap', () => {
    expect(detectPoolDrain({ seatUnits: 2000, cap: 2000, seatCount: 3 })).toBe(false)
    expect(detectPoolDrain({ seatUnits: 1000, cap: 2000, seatCount: 3 })).toBe(false)
  })

  it('flags a multi-seat org whose seat exceeds the cap', () => {
    expect(detectPoolDrain({ seatUnits: 2001, cap: 2000, seatCount: 3 })).toBe(true)
  })
})

describe('checkPoolDrainAndEmit', () => {
  it('does not emit when the seat is within its sub-cap', async () => {
    const insert = vi.fn()
    const flagged = await checkPoolDrainAndEmit(
      { seatUnits: 500, cap: 2000, seatCount: 3, poolTotalUnits: 900 },
      { userId: 'user-1', organizationId: 'org-1', requestId: 'req-1' },
      { insert, sink: { write: vi.fn() } },
    )
    expect(flagged).toBe(false)
    expect(insert).not.toHaveBeenCalled()
  })

  it('does not emit for a single-seat org even over the cap', async () => {
    const insert = vi.fn()
    const flagged = await checkPoolDrainAndEmit(
      { seatUnits: 5000, cap: 2000, seatCount: 1, poolTotalUnits: 5000 },
      { userId: 'user-1', organizationId: 'org-1', requestId: 'req-1' },
      { insert, sink: { write: vi.fn() } },
    )
    expect(flagged).toBe(false)
    expect(insert).not.toHaveBeenCalled()
  })

  it('emits pool_drain with the computed share when a multi-seat org\'s seat exceeds the cap', async () => {
    const insert = vi.fn()
    const flagged = await checkPoolDrainAndEmit(
      { seatUnits: 3000, cap: 2000, seatCount: 4, poolTotalUnits: 4000 },
      { userId: 'user-1', organizationId: 'org-1', requestId: 'req-1' },
      { insert, sink: { write: vi.fn() } },
    )
    expect(flagged).toBe(true)
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pool_drain',
      severity: 'medium',
      userId: 'user-1',
      organizationId: 'org-1',
      details: expect.objectContaining({ seatUnits: 3000, cap: 2000, seatCount: 4, share: 0.75 }),
    }))
  })
})
