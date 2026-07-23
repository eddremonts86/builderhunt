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
  /** Needed structurally so an owner can target this exact grant for a refund request (`POST /api/billing/refunds`) — the route itself re-validates eligibility server-side, so no other grant field needs to leave this DTO for that purpose. */
  id: string
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

export interface BillingGraceStateDto {
  gracePeriodEndsAt: string | null
  paymentBlockedAt: string | null
}

export interface BillingScheduledChangeDto {
  catalogKey: string
  effectiveAt: string
}

export interface BillingSeatsDto {
  limit: number
  used: number
}

export interface BillingUsageDto {
  savedSearches: number
  savedBuilders: number
}

/** `null` means unlimited — the canonical, typed replacement for a JS `Infinity` value JSON can never actually carry (`JSON.stringify(Infinity) === 'null'` regardless of intent) — plans/stripe-billing-platform/tasks.md §9 task 1. */
export interface BillingUsageLimitsDto {
  savedSearches: number | null
  savedBuilders: number | null
  rssSubscriptions: number | null
}

export interface BillingCapabilitiesDto {
  paidActionsAllowed: boolean
  canOpenPortal: boolean
  canRequestRefund: boolean
  canConfigureAutoRecharge: boolean
}

/** Placeholder until plans/stripe-billing-platform/tasks.md §9 task 4 ("Add verified billing contact management") lands — always `null` today; typed now so this DTO's shape doesn't need a second breaking change later. */
export interface BillingContactSummaryDto {
  email: string
  verifiedAt: string | null
}

/**
 * The full elevated (owner/admin) view — role-minimized by the route, not this function: a member
 * never receives this shape at all (see `BillingAvailabilityDto` below), matching spec.md's "Admins
 * see read-only billing and usage data."
 */
export interface OrganizationBillingSummaryDto {
  tier: string
  status: string
  billingPeriod: string
  currentPeriodEnd: string | null
  trialEndsAt: string | null
  notes: string | null
  cancelAtPeriodEnd: boolean
  canceledAt: string | null
  scheduledChange: BillingScheduledChangeDto | null
  grace: BillingGraceStateDto
  seats: BillingSeatsDto
  customer: BillingCustomerSummaryDto | null
  activeCreditGrants: BillingCreditGrantSummaryDto[]
  recentRefunds: BillingRefundSummaryDto[]
  recentTermsAcceptances: BillingTermsAcceptanceSummaryDto[]
  usage: BillingUsageDto
  limits: BillingUsageLimitsDto
  billingContact: BillingContactSummaryDto | null
  capabilities: BillingCapabilitiesDto
}

