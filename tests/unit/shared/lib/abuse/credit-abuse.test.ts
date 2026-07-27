import { describe, expect, it, vi } from 'vitest'
import {
  checkFirstPayerSpendVelocityAndEmit,
  checkPoolDrainAndEmit,
  checkPromoGrantClusterCapAndEmit,
  checkRefundFarmingAndEmit,
  computeSeatShare,
  detectFirstPayerCapExceeded,
  detectPoolDrain,
  detectPromoGrantClusterCapExceeded,
  detectRefundCapExceeded,
  detectRefundFarming,
  isWithinFirstPayerWindow,
} from '~/shared/lib/abuse/credit-abuse'

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

describe('detectRefundCapExceeded', () => {
  it('does not flag when the running total stays at or under the cap', () => {
    expect(detectRefundCapExceeded({ refundedUnitsInWindow: 0, thisRefundUnits: 300, cap: 300 })).toBe(false)
    expect(detectRefundCapExceeded({ refundedUnitsInWindow: 250, thisRefundUnits: 50, cap: 300 })).toBe(false)
  })

  it('flags once the running total (including this refund) exceeds the cap', () => {
    expect(detectRefundCapExceeded({ refundedUnitsInWindow: 250, thisRefundUnits: 51, cap: 300 })).toBe(true)
  })
})

describe('detectRefundFarming', () => {
  it('never flags below the minimum settled-units sample size, however high the ratio', () => {
    expect(detectRefundFarming({ refundedUnits: 10, settledUnits: 10, ratioThreshold: 0.5, minSettledUnits: 100 })).toBe(false)
  })

  it('does not flag a ratio at or under the threshold', () => {
    expect(detectRefundFarming({ refundedUnits: 50, settledUnits: 100, ratioThreshold: 0.5, minSettledUnits: 100 })).toBe(false)
  })

  it('flags a ratio over the threshold with enough settled volume', () => {
    expect(detectRefundFarming({ refundedUnits: 51, settledUnits: 100, ratioThreshold: 0.5, minSettledUnits: 100 })).toBe(true)
  })
})

describe('checkRefundFarmingAndEmit', () => {
  it('does not emit for a small sample even at a high ratio', async () => {
    const insert = vi.fn()
    const flagged = await checkRefundFarmingAndEmit(
      { refundedUnits: 10, settledUnits: 10, ratioThreshold: 0.5, minSettledUnits: 100, windowHours: 720 },
      { userId: 'user-1', organizationId: 'org-1', requestId: 'req-1' },
      { insert, sink: { write: vi.fn() } },
    )
    expect(flagged).toBe(false)
    expect(insert).not.toHaveBeenCalled()
  })

  it('emits refund_farming with the computed ratio once the threshold is crossed with enough volume', async () => {
    const insert = vi.fn()
    const flagged = await checkRefundFarmingAndEmit(
      { refundedUnits: 60, settledUnits: 100, ratioThreshold: 0.5, minSettledUnits: 100, windowHours: 720 },
      { userId: 'user-1', organizationId: 'org-1', requestId: 'req-1' },
      { insert, sink: { write: vi.fn() } },
    )
    expect(flagged).toBe(true)
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'refund_farming',
      severity: 'high',
      userId: 'user-1',
      organizationId: 'org-1',
      details: expect.objectContaining({ refundedUnits: 60, settledUnits: 100, ratio: 0.6, ratioThreshold: 0.5, windowHours: 720 }),
    }))
  })
})

describe('detectPromoGrantClusterCapExceeded', () => {
  it('does not flag while minting one more grant stays at or under the cap', () => {
    expect(detectPromoGrantClusterCapExceeded({ existingGrantsInCluster: 2, cap: 3 })).toBe(false)
  })

  it('flags once minting one more grant would exceed the cap', () => {
    expect(detectPromoGrantClusterCapExceeded({ existingGrantsInCluster: 3, cap: 3 })).toBe(true)
  })

  it('never allows a cluster with zero prior grants to exceed a cap of 0 or fewer (defensive — cap should always be positive)', () => {
    expect(detectPromoGrantClusterCapExceeded({ existingGrantsInCluster: 0, cap: 0 })).toBe(true)
  })
})

describe('checkPromoGrantClusterCapAndEmit', () => {
  it('does not emit while the cluster stays under the cap', async () => {
    const insert = vi.fn()
    const flagged = await checkPromoGrantClusterCapAndEmit(
      { existingGrantsInCluster: 1, cap: 3, clusterOrganizationIds: ['org-1', 'org-2'] },
      { userId: 'user-1', organizationId: 'org-1', requestId: 'req-1' },
      { insert, sink: { write: vi.fn() } },
    )
    expect(flagged).toBe(false)
    expect(insert).not.toHaveBeenCalled()
  })

  it('emits credit_farming once the cluster would exceed its promo grant cap', async () => {
    const insert = vi.fn()
    const flagged = await checkPromoGrantClusterCapAndEmit(
      { existingGrantsInCluster: 3, cap: 3, clusterOrganizationIds: ['org-1', 'org-2', 'org-3'] },
      { userId: 'user-1', organizationId: 'org-1', requestId: 'req-1' },
      { insert, sink: { write: vi.fn() } },
    )
    expect(flagged).toBe(true)
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'credit_farming',
      severity: 'high',
      userId: 'user-1',
      organizationId: 'org-1',
      details: expect.objectContaining({
        existingGrantsInCluster: 3,
        cap: 3,
        clusterOrganizationIds: ['org-1', 'org-2', 'org-3'],
      }),
    }))
  })
})
