/**
 * Idempotent subscription Checkout Session creation (plans/stripe-billing-platform/tasks.md §5
 * "Build subscription Checkout endpoint"; spec.md §Subscription state machine, step 1-3). The
 * caller (route handler) is responsible for owner-only permission enforcement — this module never
 * checks `principal.role` itself, matching every other billing service file's separation of
 * concerns. Every value that ends up in the Stripe Checkout Session is resolved server-side from a
 * client-submitted `catalogKey`/`country`/idempotency key — never a client-supplied price, amount,
 * Stripe Price ID, or organization id.
 */
import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { TenantPrincipal } from '../authorization/permissions'
import type { TenantTransaction } from '../db/client'
import { env } from '../env'
import { resolveSubscriptionCatalogKey } from './catalog'
import { recordCheckoutConsent, type CheckoutDisclosures } from './consent'
import { ensureBillingCustomer } from './customers'
import { BillingProviderError, type BillingProvider } from './provider'
import {
  createBillingCheckoutAttemptIfAbsent,
  findActiveBillingSubscription,
  findBillingCustomer,
  findBillingCheckoutAttemptByIdempotencyKey,
  findLatestBillingCheckoutAttempt,
} from '../repositories/billing'
import { getCurrentSellerProfile } from './seller-profile'
import { idempotencyKeyFor, isLiveMode } from './stripe-client'

export type CheckoutErrorCode =
  | 'billing_disabled'
  | 'country_not_allowed'
  | 'unknown_catalog_key'
  | 'subscription_exists'
  | 'invalid_url'
  | 'provider_error'

export class CheckoutError extends Error {
  constructor(message: string, readonly code: CheckoutErrorCode) {
    super(message)
    this.name = 'CheckoutError'
  }
}

/** Methods that settle immediately — never ACH/SEPA debit/vouchers, which would leave Checkout in a pending state Stripe itself can take days to resolve. */
export const APPROVED_IMMEDIATE_PAYMENT_METHOD_TYPES = ['card', 'link'] as const

/** How long an unfinished Checkout attempt stays claimable before a new one may be started for the same idempotency key's org. */
export const CHECKOUT_ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000

export interface CreateSubscriptionCheckoutInput {
  catalogKey: string
  /** ISO 3166-1 alpha-2, client-declared — checked against the current seller profile's country allowlist (spec.md: "Initial production customer-country allowlist: Denmark only"). The customer's real billing address is still collected and enforced by Stripe Checkout itself; this is a pre-Checkout business gate, not the final authority. */
  country: string
  disclosures: CheckoutDisclosures
  idempotencyKey: string
  successUrl: string
  cancelUrl: string
}

export interface SubscriptionCheckoutResult {
  checkoutUrl: string
  status: 'open' | 'complete' | 'expired'
}

export interface CreateSubscriptionCheckoutOptions {
  provider: BillingProvider
  /** Overrides where `getCurrentSellerProfile` reads from — defaults to the real `platformDb` singleton in production; tests inject a disposable database, the same DI pattern `seller-profile.ts` itself already uses. */
  sellerProfileDb?: PostgresJsDatabase
}

function assertAllowedReturnUrl(url: string, field: 'successUrl' | 'cancelUrl'): void {
  if (!url.startsWith(env.APP_URL)) {
    throw new CheckoutError(`${field} must be within this app's own origin`, 'invalid_url')
  }
}

