/**
 * The one call site that decides which `BillingProvider` implementation backs the whole billing
 * platform (plans/phase-1/29-stripe-billing-platform/tasks.md §5 "Create organization Stripe Customers
 * idempotently"). `.env.example` is explicit: "keep STRIPE_BILLING_ENABLED=false ... until §7
 * gates pass" — every other billing module already calls through this seam (or accepts an
 * injected `BillingProvider` directly in tests), so swapping fake for real here needed no
 * call-site changes elsewhere. `resolveStripeClientConfig` still fails closed on any
 * misconfiguration (missing/malformed key, missing API version) rather than silently falling back.
 */
import { FakeBillingProvider } from './fake-provider'
import { RealBillingProvider } from './real-provider'
import type {
  BillingCheckoutSession,
  BillingPaymentIntent,
  BillingProvider,
  BillingScenario,
  BillingSubscription,
  ChangeSubscriptionInput,
  CreateCheckoutSessionInput,
  CreatePaymentIntentInput,
} from './provider'
import { getStripeClient, resolveStripeClientConfig, StripeBillingDisabledError } from './stripe-client'
import { env } from '../env'

let fakeProviderSingleton: FakeBillingProvider | null = null
let realProviderSingleton: RealBillingProvider | null = null
let e2eFakeProviderSingleton: FakeBillingProvider | null = null

/**
 * Wave 1 Task 4 — E2E billing scenario seam
 * (docs/superpowers/plans/2026-07-23-wave1-task4-external-fakes.md).
 *
 * `E2E_BILLING_SCENARIO` honors the existing scenario vocabulary and acts as
 * the DEFAULT `scenario` for every create call; a per-call `scenario` always
 * wins. Read at call time (not memoized) so E2E tests can flip scenarios
 * between requests without resetting the provider singleton.
 */
const E2E_BILLING_SCENARIOS: ReadonlySet<string> = new Set([
  'success',
  'sca_required',
  'decline',
  'timeout',
  'delayed',
  'out_of_order',
])

function currentE2EDefaultScenario(): BillingScenario | undefined {
  const raw = process.env.E2E_BILLING_SCENARIO
  if (raw === undefined || raw === '' || raw === 'success') return undefined
  if (!E2E_BILLING_SCENARIOS.has(raw)) {
    throw new Error(
      `Unknown E2E_BILLING_SCENARIO "${raw}" — expected one of: ${Array.from(E2E_BILLING_SCENARIOS).join(', ')}`,
    )
  }
  return raw as BillingScenario
}

/**
 * The exact `FakeBillingProvider` (same vocabulary, same state machine) with
 * one E2E-only addition: create calls default their `scenario` from
 * `E2E_BILLING_SCENARIO`. This subclass never ships behavior to production —
 * it is only ever constructed under `E2E_MODE === 'true'`.
 */
class E2EScenarioDefaultingFakeBillingProvider extends FakeBillingProvider {
  override async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<BillingCheckoutSession> {
    return super.createCheckoutSession({ ...input, scenario: input.scenario ?? currentE2EDefaultScenario() })
  }

  override async createPaymentIntent(input: CreatePaymentIntentInput): Promise<BillingPaymentIntent> {
    return super.createPaymentIntent({ ...input, scenario: input.scenario ?? currentE2EDefaultScenario() })
  }

  override async changeSubscription(input: ChangeSubscriptionInput): Promise<BillingSubscription> {
    return super.changeSubscription({ ...input, scenario: input.scenario ?? currentE2EDefaultScenario() })
  }
}

function getE2EFakeBillingProviderSingleton(): FakeBillingProvider {
  if (!e2eFakeProviderSingleton) e2eFakeProviderSingleton = new E2EScenarioDefaultingFakeBillingProvider()
  return e2eFakeProviderSingleton
}

function getFakeBillingProviderSingleton(): FakeBillingProvider {
  if (!fakeProviderSingleton) fakeProviderSingleton = new FakeBillingProvider()
  return fakeProviderSingleton
}

function getRealBillingProviderSingleton(): RealBillingProvider {
  if (!realProviderSingleton) realProviderSingleton = new RealBillingProvider(getStripeClient())
  return realProviderSingleton
}

export function getBillingProvider(): BillingProvider {
  // E2E never talks to real Stripe: the deterministic fake is the only
  // provider reachable while E2E_MODE=true, regardless of
  // STRIPE_BILLING_ENABLED. The non-E2E path below is byte-identical to the
  // pre-seam behavior.
  if (process.env.E2E_MODE === 'true') {
    return getE2EFakeBillingProviderSingleton()
  }
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
  e2eFakeProviderSingleton = null
}
