import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeBillingProvider } from '~/shared/lib/billing/fake-provider'
import { BillingProviderError } from '~/shared/lib/billing/provider'
import type { CreateCheckoutSessionInput } from '~/shared/lib/billing/provider'
import { getBillingProvider, resetBillingProviderForTests } from '~/shared/lib/billing/stripe-provider'

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

/**
 * Wave 1 Task 4 — E2E billing scenario seam
 * (docs/superpowers/plans/2026-07-23-wave1-task4-external-fakes.md §Step 2).
 *
 * Under `E2E_MODE=true` the provider seam always resolves to the
 * deterministic fake (never real Stripe — E2E forbids Stripe egress), and
 * `E2E_BILLING_SCENARIO` supplies the DEFAULT `scenario` for every create
 * call. A per-call `scenario` still wins over the env default.
 */
describe('getBillingProvider under E2E_MODE', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    resetBillingProviderForTests()
  })

  function checkoutInput(overrides: Partial<CreateCheckoutSessionInput> = {}): CreateCheckoutSessionInput {
    return {
      customerId: 'cus_e2e_test',
      mode: 'subscription',
      priceId: 'price_e2e_test',
      successUrl: 'http://localhost:3000/billing/success',
      cancelUrl: 'http://localhost:3000/billing/cancel',
      idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
      ...overrides,
    }
  }

  it('returns a FakeBillingProvider regardless of STRIPE_BILLING_ENABLED', () => {
    vi.stubEnv('E2E_MODE', 'true')
    resetBillingProviderForTests()
    expect(getBillingProvider()).toBeInstanceOf(FakeBillingProvider)
  })

  it('E2E_BILLING_SCENARIO=decline is the default: a create call without a scenario throws decline', async () => {
    vi.stubEnv('E2E_MODE', 'true')
    vi.stubEnv('E2E_BILLING_SCENARIO', 'decline')
    resetBillingProviderForTests()

    const provider = getBillingProvider()
    await expect(provider.createCheckoutSession(checkoutInput())).rejects.toMatchObject({
      name: 'BillingProviderError',
      scenario: 'decline',
    })
  })

  it('a per-call scenario wins over the env default', async () => {
    vi.stubEnv('E2E_MODE', 'true')
    vi.stubEnv('E2E_BILLING_SCENARIO', 'decline')
    resetBillingProviderForTests()

    const provider = getBillingProvider()
    const session = await provider.createCheckoutSession(checkoutInput({ scenario: 'success' }))
    expect(session.status).toBe('complete')
  })

  it('E2E_BILLING_SCENARIO=delayed creates a non-terminal (open) checkout session', async () => {
    vi.stubEnv('E2E_MODE', 'true')
    vi.stubEnv('E2E_BILLING_SCENARIO', 'delayed')
    resetBillingProviderForTests()

    const provider = getBillingProvider()
    const session = await provider.createCheckoutSession(checkoutInput())
    expect(session.status).toBe('open')
  })

  it('E2E_BILLING_SCENARIO=sca_required lands changeSubscription in incomplete', async () => {
    vi.stubEnv('E2E_MODE', 'true')
    vi.stubEnv('E2E_BILLING_SCENARIO', 'sca_required')
    resetBillingProviderForTests()

    const provider = getBillingProvider()
    const subscription = await provider.changeSubscription({
      subscriptionId: 'sub_e2e_test',
      newPriceId: 'price_e2e_new',
      idempotencyKey: 'idem-sub-e2e-1',
    })
    expect(subscription.status).toBe('incomplete')
  })

  it('defaults to success when E2E_BILLING_SCENARIO is unset', async () => {
    vi.stubEnv('E2E_MODE', 'true')
    resetBillingProviderForTests()

    const provider = getBillingProvider()
    const session = await provider.createCheckoutSession(checkoutInput())
    expect(session.status).toBe('complete')
  })

  it('reuses the same idempotency key result even under a scenario default', async () => {
    vi.stubEnv('E2E_MODE', 'true')
    vi.stubEnv('E2E_BILLING_SCENARIO', 'delayed')
    resetBillingProviderForTests()

    const provider = getBillingProvider()
    const input = checkoutInput({ idempotencyKey: 'idem-dup-e2e' })
    const first = await provider.createCheckoutSession(input)
    const second = await provider.createCheckoutSession(input)
    expect(second).toEqual(first)
  })

  it('throws loudly on an unknown E2E_BILLING_SCENARIO value', async () => {
    vi.stubEnv('E2E_MODE', 'true')
    vi.stubEnv('E2E_BILLING_SCENARIO', 'not_a_scenario')
    resetBillingProviderForTests()

    const provider = getBillingProvider()
    await expect(provider.createCheckoutSession(checkoutInput())).rejects.toThrow(/E2E_BILLING_SCENARIO/)
  })

  it('ignores E2E_BILLING_SCENARIO entirely outside E2E mode', async () => {
    vi.stubEnv('E2E_MODE', 'false')
    vi.stubEnv('E2E_BILLING_SCENARIO', 'decline')
    resetBillingProviderForTests()

    const provider = getBillingProvider()
    // Dev/test config keeps the fake provider; the env scenario must not leak in.
    expect(provider).toBeInstanceOf(FakeBillingProvider)
    const session = await provider.createCheckoutSession(checkoutInput())
    expect(session.status).toBe('complete')
  })

  it('keeps BillingProviderError as the thrown type for scenario failures', async () => {
    vi.stubEnv('E2E_MODE', 'true')
    vi.stubEnv('E2E_BILLING_SCENARIO', 'timeout')
    resetBillingProviderForTests()

    const provider = getBillingProvider()
    const error = await provider.createCheckoutSession(checkoutInput()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BillingProviderError)
    expect((error as BillingProviderError).scenario).toBe('timeout')
  })
})
