import { and, desc, eq, isNull } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import {
  authUsers,
  billingCheckoutAttempts,
  billingCreditGrants,
  billingCreditReservations,
  billingCustomers,
  billingRefunds,
  billingSubscriptions,
  billingTermsAcceptances,
  organizationMembers,
} from '../db/schema'

/**
 * Tenant-scoped data access for the 7 billing record types a checkout/summary
 * surface needs (plans/stripe-billing-platform/tasks.md §3). Every function
 * takes an already-tenant-scoped `TenantTransaction` (see
 * `~/shared/lib/db/tenant-context.ts`'s `withTenantContext`) and re-filters by
 * `organizationId` explicitly in the query even though RLS already forces it —
 * the same defense-in-depth pattern as `entitlements.ts`/`organization-alerts.ts`.
 * Mutating financial state through this repository still only works because
 * the underlying connection is `builderhunt_worker`, never `builderhunt_app`
 * (see drizzle/0028_billing_rls_grants.sql) — this file does not change that,
 * it is a data-access layer, not an authorization layer.
 */

export interface BillingCustomerRecord {
  id: string
  organizationId: string
  livemode: boolean
  stripeCustomerId: string
  createdAt: Date
  updatedAt: Date
}

export async function findBillingCustomer(
  transaction: TenantTransaction,
  organizationId: string,
  livemode: boolean,
): Promise<BillingCustomerRecord | null> {
  const [row] = await transaction
    .select()
    .from(billingCustomers)
    .where(and(eq(billingCustomers.organizationId, organizationId), eq(billingCustomers.livemode, livemode)))
    .limit(1)
  return row ?? null
}

export interface CreateBillingCustomerInput {
  id: string
  organizationId: string
  livemode: boolean
  stripeCustomerId: string
}

export async function createBillingCustomer(
  transaction: TenantTransaction,
  input: CreateBillingCustomerInput,
): Promise<BillingCustomerRecord> {
  const [row] = await transaction.insert(billingCustomers).values(input).returning()
  return row
}

/**
 * Same insert, but tolerates losing a race to a concurrent caller inserting the same
 * `(organizationId, livemode)` pair (drizzle/0027's `billing_customers_org_livemode_unique`) —
 * returns `null` instead of throwing so the caller can re-`findBillingCustomer` and return the
 * row the winner created (`billing/customers.ts`'s `ensureBillingCustomer`).
 */
export async function createBillingCustomerIfAbsent(
  transaction: TenantTransaction,
  input: CreateBillingCustomerInput,
): Promise<BillingCustomerRecord | null> {
  const [row] = await transaction
    .insert(billingCustomers)
    .values(input)
    .onConflictDoNothing({ target: [billingCustomers.organizationId, billingCustomers.livemode] })
    .returning()
  return row ?? null
}

/** The org's current owner's account email — the only email `billing/customers.ts` ever sends to Stripe (never candidate/product data). Returns null if the organization somehow has no owner row (should not happen given `organization_members_one_owner_unique`, but this is a read, not an invariant enforcement). */
export async function findOrganizationOwnerEmail(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<string | null> {
  const [row] = await transaction
    .select({ email: authUsers.email })
    .from(organizationMembers)
    .innerJoin(authUsers, eq(organizationMembers.userId, authUsers.id))
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.role, 'owner')))
    .limit(1)
  return row?.email ?? null
}

export interface BillingSubscriptionRecord {
  id: string
  organizationId: string
  customerId: string
  livemode: boolean
  catalogKey: string
  tier: string
  interval: string
  stripeSubscriptionId: string
  stripeStatus: string
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  canceledAt: Date | null
}

/** The one non-canceled base subscription for this org/livemode, if any (drizzle/0027's partial unique index guarantees at most one). */
export async function findActiveBillingSubscription(
  transaction: TenantTransaction,
  organizationId: string,
  livemode: boolean,
): Promise<BillingSubscriptionRecord | null> {
  const [row] = await transaction
    .select({
      id: billingSubscriptions.id,
      organizationId: billingSubscriptions.organizationId,
      customerId: billingSubscriptions.customerId,
      livemode: billingSubscriptions.livemode,
      catalogKey: billingSubscriptions.catalogKey,
      tier: billingSubscriptions.tier,
      interval: billingSubscriptions.interval,
      stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId,
      stripeStatus: billingSubscriptions.stripeStatus,
      currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
      canceledAt: billingSubscriptions.canceledAt,
    })
    .from(billingSubscriptions)
    .where(and(
      eq(billingSubscriptions.organizationId, organizationId),
      eq(billingSubscriptions.livemode, livemode),
      isNull(billingSubscriptions.canceledAt),
    ))
    .limit(1)
  return row ?? null
}

