/**
 * Pack Checkout — one-shot credit-pack purchases (plans/implemented/30-stripe-billing-platform/tasks.md §8 task 1
 * "Build pack Checkout and successful grant"; spec.md §Packs and auto-recharge). Mirrors
 * `checkout.ts`'s subscription Checkout shape (duplicate-idempotency-key replay, return-URL
 * allowlist, seller-profile country gate) with pack-specific differences:
 *
 * - Requires an existing active-or-trialing paid subscription (`isActivePaidSubscription`) — packs
 *   cannot be bought standalone (spec.md: "Packs require an active Pro, Pro Max, or Team
 *   entitlement to buy or consume").
 * - Never allows promotion codes (spec.md: "Packs do not accept promotion codes") — there is no
 *   client input for this; the Checkout Session is always created with `allowPromotionCodes: false`.
 * - Enforces the rolling risk limit shared with auto-recharge (spec.md: "Manual and automatic pack
 *   charges share a rolling limit: at most three successful charges or $1,000 in 24 hours") BEFORE
 *   creating a new Checkout Session — a velocity pre-check on past successful purchases, not a lock
 *   on this purchase itself. `assertWithinRollingPackChargeLimit` is exported so the future
 *   auto-recharge task (§8 task 2) enforces the exact same shared window rather than a second,
 *   possibly-inconsistent counter.
 *
 * The actual credit grant happens later, on `checkout.session.completed` for this session's
 * `mode: 'payment'` (see `webhook-handlers.ts`'s `handleCheckoutSessionStatus` /
 * `handlePackCheckoutCompleted`) — never here, and never on the client-visible return redirect.
 * Every value in the Checkout Session is resolved server-side from a client-submitted `catalogKey` —
 * never a client-supplied price, amount, or Stripe Price ID, matching `checkout.ts`'s contract.
 *
 * "Preserve but disable on subscription lapse" (this task's own `Do` line) needs no code here: pack
 * grants are made unusable purely by the organization-wide `paymentBlocked` entitlement gate that
 * every consumption path already checks — see `dunning.ts`'s top-of-file comment, which documents
 * that pack-sourced grants are deliberately never frozen or mutated by the dunning worker.
 */
import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { TenantPrincipal } from '../authorization/permissions'
import type { TenantTransaction } from '../db/client'
import { resolvePackCatalogEntryByKey, resolvePackCatalogKey } from './catalog'
import { metrics } from '../metrics'
import { APPROVED_IMMEDIATE_PAYMENT_METHOD_TYPES, CHECKOUT_ATTEMPT_TTL_MS } from './checkout'
import { recordCheckoutConsent, type CheckoutDisclosures } from './consent'
import { ensureBillingCustomer } from './customers'
import { isActivePaidSubscription } from './credits'
import { BillingProviderError, type BillingProvider } from './provider'
import { assertNotRiskBlocked, recordPaymentFailure, RiskBlockedError } from './risk'
import {
  createBillingCheckoutAttemptIfAbsent,
  findActiveBillingSubscription,
  findBillingCustomer,
  findBillingCheckoutAttemptByIdempotencyKey,
} from '../repositories/billing'
import { listRecentGrantsBySource } from '../repositories/billing-ledger'
import { getCurrentSellerProfile } from './seller-profile'
import { idempotencyKeyFor, isAllowedReturnUrl, isLiveMode } from './stripe-client'

export type PackCheckoutErrorCode =
  | 'billing_disabled'
  | 'country_not_allowed'
  | 'unknown_catalog_key'
  | 'no_active_subscription'
  | 'risk_limit_exceeded'
  | 'risk_blocked'
  | 'invalid_url'
  | 'provider_error'

export class PackCheckoutError extends Error {
  constructor(message: string, readonly code: PackCheckoutErrorCode) {
    super(message)
    this.name = 'PackCheckoutError'
  }
}

