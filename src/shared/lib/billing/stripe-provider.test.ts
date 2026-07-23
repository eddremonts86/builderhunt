import { describe, expect, it } from 'vitest'
import { FakeBillingProvider } from './fake-provider'
import { getBillingProvider, resetBillingProviderForTests } from './stripe-provider'

/**
 * `getBillingProvider()` is a thin impure wrapper around the already-exhaustively-tested pure
 * `resolveStripeClientConfig` (stripe-client.test.ts) — same convention as `stripe-client.ts`'s own
 * untested `getStripeClient()`/`isLiveMode()`, which read the real frozen `env` singleton directly
 * and are not unit-mocked anywhere in this codebase. What IS testable here without mocking env:
 * this dev/test environment always has `STRIPE_BILLING_ENABLED=false`, so the fake-provider branch
 * and the singleton-reuse/reset behavior are exercised against the real configuration.
 */
describe('getBillingProvider', () => {
  it('returns the deterministic fake provider while Stripe billing is disabled', () => {
    resetBillingProviderForTests()
    expect(getBillingProvider()).toBeInstanceOf(FakeBillingProvider)
  })

  it('returns the same singleton instance across calls', () => {
    resetBillingProviderForTests()
    const first = getBillingProvider()
    const second = getBillingProvider()
    expect(second).toBe(first)
  })

  it('resetBillingProviderForTests forces a fresh instance', () => {
    resetBillingProviderForTests()
    const first = getBillingProvider()
    resetBillingProviderForTests()
    const second = getBillingProvider()
    expect(second).not.toBe(first)
  })
})
