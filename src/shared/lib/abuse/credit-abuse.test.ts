import { describe, expect, it, vi } from 'vitest'
import {
  checkFirstPayerSpendVelocityAndEmit,
  checkPoolDrainAndEmit,
  computeSeatShare,
  detectFirstPayerCapExceeded,
  detectPoolDrain,
  isWithinFirstPayerWindow,
} from './credit-abuse'

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

describe('isWithinFirstPayerWindow', () => {
  const now = new Date('2026-01-10T00:00:00.000Z')

  it('is never true when the org has never paid', () => {
    expect(isWithinFirstPayerWindow({ firstPaidGrantAt: null, now, windowHours: 48 })).toBe(false)
  })

  it('is true when the first paid grant is inside the window', () => {
    const firstPaidGrantAt = new Date(now.getTime() - 10 * 60 * 60 * 1000) // 10h ago
    expect(isWithinFirstPayerWindow({ firstPaidGrantAt, now, windowHours: 48 })).toBe(true)
  })

  it('is false once the first paid grant is older than the window', () => {
    const firstPaidGrantAt = new Date(now.getTime() - 49 * 60 * 60 * 1000) // 49h ago
    expect(isWithinFirstPayerWindow({ firstPaidGrantAt, now, windowHours: 48 })).toBe(false)
  })

  it('is false for a grant timestamp in the future (defensive, should never happen)', () => {
    const firstPaidGrantAt = new Date(now.getTime() + 60 * 60 * 1000)
    expect(isWithinFirstPayerWindow({ firstPaidGrantAt, now, windowHours: 48 })).toBe(false)
  })
})

describe('detectFirstPayerCapExceeded', () => {
  it('does not flag when the running total stays at or under the cap', () => {
    expect(detectFirstPayerCapExceeded({ unitsReservedInWindow: 0, thisReservationUnits: 500, cap: 500 })).toBe(false)
    expect(detectFirstPayerCapExceeded({ unitsReservedInWindow: 400, thisReservationUnits: 50, cap: 500 })).toBe(false)
  })

  it('flags once the running total (including this reservation) exceeds the cap', () => {
    expect(detectFirstPayerCapExceeded({ unitsReservedInWindow: 400, thisReservationUnits: 101, cap: 500 })).toBe(true)
  })
})

describe('checkFirstPayerSpendVelocityAndEmit', () => {
  it('does not emit while the new payer stays within the cap', async () => {
    const insert = vi.fn()
    const flagged = await checkFirstPayerSpendVelocityAndEmit(
      { unitsReservedInWindow: 100, thisReservationUnits: 50, cap: 500, windowHours: 48 },
      { userId: 'user-1', organizationId: 'org-1', requestId: 'req-1' },
      { insert, sink: { write: vi.fn() } },
    )
    expect(flagged).toBe(false)
    expect(insert).not.toHaveBeenCalled()
  })

  it('emits credit_spend_velocity once the new payer\'s window consumption crosses the cap', async () => {
    const insert = vi.fn()
    const flagged = await checkFirstPayerSpendVelocityAndEmit(
      { unitsReservedInWindow: 480, thisReservationUnits: 50, cap: 500, windowHours: 48 },
      { userId: 'user-1', organizationId: 'org-1', requestId: 'req-1' },
      { insert, sink: { write: vi.fn() } },
    )
    expect(flagged).toBe(true)
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'credit_spend_velocity',
      severity: 'high',
      userId: 'user-1',
      organizationId: 'org-1',
      details: expect.objectContaining({ unitsReservedInWindow: 480, thisReservationUnits: 50, cap: 500, windowHours: 48 }),
    }))
  })
})