/** spec.md §Packs and auto-recharge: "at most three successful charges or $1,000 in 24 hours, whichever comes first" — shared between manual pack purchases (this file) and auto-recharge (§8 task 2). */
export const ROLLING_RISK_WINDOW_MS = 24 * 60 * 60 * 1000
export const ROLLING_RISK_MAX_CHARGES = 3
export const ROLLING_RISK_MAX_AMOUNT_CENTS = 100_000

/**
 * Throws `PackCheckoutError('risk_limit_exceeded')` if `organizationId` has already hit the shared
 * charge-count or dollar-amount ceiling for the trailing 24-hour window, counting `incomingAmountCents`
 * as if it would also succeed. A pre-check only — see this module's top comment for why a race
 * between two concurrent requests is still bounded elsewhere (checkout-attempt + grant idempotency).
 */
export async function assertWithinRollingPackChargeLimit(
  transaction: TenantTransaction,
  organizationId: string,
  incomingAmountCents: number,
  now: Date = new Date(),
): Promise<void> {
  const since = new Date(now.getTime() - ROLLING_RISK_WINDOW_MS)
  const recentGrants = await listRecentGrantsBySource(transaction, organizationId, 'pack', since)

  if (recentGrants.length >= ROLLING_RISK_MAX_CHARGES) {
    throw new PackCheckoutError('Too many pack purchases in the last 24 hours', 'risk_limit_exceeded')
  }

  const recentAmountCents = recentGrants.reduce((total, grant) => {
    const entry = grant.sourceReference ? resolvePackCatalogEntryByKey(grant.sourceReference) : null
    return total + (entry?.amountCents ?? 0)
  }, 0)
  if (recentAmountCents + incomingAmountCents > ROLLING_RISK_MAX_AMOUNT_CENTS) {
    throw new PackCheckoutError('This purchase would exceed the $1,000/24h pack purchase limit', 'risk_limit_exceeded')
  }
}

export interface CreatePackCheckoutInput {
  catalogKey: string
  /** ISO 3166-1 alpha-2, client-declared — same pre-Checkout business gate as `checkout.ts`'s `country` field, checked against the current seller profile's country allowlist. */
  country: string
  disclosures: CheckoutDisclosures
  idempotencyKey: string
  successUrl: string
  cancelUrl: string
}

export interface PackCheckoutResult {
  checkoutUrl: string
  status: 'open' | 'complete' | 'expired'
}

export interface CreatePackCheckoutOptions {
  provider: BillingProvider
  /** Overrides where `getCurrentSellerProfile` reads from — same DI pattern `checkout.ts` uses. */
  sellerProfileDb?: PostgresJsDatabase
  /** Overrides where `risk.ts`'s `recordPaymentFailure` writes its independent, always-committed risk event — defaults to the real `runtimeDb`; tests inject a disposable database. */
  riskDb?: PostgresJsDatabase
  /** Test-only override for `findOrganizationOwnerEmail`'s auth-broker read — defaults to the real `authDb`. */
  authDb?: PostgresJsDatabase
}

function assertAllowedReturnUrl(url: string, field: 'successUrl' | 'cancelUrl'): void {
  if (!isAllowedReturnUrl(url)) {
    throw new PackCheckoutError(`${field} must be within this app's own origin`, 'invalid_url')
  }
}

