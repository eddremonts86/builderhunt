/**
 * The only surface any future billing route/UI may import for reads over
 * customer/subscription/checkout-attempt/terms-acceptance/credit-grant/
 * credit-reservation/refund state (plans/stripe-billing-platform/tasks.md §3).
 * Every export here is a `TenantPrincipal`-gated DTO or typed function — never
 * a schema table, a raw ORM row, or a Stripe payload/card/bank/PII field.
 * `src/shared/lib/billing/dependency-contracts.test.ts`'s "billing module
 * boundary" checks enforce the first two structurally: no exported function
 * here may take a bare `organizationId: string` as its first parameter
 * (every one takes a `TenantPrincipal`, resolved server-side from the
 * caller's own session — never a client-supplied organization id), and this
 * file may not import Better Auth or `~/shared/lib/db/schema`/`db/index`.
 */
import type { TenantPrincipal } from '../authorization/permissions'
import { isLiveMode } from './stripe-client'

export interface BillingCustomerSummaryDto {
  hasStripeCustomer: boolean
  livemode: boolean
}

export interface BillingSubscriptionSummaryDto {
  tier: string
  interval: string
  status: string
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
}

export interface BillingCheckoutAttemptSummaryDto {
  action: string
  catalogKey: string
  status: string
  expiresAt: string
}

export interface BillingTermsAcceptanceSummaryDto {
  termsVersion: string
  privacyVersion: string
  commercialAction: string
  acceptedAt: string
}

export interface BillingCreditGrantSummaryDto {
  source: string
  remainingUnits: number
  expiresAt: string
}

export interface BillingCreditReservationSummaryDto {
  operation: string
  maximumUnits: number
  state: string
}

export interface BillingRefundSummaryDto {
  policyDecision: string
  amountCents: number
  state: string
  createdAt: string
}

/** Everything a billing settings page needs for one render — composed of the 7 record types this plan's repository layer covers. */
export interface BillingSummaryDto {
  customer: BillingCustomerSummaryDto | null
  subscription: BillingSubscriptionSummaryDto | null
  activeCreditGrants: BillingCreditGrantSummaryDto[]
  recentRefunds: BillingRefundSummaryDto[]
  recentTermsAcceptances: BillingTermsAcceptanceSummaryDto[]
}

export function toBillingCustomerSummaryDto(customer: { livemode: boolean } | null): BillingCustomerSummaryDto | null {
  if (!customer) return null
  return { hasStripeCustomer: true, livemode: customer.livemode }
}

export function toBillingSubscriptionSummaryDto(
  subscription: { tier: string; interval: string; stripeStatus: string; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean } | null,
): BillingSubscriptionSummaryDto | null {
  if (!subscription) return null
  return {
    tier: subscription.tier,
    interval: subscription.interval,
    status: subscription.stripeStatus,
    currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
  }
}

export function toBillingCheckoutAttemptSummaryDto(
  attempt: { action: string; catalogKey: string; status: string; expiresAt: Date },
): BillingCheckoutAttemptSummaryDto {
  return { action: attempt.action, catalogKey: attempt.catalogKey, status: attempt.status, expiresAt: attempt.expiresAt.toISOString() }
}

export function toBillingTermsAcceptanceSummaryDto(
  acceptance: { termsVersion: string; privacyVersion: string; commercialAction: string; acceptedAt: Date },
): BillingTermsAcceptanceSummaryDto {
  return {
    termsVersion: acceptance.termsVersion,
    privacyVersion: acceptance.privacyVersion,
    commercialAction: acceptance.commercialAction,
    acceptedAt: acceptance.acceptedAt.toISOString(),
  }
}

export function toBillingCreditGrantSummaryDto(
  grant: { source: string; remainingUnits: number; expiresAt: Date },
): BillingCreditGrantSummaryDto {
  return { source: grant.source, remainingUnits: grant.remainingUnits, expiresAt: grant.expiresAt.toISOString() }
}

export function toBillingCreditReservationSummaryDto(
  reservation: { operation: string; maximumUnits: number; state: string },
): BillingCreditReservationSummaryDto {
  return { operation: reservation.operation, maximumUnits: reservation.maximumUnits, state: reservation.state }
}

export function toBillingRefundSummaryDto(
  refund: { policyDecision: string; amountCents: number; state: string; createdAt: Date },
): BillingRefundSummaryDto {
  return { policyDecision: refund.policyDecision, amountCents: refund.amountCents, state: refund.state, createdAt: refund.createdAt.toISOString() }
}

/** Composes the foundation reads behind a future `GET /api/billing/summary` (spec.md §API contract) so the route stays a thin auth-then-serialize wrapper with no direct DB access of its own — mirrors `getOrganizationBillingSnapshot`'s shape in `~/shared/lib/organizations/contracts.ts`. */
export async function getBillingSummary(principal: TenantPrincipal): Promise<BillingSummaryDto> {
  const [{ withTenantContext }, repo] = await Promise.all([
    import('../db/tenant-context'),
    import('../repositories/billing'),
  ])

  const livemode = isLiveMode()

  return withTenantContext(principal, async (tx) => {
    const [customer, subscription, activeCreditGrants, recentRefunds, recentTermsAcceptances] = await Promise.all([
      repo.findBillingCustomer(tx, principal.organizationId, livemode),
      repo.findActiveBillingSubscription(tx, principal.organizationId, livemode),
      repo.listActiveBillingCreditGrants(tx, principal.organizationId),
      repo.listBillingRefunds(tx, principal.organizationId),
      repo.listBillingTermsAcceptances(tx, principal.organizationId),
    ])

    return {
      customer: toBillingCustomerSummaryDto(customer),
      subscription: toBillingSubscriptionSummaryDto(subscription),
      activeCreditGrants: activeCreditGrants.map(toBillingCreditGrantSummaryDto),
      recentRefunds: recentRefunds.map(toBillingRefundSummaryDto),
      recentTermsAcceptances: recentTermsAcceptances.map(toBillingTermsAcceptanceSummaryDto),
    }
  })
}
