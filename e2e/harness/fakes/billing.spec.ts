/**
 * Wave 1 Task 4 — billing scenario fake unit tests (Playwright-run,
 * node-only). The deep scenario matrix lives in
 * `src/shared/lib/billing/stripe-provider.test.ts` (Vitest); this spec
 * proves the harness-side control surface drives the same seam from the
 * E2E runner process.
 */
import { test, expect } from 'playwright/test'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env' })

import {
  currentBillingScenario,
  resetBillingScenario,
  setBillingScenario,
} from './billing'

function checkoutInput(idempotencyKey: string) {
  return {
    customerId: 'cus_harness',
    mode: 'subscription' as const,
    priceId: 'price_harness',
    successUrl: 'http://localhost:3000/billing/success',
    cancelUrl: 'http://localhost:3000/billing/cancel',
    idempotencyKey,
  }
}

test.afterEach(async () => {
  resetBillingScenario()
  const { resetBillingProviderForTests } = await import('../../../src/shared/lib/billing/stripe-provider')
  resetBillingProviderForTests()
})

test('scenario propagation: the env default reaches provider create calls', async () => {
  const { getBillingProvider, resetBillingProviderForTests } = await import('../../../src/shared/lib/billing/stripe-provider')
  resetBillingProviderForTests()

  setBillingScenario('decline')
  expect(currentBillingScenario()).toBe('decline')

  const provider = getBillingProvider()
  await expect(provider.createCheckoutSession(checkoutInput('harness-decline-1'))).rejects.toMatchObject({
    name: 'BillingProviderError',
    scenario: 'decline',
  })
})

test('a per-call scenario wins over the env default', async () => {
  const { getBillingProvider, resetBillingProviderForTests } = await import('../../../src/shared/lib/billing/stripe-provider')
  resetBillingProviderForTests()

  setBillingScenario('decline')
  const provider = getBillingProvider()
  const session = await provider.createCheckoutSession({ ...checkoutInput('harness-percall-1'), scenario: 'success' })
  expect(session.status).toBe('complete')
})

test('idempotency-key reuse returns the original object under E2E scenarios', async () => {
  const { getBillingProvider, resetBillingProviderForTests } = await import('../../../src/shared/lib/billing/stripe-provider')
  resetBillingProviderForTests()

  setBillingScenario('delayed')
  const provider = getBillingProvider()
  const input = checkoutInput('harness-idem-1')
  const first = await provider.createCheckoutSession(input)
  const second = await provider.createCheckoutSession(input)
  expect(second).toEqual(first)
  expect(first.status).toBe('open')
})

test('reset restores the success default', async () => {
  const { getBillingProvider, resetBillingProviderForTests } = await import('../../../src/shared/lib/billing/stripe-provider')
  resetBillingProviderForTests()

  setBillingScenario('decline')
  resetBillingScenario()
  expect(currentBillingScenario()).toBe('success')

  const provider = getBillingProvider()
  const session = await provider.createCheckoutSession(checkoutInput('harness-reset-1'))
  expect(session.status).toBe('complete')
})

test('setBillingScenario rejects values outside the existing vocabulary', () => {
  expect(() => setBillingScenario('chargeback' as never)).toThrow(/E2E_BILLING_SCENARIO/)
})

test('outside E2E mode the selector refuses and the singleton is the unmodified one', async () => {
  const { getBillingProvider, resetBillingProviderForTests } = await import('../../../src/shared/lib/billing/stripe-provider')
  const previous = process.env.E2E_MODE
  process.env.E2E_MODE = 'false'
  process.env.E2E_BILLING_SCENARIO = 'decline'
  try {
    expect(() => setBillingScenario('decline')).toThrow(/E2E-only/)

    // No provider METHOD is called here on purpose: outside E2E mode this
    // process resolves whatever the real configuration dictates (which may
    // be the RealBillingProvider when `.env.local` enables Stripe test
    // mode), and a harness spec must never place a live provider call.
    // What we prove instead: the E2E scenario-defaulting subclass is not
    // reachable, and singleton semantics are unchanged.
    resetBillingProviderForTests()
    const provider = getBillingProvider()
    expect(provider.constructor.name).not.toBe('E2EScenarioDefaultingFakeBillingProvider')
    expect(getBillingProvider()).toBe(provider)
    resetBillingProviderForTests()
    expect(getBillingProvider()).not.toBe(provider)
  } finally {
    process.env.E2E_MODE = previous
    delete process.env.E2E_BILLING_SCENARIO
  }
})