/** What a plain member receives instead — spec.md §Permissions and UX: "Members see only feature availability and an owner-contact action." */
export interface BillingAvailabilityDto {
  capabilities: Pick<BillingCapabilitiesDto, 'paidActionsAllowed'>
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
  grant: { id: string; source: string; remainingUnits: number; expiresAt: Date },
): BillingCreditGrantSummaryDto {
  return { id: grant.id, source: grant.source, remainingUnits: grant.remainingUnits, expiresAt: grant.expiresAt.toISOString() }
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

export function toBillingGraceStateDto(
  subscription: { gracePeriodEndsAt: Date | null; paymentBlockedAt: Date | null } | null,
): BillingGraceStateDto {
  return {
    gracePeriodEndsAt: subscription?.gracePeriodEndsAt?.toISOString() ?? null,
    paymentBlockedAt: subscription?.paymentBlockedAt?.toISOString() ?? null,
  }
}

export function toBillingScheduledChangeDto(
  scheduledChange: { catalogKey: string; effectiveAt: string } | null | undefined,
): BillingScheduledChangeDto | null {
  return scheduledChange ?? null
}

/** Maps the legacy `Infinity`-for-unlimited convention (`billing-shared.ts`'s `PLAN_LIMITS`) to an explicit `null` — never changes the constant itself, since arithmetic comparisons elsewhere (`count < limit`) depend on real `Infinity` semantics. */
export function toBillingUsageLimitsDto(
  limits: { savedSearches: number; savedBuilders: number; rssSubscriptions: number },
): BillingUsageLimitsDto {
  const orNull = (value: number): number | null => (Number.isFinite(value) ? value : null)
  return {
    savedSearches: orNull(limits.savedSearches),
    savedBuilders: orNull(limits.savedBuilders),
    rssSubscriptions: orNull(limits.rssSubscriptions),
  }
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

/**
 * The canonical organization billing DTO (plans/stripe-billing-platform/tasks.md §9 task 1) — plan/
 * period, payment/grace/scheduled state, seats, credit grants, usage vs. limits, capabilities, and a
 * billing-contact placeholder. Owner/admin only — the route calls this behind `canReadBillingSummary`
 * and falls back to `getBillingAvailability` for a plain member. `/api/plans/me` (legacy) delegates to
 * this same function during migration rather than duplicating any of these reads.
 */
export async function getOrganizationBillingSummary(principal: TenantPrincipal): Promise<OrganizationBillingSummaryDto> {
  const [{ withTenantContext }, repo, entitlementsRepo, savedQueriesRepo, organizationBuildersRepo, permissions, { getSeatUsage }, { PLAN_LIMITS }] = await Promise.all([
    import('../db/tenant-context'),
    import('../repositories/billing'),
    import('../repositories/entitlements'),
    import('../repositories/saved-queries'),
    import('../repositories/organization-builders'),
    import('./permissions'),
    import('../auth/organization-lifecycle'),
    import('../billing-shared'),
  ])

  const livemode = isLiveMode()

  const [summary, seats] = await Promise.all([
    withTenantContext(principal, async (tx) => {
      const [policy, period, subscription, customer, activeCreditGrants, recentRefunds, recentTermsAcceptances, savedSearches, savedBuilders] = await Promise.all([
        entitlementsRepo.getOrganizationEntitlement(tx, principal.organizationId),
        entitlementsRepo.getOrganizationEntitlementPeriod(tx, principal.organizationId),
        repo.findFullActiveBillingSubscription(tx, principal.organizationId, livemode),
        repo.findBillingCustomer(tx, principal.organizationId, livemode),
        repo.listActiveBillingCreditGrants(tx, principal.organizationId),
        repo.listBillingRefunds(tx, principal.organizationId),
        repo.listBillingTermsAcceptances(tx, principal.organizationId),
        savedQueriesRepo.countSavedQueries(tx, principal.organizationId),
        organizationBuildersRepo.countOrganizationBuilders(tx, principal.organizationId),
      ])
      return { policy, period, subscription, customer, activeCreditGrants, recentRefunds, recentTermsAcceptances, savedSearches, savedBuilders }
    }),
    getSeatUsage(principal),
  ])

  return {
    tier: summary.policy.tier,
    status: summary.policy.status,
    billingPeriod: summary.period.billingPeriod,
    currentPeriodEnd: summary.period.currentPeriodEnd?.toISOString() ?? null,
    trialEndsAt: summary.period.trialEndsAt?.toISOString() ?? null,
    notes: summary.period.notes,
    cancelAtPeriodEnd: summary.subscription?.cancelAtPeriodEnd ?? false,
    canceledAt: summary.subscription?.canceledAt?.toISOString() ?? null,
    scheduledChange: toBillingScheduledChangeDto(summary.subscription?.scheduledChange),
    grace: toBillingGraceStateDto(summary.subscription),
    seats: { limit: seats.limit, used: seats.used },
    customer: toBillingCustomerSummaryDto(summary.customer),
    activeCreditGrants: summary.activeCreditGrants.map(toBillingCreditGrantSummaryDto),
    recentRefunds: summary.recentRefunds.map(toBillingRefundSummaryDto),
    recentTermsAcceptances: summary.recentTermsAcceptances.map(toBillingTermsAcceptanceSummaryDto),
    usage: { savedSearches: summary.savedSearches, savedBuilders: summary.savedBuilders },
    limits: toBillingUsageLimitsDto(PLAN_LIMITS[entitlementsRepo.resolveLegacyPlanTier(summary.policy.tier)]),
    // Always null until plans/stripe-billing-platform/tasks.md §9 task 4 lands — see BillingContactSummaryDto's own comment.
    billingContact: null,
    capabilities: {
      paidActionsAllowed: summary.policy.paidActionsAllowed,
      canOpenPortal: permissions.canOpenBillingPortal(principal),
      canRequestRefund: permissions.canRequestBillingRefund(principal),
      canConfigureAutoRecharge: permissions.canConfigureAutoRecharge(principal),
    },
  }
}

/** What a plain member receives instead of `getOrganizationBillingSummary` — cheap on purpose: no credit/refund/usage reads a member is never shown. */
export async function getBillingAvailability(principal: TenantPrincipal): Promise<BillingAvailabilityDto> {
  const [{ withTenantContext }, entitlementsRepo] = await Promise.all([
    import('../db/tenant-context'),
    import('../repositories/entitlements'),
  ])

  const paidActionsAllowed = await withTenantContext(principal, async (tx) => {
    const policy = await entitlementsRepo.getOrganizationEntitlement(tx, principal.organizationId)
    return policy.paidActionsAllowed
  })

  return { capabilities: { paidActionsAllowed } }
}

/** Masked-only — see `PaymentMethodSummary`'s own doc comment in `provider.ts`: no PAN, no expiry, no billing address. */
export interface OwnershipTransferPaymentMethodDto {
  brand: string
  last4: string
}

/**
 * Read-only preview shown before confirming an ownership transfer (plans/stripe-billing-platform/
 * tasks.md §9 task 5). Deliberately makes ZERO calls to any provider method that could create a
 * charge, a Checkout Session, or a PaymentIntent — only `getCustomer`/`getDefaultPaymentMethodSummary`
 * (both pure reads). "Atomically move billing authority with ownership" needs no write of its own
 * here: `billing_customers`/`billing_subscriptions` are keyed by `organizationId`, never by a user id
 * (confirmed by reading `schema.ts` in full) — the Customer/subscription/payment method already
 * belong to the organization regardless of who its owner is, and every billing permission check
 * (`billing/permissions.ts`) already derives authority purely from `organization_members.role`, the
 * exact column `transferOwnership` (`auth/organization-lifecycle.ts`) flips. There is no separate
 * "billing owner" row to migrate.
 */
export interface OwnershipTransferBillingPreviewDto {
  hasBillingCustomer: boolean
  paymentMethod: OwnershipTransferPaymentMethodDto | null
  tier: string
  billingPeriod: string
  currentPeriodEnd: string | null
  nextChargeAmountCents: number | null
  cancelAtPeriodEnd: boolean
}

export async function getOwnershipTransferBillingPreview(principal: TenantPrincipal): Promise<OwnershipTransferBillingPreviewDto> {
  const [{ withTenantContext }, repo, entitlementsRepo, { getBillingProvider }, { resolveSubscriptionCatalogEntryByKey }] = await Promise.all([
    import('../db/tenant-context'),
    import('../repositories/billing'),
    import('../repositories/entitlements'),
    import('./stripe-provider'),
    import('./catalog'),
  ])

  const livemode = isLiveMode()
  const provider = getBillingProvider()

  const { policy, period, subscription, customer } = await withTenantContext(principal, async (tx) => {
    const [policy, period, subscription, customer] = await Promise.all([
      entitlementsRepo.getOrganizationEntitlement(tx, principal.organizationId),
      entitlementsRepo.getOrganizationEntitlementPeriod(tx, principal.organizationId),
      repo.findActiveBillingSubscription(tx, principal.organizationId, livemode),
      repo.findBillingCustomer(tx, principal.organizationId, livemode),
    ])
    return { policy, period, subscription, customer }
  })

  const paymentMethod = customer ? await provider.getDefaultPaymentMethodSummary(customer.stripeCustomerId) : null
  const catalogEntry = subscription ? resolveSubscriptionCatalogEntryByKey(subscription.catalogKey) : null

  return {
    hasBillingCustomer: Boolean(customer),
    paymentMethod,
    tier: policy.tier,
    billingPeriod: period.billingPeriod,
    currentPeriodEnd: (subscription?.currentPeriodEnd ?? period.currentPeriodEnd)?.toISOString() ?? null,
    nextChargeAmountCents: catalogEntry?.amountCents ?? null,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
  }
}
