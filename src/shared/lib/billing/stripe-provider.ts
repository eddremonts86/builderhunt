/**
 * The one call site that decides which `BillingProvider` implementation backs the whole billing
 * platform (plans/stripe-billing-platform/tasks.md §5 "Create organization Stripe Customers
 * idempotently"). `.env.example` is explicit: "keep STRIPE_BILLING_ENABLED=false ... until §7
 * gates pass" — the real Stripe-backed adapter is deliberately not built yet, so this always
 * returns the deterministic `FakeBillingProvider` today. If `STRIPE_BILLING_ENABLED` is ever
 * flipped on before that adapter exists, this throws loudly rather than silently continuing to
 * fake success against what looks like a live configuration — every other billing module already
 * calls through this seam (or accepts an injected `BillingProvider` directly in tests), so the
 * real adapter can land here later with no call-site changes.
 */
import { FakeBillingProvider } from './fake-provider'
import type { BillingProvider } from './provider'
import { resolveStripeClientConfig, StripeBillingDisabledError } from './stripe-client'
import { env } from '../env'

let fakeProviderSingleton: FakeBillingProvider | null = null

function getFakeBillingProviderSingleton(): FakeBillingProvider {
  if (!fakeProviderSingleton) fakeProviderSingleton = new FakeBillingProvider()
  return fakeProviderSingleton
}

export function getBillingProvider(): BillingProvider {
  try {
    resolveStripeClientConfig({
      billingEnabled: env.STRIPE_BILLING_ENABLED,
      secretKey: env.STRIPE_SECRET_KEY,
      apiVersion: env.STRIPE_API_VERSION,
    })
  } catch (error) {
    if (error instanceof StripeBillingDisabledError) return getFakeBillingProviderSingleton()
    throw error
  }
  throw new Error(
    'STRIPE_BILLING_ENABLED is true, but the real Stripe-backed BillingProvider is not implemented yet ' +
      '(plans/stripe-billing-platform/tasks.md §10 must certify Stripe sandbox/Test Clock parity first). ' +
      'Keep STRIPE_BILLING_ENABLED=false until that task lands a real adapter behind this seam.',
  )
}

/** Test-only: forces the next `getBillingProvider()` call to construct a fresh fake instance. */
export function resetBillingProviderForTests(): void {
  fakeProviderSingleton = null
}
