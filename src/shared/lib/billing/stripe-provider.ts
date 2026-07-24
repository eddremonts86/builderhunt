/**
 * The one call site that decides which `BillingProvider` implementation backs the whole billing
 * platform (plans/stripe-billing-platform/tasks.md §5 "Create organization Stripe Customers
 * idempotently"). `.env.example` is explicit: "keep STRIPE_BILLING_ENABLED=false ... until §7
 * gates pass" — every other billing module already calls through this seam (or accepts an
 * injected `BillingProvider` directly in tests), so swapping fake for real here needed no
 * call-site changes elsewhere. `resolveStripeClientConfig` still fails closed on any
 * misconfiguration (missing/malformed key, missing API version) rather than silently falling back.
 */
import { FakeBillingProvider } from './fake-provider'
import { RealBillingProvider } from './real-provider'
import type { BillingProvider } from './provider'
import { getStripeClient, resolveStripeClientConfig, StripeBillingDisabledError } from './stripe-client'
import { env } from '../env'

let fakeProviderSingleton: FakeBillingProvider | null = null
let realProviderSingleton: RealBillingProvider | null = null

function getFakeBillingProviderSingleton(): FakeBillingProvider {
  if (!fakeProviderSingleton) fakeProviderSingleton = new FakeBillingProvider()
  return fakeProviderSingleton
}

function getRealBillingProviderSingleton(): RealBillingProvider {
  if (!realProviderSingleton) realProviderSingleton = new RealBillingProvider(getStripeClient())
  return realProviderSingleton
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
  return getRealBillingProviderSingleton()
}

/** Test-only: forces the next `getBillingProvider()` call to construct fresh fake/real instances. */
export function resetBillingProviderForTests(): void {
  fakeProviderSingleton = null
  realProviderSingleton = null
}