export async function createSubscriptionCheckout(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: CreateSubscriptionCheckoutInput,
  options: CreateSubscriptionCheckoutOptions,
): Promise<SubscriptionCheckoutResult> {
  const { provider, sellerProfileDb } = options
  const livemode = isLiveMode()

  // Duplicate-request replay first — a retried call with the same idempotency key returns the
  // original attempt's session, doing nothing else (no re-validation, no second consent record).
  const existingAttempt = await findBillingCheckoutAttemptByIdempotencyKey(transaction, principal.organizationId, input.idempotencyKey)
  if (existingAttempt) {
    if (!existingAttempt.stripeCheckoutSessionId) {
      throw new CheckoutError('A checkout attempt already exists for this request but has no session yet — retry shortly', 'provider_error')
    }
    const session = await provider.getCheckoutSession(existingAttempt.stripeCheckoutSessionId)
    if (!session) throw new CheckoutError('The checkout session for an existing attempt could not be found', 'provider_error')
    return { checkoutUrl: session.url, status: session.status }
  }

  assertAllowedReturnUrl(input.successUrl, 'successUrl')
  assertAllowedReturnUrl(input.cancelUrl, 'cancelUrl')

  const catalogEntry = resolveSubscriptionCatalogKey(input.catalogKey)
  if (!catalogEntry) {
    throw new CheckoutError(`Unknown or retired catalog key: ${input.catalogKey}`, 'unknown_catalog_key')
  }
  const priceId = livemode ? catalogEntry.stripePriceId.live : catalogEntry.stripePriceId.test
  if (!priceId) {
    throw new CheckoutError(`No ${livemode ? 'live' : 'test'} Stripe Price ID configured for ${input.catalogKey}`, 'unknown_catalog_key')
  }

  const sellerProfile = await getCurrentSellerProfile(sellerProfileDb)
  if (!sellerProfile) {
    throw new CheckoutError('Billing is not configured yet', 'billing_disabled')
  }
  if (!sellerProfile.countryAllowlist.includes(input.country)) {
    throw new CheckoutError(`Checkout is not available for country: ${input.country}`, 'country_not_allowed')
  }

  const existingSubscription = await findActiveBillingSubscription(transaction, principal.organizationId, livemode)
  if (existingSubscription) {
    throw new CheckoutError('An active subscription already exists for this organization', 'subscription_exists')
  }

  await ensureBillingCustomer(transaction, principal, { provider })
  const customer = await findBillingCustomer(transaction, principal.organizationId, livemode)
  if (!customer) {
    throw new CheckoutError('Billing customer is unexpectedly missing after provisioning', 'provider_error')
  }

  const consentAcceptance = await recordCheckoutConsent(transaction, principal, {
    action: 'checkout_subscription',
    disclosures: input.disclosures,
  })

  let session
  try {
    session = await provider.createCheckoutSession({
      customerId: customer.stripeCustomerId,
      mode: 'subscription',
      priceId,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      idempotencyKey: idempotencyKeyFor('checkout-subscription', principal.organizationId, input.idempotencyKey),
      automaticTax: true,
      billingAddressCollection: 'required',
      taxIdCollection: true,
      allowPromotionCodes: true,
      customerUpdate: { address: 'auto', name: 'auto' },
      paymentMethodTypes: [...APPROVED_IMMEDIATE_PAYMENT_METHOD_TYPES],
    })
  } catch (error) {
    if (error instanceof BillingProviderError) {
      throw new CheckoutError(`Checkout provider error: ${error.message}`, 'provider_error')
    }
    throw error
  }

  // Best-effort audit row — both the winner and the loser of a concurrent insert race already hold
  // the SAME provider session (the idempotency key above depends only on organizationId +
  // input.idempotencyKey, never on anything per-attempt-random), so the response below is correct
  // either way and never needs to re-read this row.
  await createBillingCheckoutAttemptIfAbsent(transaction, {
    id: randomUUID(),
    organizationId: principal.organizationId,
    actorUserId: principal.userId,
    livemode,
    action: 'subscription',
    catalogKey: input.catalogKey,
    idempotencyKey: input.idempotencyKey,
    consentVersions: { terms: consentAcceptance.termsVersion, privacy: consentAcceptance.privacyVersion },
    stripeCheckoutSessionId: session.id,
    expiresAt: new Date(Date.now() + CHECKOUT_ATTEMPT_TTL_MS),
  })

  return { checkoutUrl: session.url, status: session.status }
}

/**
 * What `src/modules/billing/CheckoutReturn.tsx` polls after Stripe redirects the customer back —
 * spec.md: "Redirect success remains `pending`; only verified provider state activates access."
 * The return URL itself carries no attempt identifier this reads (Stripe's own `{CHECKOUT_SESSION_ID}`
 * placeholder, or any `status`/`success` query parameter a caller might append, is never consulted
 * here or by the route that calls this) — an attacker crafting a URL with a forged success indicator
 * changes nothing, since every field below is re-derived from the authenticated principal's own
 * organization state.
 *
 * `'succeeded'` requires an actual active subscription row — the only authoritative signal, written
 * by the webhook handler (plans/stripe-billing-platform/tasks.md §6, not yet built) once Stripe
 * confirms payment. Until that handler exists, a real Checkout completed via the fake provider stays
 * `'pending'` forever, which is the correct, safe default: this function never promotes anything to
 * `'succeeded'` on its own say-so. `'failed'` is not yet reachable from here for the same reason —
 * it depends on subscription/payment-intent state §6 will also populate — but is kept in the type so
 * the UI already renders it correctly the moment that data exists.
 */
export type CheckoutReturnState = 'no_attempt' | 'pending' | 'succeeded' | 'failed' | 'expired'

export interface CheckoutReturnStatus {
  state: CheckoutReturnState
}

export interface GetCheckoutReturnStatusOptions {
  provider: BillingProvider
}

export async function getCheckoutReturnStatus(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  options: GetCheckoutReturnStatusOptions,
): Promise<CheckoutReturnStatus> {
  const livemode = isLiveMode()

  const activeSubscription = await findActiveBillingSubscription(transaction, principal.organizationId, livemode)
  if (activeSubscription) return { state: 'succeeded' }

  const attempt = await findLatestBillingCheckoutAttempt(transaction, principal.organizationId, 'subscription')
  if (!attempt) return { state: 'no_attempt' }
  if (attempt.status === 'expired' || attempt.status === 'canceled') return { state: 'expired' }
  if (!attempt.stripeCheckoutSessionId) return { state: 'pending' }

  const session = await options.provider.getCheckoutSession(attempt.stripeCheckoutSessionId)
  if (session?.status === 'expired') return { state: 'expired' }
  // `'open'` and `'complete'` both mean "still waiting for the webhook to activate the
  // subscription" — the active-subscription check above is the only path to `'succeeded'`.
  return { state: 'pending' }
}
