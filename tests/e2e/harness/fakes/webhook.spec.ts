/**
 * Wave 1 Task 4 — webhook signer unit tests
 * (docs/superpowers/plans/2026-07-23-wave1-task4-external-fakes.md §Step 3).
 *
 * Playwright-run, node-only spec (no browser): the Vitest include globs
 * cover `src/**` and `test/**` only, so unit-style specs under `e2e/` run
 * under the Playwright runner — the same convention as
 * `e2e/harness/isolation.spec.ts`.
 *
 * The signer must produce headers the PRODUCTION verifier accepts — so
 * every assertion here round-trips through `Stripe.webhooks.constructEvent`
 * with the exact `SIGNATURE_TOLERANCE_SECONDS` the inbox uses.
 */
import { test, expect } from 'playwright/test'
import Stripe from 'stripe'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env' })

import { signStripeWebhook, stripeEventFixture } from './webhook'

const CURRENT_SECRET = 'whsec_e2e_current_secret'
const PREVIOUS_SECRET = 'whsec_e2e_previous_secret'

/** Mirrors `verifySignature` in `src/shared/lib/billing/webhook-inbox.ts`: try every secret in order, first match wins. */
function verifyWithSecrets(payload: string, header: string, secrets: string[], tolerance: number): Stripe.Event {
  let lastError: unknown
  for (const secret of secrets) {
    try {
      return Stripe.webhooks.constructEvent(payload, header, secret, tolerance)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

test.describe('signStripeWebhook', () => {
  test('produces a header the production verifier accepts', async () => {
    const { SIGNATURE_TOLERANCE_SECONDS } = await import('../../../../src/shared/lib/billing/webhook-inbox')
    const payload = stripeEventFixture({ type: 'invoice.paid' })
    const header = signStripeWebhook(payload, CURRENT_SECRET)

    const event = Stripe.webhooks.constructEvent(payload, header, CURRENT_SECRET, SIGNATURE_TOLERANCE_SECONDS)
    expect(event.type).toBe('invoice.paid')
  })

  test('a timestamp just inside the tolerance window is accepted', async () => {
    const { SIGNATURE_TOLERANCE_SECONDS } = await import('../../../../src/shared/lib/billing/webhook-inbox')
    const payload = stripeEventFixture()
    // 30s of margin against wall-clock drift between signing and verifying.
    const header = signStripeWebhook(payload, CURRENT_SECRET, { timestampDeltaSec: -(SIGNATURE_TOLERANCE_SECONDS - 30) })

    const event = Stripe.webhooks.constructEvent(payload, header, CURRENT_SECRET, SIGNATURE_TOLERANCE_SECONDS)
    expect(event.object).toBe('event')
  })

  test('a stale timestamp (tolerance + 1s) is rejected', async () => {
    const { SIGNATURE_TOLERANCE_SECONDS } = await import('../../../../src/shared/lib/billing/webhook-inbox')
    const payload = stripeEventFixture()
    const header = signStripeWebhook(payload, CURRENT_SECRET, { timestampDeltaSec: -(SIGNATURE_TOLERANCE_SECONDS + 1) })

    expect(() => Stripe.webhooks.constructEvent(payload, header, CURRENT_SECRET, SIGNATURE_TOLERANCE_SECONDS))
      .toThrow(/timestamp/i)
  })

  test('dual-secret rotation: a header signed with the previous secret still verifies via the ordered list', async () => {
    const { SIGNATURE_TOLERANCE_SECONDS } = await import('../../../../src/shared/lib/billing/webhook-inbox')
    const payload = stripeEventFixture()
    const header = signStripeWebhook(payload, PREVIOUS_SECRET)

    // The current secret alone rejects it...
    expect(() => Stripe.webhooks.constructEvent(payload, header, CURRENT_SECRET, SIGNATURE_TOLERANCE_SECONDS)).toThrow()
    // ...but the inbox's [current, previous] loop accepts it.
    const event = verifyWithSecrets(payload, header, [CURRENT_SECRET, PREVIOUS_SECRET], SIGNATURE_TOLERANCE_SECONDS)
    expect(event.object).toBe('event')
  })

  test('a tampered payload is rejected even with a fresh signature', async () => {
    const { SIGNATURE_TOLERANCE_SECONDS } = await import('../../../../src/shared/lib/billing/webhook-inbox')
    const payload = stripeEventFixture()
    const header = signStripeWebhook(payload, CURRENT_SECRET)
    const tampered = payload.replace('checkout.session.completed', 'checkout.session.expired')

    expect(() => Stripe.webhooks.constructEvent(tampered, header, CURRENT_SECRET, SIGNATURE_TOLERANCE_SECONDS)).toThrow()
  })

  test('a malformed (non-JSON) payload never yields an event', async () => {
    const { SIGNATURE_TOLERANCE_SECONDS } = await import('../../../../src/shared/lib/billing/webhook-inbox')
    const payload = 'this is not json'
    const header = signStripeWebhook(payload, CURRENT_SECRET)

    expect(() => Stripe.webhooks.constructEvent(payload, header, CURRENT_SECRET, SIGNATURE_TOLERANCE_SECONDS)).toThrow()
  })

  test('an empty signing secret is rejected by the signer itself', () => {
    expect(() => signStripeWebhook(stripeEventFixture(), '')).toThrow(/non-empty signing secret/)
  })
})

test.describe('__e2eSigningSecrets', () => {
  test('returns [current, previous] from the E2E env vars, in rotation order', async () => {
    const { __e2eSigningSecrets } = await import('../../../../src/shared/lib/billing/webhook-inbox')
    process.env.E2E_STRIPE_WEBHOOK_SECRET = CURRENT_SECRET
    process.env.E2E_STRIPE_WEBHOOK_SECRET_PREVIOUS = PREVIOUS_SECRET
    try {
      expect(__e2eSigningSecrets()).toEqual([CURRENT_SECRET, PREVIOUS_SECRET])
    } finally {
      delete process.env.E2E_STRIPE_WEBHOOK_SECRET
      delete process.env.E2E_STRIPE_WEBHOOK_SECRET_PREVIOUS
    }
  })

  test('omits an unset previous secret', async () => {
    const { __e2eSigningSecrets } = await import('../../../../src/shared/lib/billing/webhook-inbox')
    process.env.E2E_STRIPE_WEBHOOK_SECRET = CURRENT_SECRET
    try {
      expect(__e2eSigningSecrets()).toEqual([CURRENT_SECRET])
    } finally {
      delete process.env.E2E_STRIPE_WEBHOOK_SECRET
    }
  })

  test('is unreachable outside E2E mode', async () => {
    const { __e2eSigningSecrets } = await import('../../../../src/shared/lib/billing/webhook-inbox')
    const previous = process.env.E2E_MODE
    process.env.E2E_MODE = 'false'
    try {
      expect(() => __e2eSigningSecrets()).toThrow(/E2E-only/)
    } finally {
      process.env.E2E_MODE = previous
    }
  })
})
