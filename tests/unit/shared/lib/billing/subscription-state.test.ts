import { describe, expect, it } from 'vitest'
import {
  isMonotonicallyNewer,
  isTerminalStatus,
  resolveSubscriptionTransition,
} from '~/shared/lib/billing/subscription-state'

describe('isTerminalStatus', () => {
  it('treats canceled and incomplete_expired as terminal', () => {
    expect(isTerminalStatus('canceled')).toBe(true)
    expect(isTerminalStatus('incomplete_expired')).toBe(true)
  })

  it.each(['active', 'past_due', 'unpaid', 'incomplete', 'trialing', 'paused'])('treats %s as non-terminal', (status) => {
    expect(isTerminalStatus(status)).toBe(false)
  })
})

describe('isMonotonicallyNewer', () => {
  it('is true when the event is after the last-synced timestamp', () => {
    expect(isMonotonicallyNewer(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z'))).toBe(true)
  })

  it('is true when the event is at exactly the last-synced timestamp (duplicate delivery)', () => {
    const t = new Date('2026-01-01T00:00:00Z')
    expect(isMonotonicallyNewer(t, t)).toBe(true)
  })

  it('is false when the event is before the last-synced timestamp (delayed/out-of-order delivery)', () => {
    expect(isMonotonicallyNewer(new Date('2026-01-02T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))).toBe(false)
  })
})

describe('resolveSubscriptionTransition', () => {
  const t0 = new Date('2026-01-01T00:00:00Z')
  const t1 = new Date('2026-01-02T00:00:00Z')
  const t2 = new Date('2026-01-03T00:00:00Z')

  it('always applies the first event ever seen for a subscription', () => {
    expect(resolveSubscriptionTransition(null, { status: 'active', eventTimestamp: t0 }))
      .toEqual({ apply: true, reason: 'first_seen' })
  })

  it('applies a newer event with a different status', () => {
    const current = { status: 'incomplete', providerSyncedAt: t0 }
    expect(resolveSubscriptionTransition(current, { status: 'active', eventTimestamp: t1 }))
      .toEqual({ apply: true, reason: 'newer' })
  })

  it('applies (as a no-op write) a duplicate event with identical status and timestamp', () => {
    const current = { status: 'active', providerSyncedAt: t1 }
    expect(resolveSubscriptionTransition(current, { status: 'active', eventTimestamp: t1 }))
      .toEqual({ apply: true, reason: 'duplicate' })
  })

  it('rejects a stale (delayed/out-of-order) event older than the current state', () => {
    const current = { status: 'active', providerSyncedAt: t2 }
    expect(resolveSubscriptionTransition(current, { status: 'past_due', eventTimestamp: t1 }))
      .toEqual({ apply: false, reason: 'stale' })
  })

  it('locks out any further transition once the current status is terminal (canceled)', () => {
    const current = { status: 'canceled', providerSyncedAt: t1 }
    expect(resolveSubscriptionTransition(current, { status: 'active', eventTimestamp: t2 }))
      .toEqual({ apply: false, reason: 'terminal_locked' })
  })

  it('locks out a transition from incomplete_expired too, even with a newer timestamp', () => {
    const current = { status: 'incomplete_expired', providerSyncedAt: t0 }
    expect(resolveSubscriptionTransition(current, { status: 'trialing', eventTimestamp: t2 }))
      .toEqual({ apply: false, reason: 'terminal_locked' })
  })

  it('a reversed-order permutation: applying events out of order still converges on the newest one winning', () => {
    // Simulates delivering created(t0, incomplete) -> updated(t2, active) -> updated(t1, past_due) —
    // the last one (t1) must be rejected as stale since t2's state is already recorded.
    let current: { status: string; providerSyncedAt: Date } | null = null

    const first = resolveSubscriptionTransition(current, { status: 'incomplete', eventTimestamp: t0 })
    expect(first.apply).toBe(true)
    current = { status: 'incomplete', providerSyncedAt: t0 }

    const second = resolveSubscriptionTransition(current, { status: 'active', eventTimestamp: t2 })
    expect(second.apply).toBe(true)
    current = { status: 'active', providerSyncedAt: t2 }

    const third = resolveSubscriptionTransition(current, { status: 'past_due', eventTimestamp: t1 })
    expect(third).toEqual({ apply: false, reason: 'stale' })
    // current is unchanged — still reflects the t2 'active' state, not the stale t1 'past_due'.
    expect(current).toEqual({ status: 'active', providerSyncedAt: t2 })
  })
})