export interface CreateBillingSubscriptionInput {
  id: string
  organizationId: string
  customerId: string
  livemode: boolean
  catalogKey: string
  tier: 'pro' | 'pro_max' | 'team'
  interval: 'monthly' | 'annual'
  catalogVersion: number
  stripeSubscriptionId: string
  stripeStatus: string
}

/** The composite `(organizationId, customerId)` foreign key to `billingCustomers` rejects a customerId belonging to a different organization — see drizzle/0027's `billing_subscriptions_organization_customer_fk`. */
export async function createBillingSubscription(
  transaction: TenantTransaction,
  input: CreateBillingSubscriptionInput,
): Promise<BillingSubscriptionRecord> {
  const [row] = await transaction.insert(billingSubscriptions).values(input).returning()
  return row
}

export interface CreateBillingCheckoutAttemptInput {
  id: string
  organizationId: string
  actorUserId: string
  livemode: boolean
  action: 'subscription' | 'credits'
  catalogKey: string
  idempotencyKey: string
  consentVersions: { terms: string; privacy: string }
  expiresAt: Date
}

export interface BillingCheckoutAttemptRecord {
  id: string
  organizationId: string
  actorUserId: string
  action: string
  catalogKey: string
  idempotencyKey: string
  status: string
  stripeCheckoutSessionId: string | null
  expiresAt: Date
}

export async function createBillingCheckoutAttempt(
  transaction: TenantTransaction,
  input: CreateBillingCheckoutAttemptInput,
): Promise<BillingCheckoutAttemptRecord> {
  const [row] = await transaction.insert(billingCheckoutAttempts).values(input).returning()
  return row
}

/** Looks up a checkout attempt by its idempotency key so a retried request returns the original attempt instead of creating a second one. */
export async function findBillingCheckoutAttemptByIdempotencyKey(
  transaction: TenantTransaction,
  organizationId: string,
  idempotencyKey: string,
): Promise<BillingCheckoutAttemptRecord | null> {
  const [row] = await transaction
    .select({
      id: billingCheckoutAttempts.id,
      organizationId: billingCheckoutAttempts.organizationId,
      actorUserId: billingCheckoutAttempts.actorUserId,
      action: billingCheckoutAttempts.action,
      catalogKey: billingCheckoutAttempts.catalogKey,
      idempotencyKey: billingCheckoutAttempts.idempotencyKey,
      status: billingCheckoutAttempts.status,
      stripeCheckoutSessionId: billingCheckoutAttempts.stripeCheckoutSessionId,
      expiresAt: billingCheckoutAttempts.expiresAt,
    })
    .from(billingCheckoutAttempts)
    .where(and(
      eq(billingCheckoutAttempts.organizationId, organizationId),
      eq(billingCheckoutAttempts.idempotencyKey, idempotencyKey),
    ))
    .limit(1)
  return row ?? null
}

export interface BillingTermsAcceptanceRecord {
  id: string
  organizationId: string
  actorUserId: string
  termsVersion: string
  privacyVersion: string
  commercialAction: string
  acceptedAt: Date
}

export interface CreateBillingTermsAcceptanceInput {
  id: string
  organizationId: string
  actorUserId: string
  termsVersion: string
  privacyVersion: string
  commercialAction: 'checkout_subscription' | 'checkout_credits' | 'auto_recharge'
  referenceId?: string
}

export async function createBillingTermsAcceptance(
  transaction: TenantTransaction,
  input: CreateBillingTermsAcceptanceInput,
): Promise<BillingTermsAcceptanceRecord> {
  const [row] = await transaction.insert(billingTermsAcceptances).values(input).returning()
  return row
}