export async function createPackCheckout(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: CreatePackCheckoutInput,
  options: CreatePackCheckoutOptions,
): Promise<PackCheckoutResult> {
  const { provider, sellerProfileDb, riskDb } = options
  const livemode = isLiveMode()

  // Duplicate-request replay first — same reasoning as `createSubscriptionCheckout`: a retried call
  // with the same idempotency key returns the original attempt's session, doing nothing else.
  const existingAttempt = await findBillingCheckoutAttemptByIdempotencyKey(transaction, principal.organizationId, input.idempotencyKey)
  if (existingAttempt) {
    if (!existingAttempt.stripeCheckoutSessionId) {
      throw new PackCheckoutError('A checkout attempt already exists for this request but has no session yet — retry shortly', 'provider_error')
    }
    const session = await provider.getCheckoutSession(existingAttempt.stripeCheckoutSessionId)
    if (!session) throw new PackCheckoutError('The checkout session for an existing attempt could not be found', 'provider_error')
    return { checkoutUrl: session.url, status: session.status }
  }

  assertAllowedReturnUrl(input.successUrl, 'successUrl')
  assertAllowedReturnUrl(input.cancelUrl, 'cancelUrl')

  const catalogEntry = resolvePackCatalogKey(input.catalogKey)
  if (!catalogEntry) {
    throw new PackCheckoutError(`Unknown or retired pack catalog key: ${input.catalogKey}`, 'unknown_catalog_key')
  }
  const priceId = livemode ? catalogEntry.stripePriceId.live : catalogEntry.stripePriceId.test
  if (!priceId) {
    throw new PackCheckoutError(`No ${livemode ? 'live' : 'test'} Stripe Price ID configured for ${input.catalogKey}`, 'unknown_catalog_key')
  }

  const sellerProfile = await getCurrentSellerProfile(sellerProfileDb)
  if (!sellerProfile) {
    throw new PackCheckoutError('Billing is not configured yet', 'billing_disabled')
  }
  if (!sellerProfile.countryAllowlist.includes(input.country)) {
    metrics.increment('checkoutCountryGateRejections')
    throw new PackCheckoutError(`Checkout is not available for country: ${input.country}`, 'country_not_allowed')
  }

  const activeSubscription = await findActiveBillingSubscription(transaction, principal.organizationId, livemode)
  if (!isActivePaidSubscription(activeSubscription)) {
    throw new PackCheckoutError('Packs require an active paid subscription', 'no_active_subscription')
  }

  await assertWithinRollingPackChargeLimit(transaction, principal.organizationId, catalogEntry.amountCents)

  try {
    await assertNotRiskBlocked(transaction, principal.organizationId)
  } catch (error) {
    if (error instanceof RiskBlockedError) throw new PackCheckoutError(error.message, 'risk_blocked')
    throw error
  }

  await ensureBillingCustomer(transaction, principal, { provider, authDb: options.authDb })
  const customer = await findBillingCustomer(transaction, principal.organizationId, livemode)
  if (!customer) {
    throw new PackCheckoutError('Billing customer is unexpectedly missing after provisioning', 'provider_error')
  }

  const consentAcceptance = await recordCheckoutConsent(transaction, principal, {
    action: 'checkout_credits',
    disclosures: input.disclosures,
  })

  let session
  try {
    session = await provider.createCheckoutSession({
      customerId: customer.stripeCustomerId,
      mode: 'payment',
      priceId,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      idempotencyKey: idempotencyKeyFor('checkout-credits', principal.organizationId, input.idempotencyKey),
      automaticTax: true,
      billingAddressCollection: 'required',
      taxIdCollection: true,
      allowPromotionCodes: false,
      customerUpdate: { address: 'auto', name: 'auto' },
      paymentMethodTypes: [...APPROVED_IMMEDIATE_PAYMENT_METHOD_TYPES],
    })
  } catch (error) {
    if (error instanceof BillingProviderError) {
      await recordPaymentFailure(principal.organizationId, error.message, riskDb)
      throw new PackCheckoutError(`Checkout provider error: ${error.message}`, 'provider_error')
    }
    throw error
  }

  // Same best-effort-audit-row reasoning as `createSubscriptionCheckout`: the idempotency key above
  // depends only on organizationId + input.idempotencyKey, so a concurrent-insert race's winner and
  // loser both hold the same provider session.
  await createBillingCheckoutAttemptIfAbsent(transaction, {
    id: randomUUID(),
    organizationId: principal.organizationId,
    actorUserId: principal.userId,
    livemode,
    action: 'credits',
    catalogKey: input.catalogKey,
    idempotencyKey: input.idempotencyKey,
    consentVersions: { terms: consentAcceptance.termsVersion, privacy: consentAcceptance.privacyVersion },
    stripeCheckoutSessionId: session.id,
    expiresAt: new Date(Date.now() + CHECKOUT_ATTEMPT_TTL_MS),
  })

  return { checkoutUrl: session.url, status: session.status }
}