export async function listBillingTermsAcceptances(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<BillingTermsAcceptanceRecord[]> {
  return transaction
    .select({
      id: billingTermsAcceptances.id,
      organizationId: billingTermsAcceptances.organizationId,
      actorUserId: billingTermsAcceptances.actorUserId,
      termsVersion: billingTermsAcceptances.termsVersion,
      privacyVersion: billingTermsAcceptances.privacyVersion,
      commercialAction: billingTermsAcceptances.commercialAction,
      acceptedAt: billingTermsAcceptances.acceptedAt,
    })
    .from(billingTermsAcceptances)
    .where(eq(billingTermsAcceptances.organizationId, organizationId))
    .orderBy(desc(billingTermsAcceptances.acceptedAt))
}

export interface BillingCreditGrantRecord {
  id: string
  organizationId: string
  source: string
  remainingUnits: number
  originalUnits: number
  state: string
  expiresAt: Date
}

export async function listActiveBillingCreditGrants(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<BillingCreditGrantRecord[]> {
  return transaction
    .select({
      id: billingCreditGrants.id,
      organizationId: billingCreditGrants.organizationId,
      source: billingCreditGrants.source,
      remainingUnits: billingCreditGrants.remainingUnits,
      originalUnits: billingCreditGrants.originalUnits,
      state: billingCreditGrants.state,
      expiresAt: billingCreditGrants.expiresAt,
    })
    .from(billingCreditGrants)
    .where(and(eq(billingCreditGrants.organizationId, organizationId), eq(billingCreditGrants.state, 'active')))
    .orderBy(billingCreditGrants.expiresAt)
}

export interface CreateBillingCreditGrantInput {
  id: string
  organizationId: string
  source: string
  sourceReference?: string
  stripePaymentReference?: string
  monthlyWindowKey?: string
  originalUnits: number
  remainingUnits: number
  expiresAt: Date
}

export async function createBillingCreditGrant(
  transaction: TenantTransaction,
  input: CreateBillingCreditGrantInput,
): Promise<BillingCreditGrantRecord> {
  const [row] = await transaction.insert(billingCreditGrants).values(input).returning()
  return row
}

export interface BillingCreditReservationRecord {
  id: string
  organizationId: string
  operation: string
  maximumUnits: number
  settledUnits: number | null
  state: string
  deadlineAt: Date
}

export interface CreateBillingCreditReservationInput {
  id: string
  organizationId: string
  operation: string
  rateCardVersion: number
  idempotencyKey: string
  maximumUnits: number
  deadlineAt: Date
}

export async function createBillingCreditReservation(
  transaction: TenantTransaction,
  input: CreateBillingCreditReservationInput,
): Promise<BillingCreditReservationRecord> {
  const [row] = await transaction.insert(billingCreditReservations).values(input).returning()
  return row
}

/** Looks up a reservation by its idempotency key so a retried reserve call returns the original reservation instead of creating a second one. */
export async function findBillingCreditReservationByIdempotencyKey(
  transaction: TenantTransaction,
  organizationId: string,
  idempotencyKey: string,
): Promise<BillingCreditReservationRecord | null> {
  const [row] = await transaction
    .select({
      id: billingCreditReservations.id,
      organizationId: billingCreditReservations.organizationId,
      operation: billingCreditReservations.operation,
      maximumUnits: billingCreditReservations.maximumUnits,
      settledUnits: billingCreditReservations.settledUnits,
      state: billingCreditReservations.state,
      deadlineAt: billingCreditReservations.deadlineAt,
    })
    .from(billingCreditReservations)
    .where(and(
      eq(billingCreditReservations.organizationId, organizationId),
      eq(billingCreditReservations.idempotencyKey, idempotencyKey),
    ))
    .limit(1)
  return row ?? null
}

export interface BillingRefundRecord {
  id: string
  organizationId: string
  policyDecision: string
  amountCents: number
  state: string
  createdAt: Date
}

export interface CreateBillingRefundRequestInput {
  id: string
  organizationId: string
  requestedByUserId: string
  idempotencyKey: string
  policyDecision: 'full_unused_pack' | 'partial_pack_operator' | 'full_subscription_invoice' | 'partial_subscription_operator'
  amountCents: number
  subscriptionId?: string
  grantId?: string
}

/** Owner-submitted refund REQUEST only — RLS's `WITH CHECK` on the app role already restricts this to `state = 'pending'`, `stripe_refund_id IS NULL`; this function never sets either. */
export async function createBillingRefundRequest(
  transaction: TenantTransaction,
  input: CreateBillingRefundRequestInput,
): Promise<BillingRefundRecord> {
  const [row] = await transaction.insert(billingRefunds).values(input).returning()
  return row
}

export async function listBillingRefunds(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<BillingRefundRecord[]> {
  return transaction
    .select({
      id: billingRefunds.id,
      organizationId: billingRefunds.organizationId,
      policyDecision: billingRefunds.policyDecision,
      amountCents: billingRefunds.amountCents,
      state: billingRefunds.state,
      createdAt: billingRefunds.createdAt,
    })
    .from(billingRefunds)
    .where(eq(billingRefunds.organizationId, organizationId))
    .orderBy(desc(billingRefunds.createdAt))
}
