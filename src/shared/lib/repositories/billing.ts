import { and, desc, eq, isNull } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import {
  authUsers,
  billingAutoRechargeRules,
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

export interface FullBillingSubscriptionRecord extends BillingSubscriptionRecord {
  catalogVersion: number
  currentPeriodStart: Date | null
  scheduledChange: { catalogKey: string; effectiveAt: string } | null
  providerSyncedAt: Date
}

/** Every column `subscription-changes.ts` needs to preview/apply a plan change — `findActiveBillingSubscription`'s own select deliberately omits these for its lighter (read-summary) callers. */
export async function findFullActiveBillingSubscription(
  transaction: TenantTransaction,
  organizationId: string,
  livemode: boolean,
): Promise<FullBillingSubscriptionRecord | null> {
  const [row] = await transaction
    .select({
      id: billingSubscriptions.id,
      organizationId: billingSubscriptions.organizationId,
      customerId: billingSubscriptions.customerId,
      livemode: billingSubscriptions.livemode,
      catalogKey: billingSubscriptions.catalogKey,
      tier: billingSubscriptions.tier,
      interval: billingSubscriptions.interval,
      catalogVersion: billingSubscriptions.catalogVersion,
      stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId,
      stripeStatus: billingSubscriptions.stripeStatus,
      currentPeriodStart: billingSubscriptions.currentPeriodStart,
      currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
      scheduledChange: billingSubscriptions.scheduledChange,
      cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
      canceledAt: billingSubscriptions.canceledAt,
      providerSyncedAt: billingSubscriptions.providerSyncedAt,
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

export interface ApplyImmediateSubscriptionChangeInput {
  catalogKey: string
  tier: 'pro' | 'pro_max' | 'team'
  interval: 'monthly' | 'annual'
  catalogVersion: number
  providerSyncedAt: Date
}

/** Applies an immediate plan change (upgrade, or monthly-to-annual at the same tier) — clears any stale `scheduledChange` from an earlier, superseded request. */
export async function applyImmediateSubscriptionChange(
  transaction: TenantTransaction,
  organizationId: string,
  stripeSubscriptionId: string,
  input: ApplyImmediateSubscriptionChangeInput,
): Promise<void> {
  await transaction
    .update(billingSubscriptions)
    .set({
      catalogKey: input.catalogKey,
      tier: input.tier,
      interval: input.interval,
      catalogVersion: input.catalogVersion,
      scheduledChange: null,
      providerSyncedAt: input.providerSyncedAt,
    })
    .where(and(eq(billingSubscriptions.organizationId, organizationId), eq(billingSubscriptions.stripeSubscriptionId, stripeSubscriptionId)))
}

/** Records a pending downgrade/cadence change to apply at the current period's end — never mutates `catalogKey`/`tier`/`interval` directly; task 7.5's renewal-time migration owns enacting it. */
export async function scheduleBillingSubscriptionChange(
  transaction: TenantTransaction,
  organizationId: string,
  stripeSubscriptionId: string,
  scheduledChange: { catalogKey: string; effectiveAt: string },
): Promise<void> {
  await transaction
    .update(billingSubscriptions)
    .set({ scheduledChange })
    .where(and(eq(billingSubscriptions.organizationId, organizationId), eq(billingSubscriptions.stripeSubscriptionId, stripeSubscriptionId)))
}

/** Owner-initiated cancellation — optimistic local mirror of the provider call that just succeeded; `webhook-handlers.ts`'s `handleSubscriptionUpsert` keeps this in sync from Stripe's own `cancel_at_period_end` field on every future update regardless. Never sets `canceledAt`: that's only written once the subscription actually terminates (`handleSubscriptionDeleted`). */
export async function markBillingSubscriptionCancelAtPeriodEnd(
  transaction: TenantTransaction,
  organizationId: string,
  stripeSubscriptionId: string,
): Promise<void> {
  await transaction
    .update(billingSubscriptions)
    .set({ cancelAtPeriodEnd: true })
    .where(and(eq(billingSubscriptions.organizationId, organizationId), eq(billingSubscriptions.stripeSubscriptionId, stripeSubscriptionId)))
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
  /** Set once the provider-side Checkout Session exists — null only for the brief window (if any) before a caller knows it, per the schema's nullable column. */
  stripeCheckoutSessionId?: string
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

/**
 * Same insert, but tolerates losing a race to a concurrent caller inserting the same
 * `(organizationId, idempotencyKey)` pair (drizzle/0027's `billing_checkout_attempts_org_idempotency_unique`)
 * — returns `null` instead of throwing. Safe to call unconditionally after the provider-side
 * Checkout Session already exists: because `billing/checkout.ts` derives the provider idempotency
 * key from the same `(organizationId, idempotencyKey)` pair, the loser's own `session` value is
 * already identical to the winner's, so it never needs to re-read this row to answer the caller.
 */
export async function createBillingCheckoutAttemptIfAbsent(
  transaction: TenantTransaction,
  input: CreateBillingCheckoutAttemptInput,
): Promise<BillingCheckoutAttemptRecord | null> {
  const [row] = await transaction
    .insert(billingCheckoutAttempts)
    .values(input)
    .onConflictDoNothing({ target: [billingCheckoutAttempts.organizationId, billingCheckoutAttempts.idempotencyKey] })
    .returning()
  return row ?? null
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

/** The most recent attempt of this action for the org, regardless of idempotency key — what a pending Checkout return page polls to find "the attempt I just started," since the return URL itself carries no attempt identifier a client could forge. */
export async function findLatestBillingCheckoutAttempt(
  transaction: TenantTransaction,
  organizationId: string,
  action: 'subscription' | 'credits',
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
      eq(billingCheckoutAttempts.action, action),
    ))
    .orderBy(desc(billingCheckoutAttempts.createdAt))
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

/** Same shape as `listActiveBillingCreditGrants` but for an arbitrary state — `dunning.ts` uses this to find `'frozen'` grants on payment recovery, without a second bespoke query for every future state that needs listing. */
export async function listBillingCreditGrantsByState(
  transaction: TenantTransaction,
  organizationId: string,
  state: string,
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
    .where(and(eq(billingCreditGrants.organizationId, organizationId), eq(billingCreditGrants.state, state)))
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

/** The complete row — `BillingRefundRecord` above is deliberately narrower (the read-only billing-summary DTO's shape); processing/deciding a refund (§8 task 4) needs every column. */
export interface FullBillingRefundRecord {
  id: string
  organizationId: string
  subscriptionId: string | null
  grantId: string | null
  requestedByUserId: string
  operatorUserId: string | null
  idempotencyKey: string
  policyDecision: string
  amountCents: number
  stripeRefundId: string | null
  revisedServiceEndAt: Date | null
  creditRevocationUnits: number | null
  state: string
  createdAt: Date
  updatedAt: Date
}

/** `ON CONFLICT DO NOTHING` on the org+idempotencyKey unique index, then re-select — same idempotent-insert-or-fetch pattern as `createBillingCheckoutAttemptIfAbsent`, so a retried owner request returns the original row instead of a duplicate-key error. */
export async function createBillingRefundRequestIfAbsent(
  transaction: TenantTransaction,
  input: CreateBillingRefundRequestInput,
): Promise<FullBillingRefundRecord> {
  await transaction.insert(billingRefunds).values(input).onConflictDoNothing({
    target: [billingRefunds.organizationId, billingRefunds.idempotencyKey],
  })
  const existing = await findBillingRefundByIdempotencyKey(transaction, input.organizationId, input.idempotencyKey)
  if (!existing) throw new Error(`Refund request ${input.id} vanished immediately after insert-or-fetch`)
  return existing
}

export async function findBillingRefundByIdempotencyKey(
  transaction: TenantTransaction,
  organizationId: string,
  idempotencyKey: string,
): Promise<FullBillingRefundRecord | null> {
  const [row] = await transaction
    .select()
    .from(billingRefunds)
    .where(and(eq(billingRefunds.organizationId, organizationId), eq(billingRefunds.idempotencyKey, idempotencyKey)))
    .limit(1)
  return row ?? null
}

export async function findBillingRefundByStripeRefundId(
  transaction: TenantTransaction,
  organizationId: string,
  stripeRefundId: string,
): Promise<FullBillingRefundRecord | null> {
  const [row] = await transaction
    .select()
    .from(billingRefunds)
    .where(and(eq(billingRefunds.organizationId, organizationId), eq(billingRefunds.stripeRefundId, stripeRefundId)))
    .limit(1)
  return row ?? null
}

export async function findFullBillingRefund(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
): Promise<FullBillingRefundRecord | null> {
  const [row] = await transaction
    .select()
    .from(billingRefunds)
    .where(and(eq(billingRefunds.organizationId, organizationId), eq(billingRefunds.id, id)))
    .limit(1)
  return row ?? null
}

/** Row-locked fetch — worker processing (`refunds.ts`'s `processPendingPackRefund`) must lock this row for the ENTIRE duration of the provider call, so a second concurrent worker tick blocks instead of also sending the refund to Stripe. */
export async function lockBillingRefund(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
): Promise<FullBillingRefundRecord | null> {
  const [row] = await transaction
    .select()
    .from(billingRefunds)
    .where(and(eq(billingRefunds.organizationId, organizationId), eq(billingRefunds.id, id)))
    .for('update')
    .limit(1)
  return row ?? null
}

export async function listPendingBillingRefundsWithoutProviderRefund(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<FullBillingRefundRecord[]> {
  return transaction
    .select()
    .from(billingRefunds)
    .where(and(
      eq(billingRefunds.organizationId, organizationId),
      eq(billingRefunds.state, 'pending'),
      isNull(billingRefunds.stripeRefundId),
    ))
}

export interface OperatorRefundDecisionInput {
  operatorUserId: string
  policyDecision: 'full_unused_pack' | 'partial_pack_operator' | 'full_subscription_invoice' | 'partial_subscription_operator'
  amountCents: number
  revisedServiceEndAt?: Date
  creditRevocationUnits?: number
}

/** Platform-operator decision on an owner-submitted (or operator-initiated) request — only ever succeeds from `state = 'pending'` with no provider refund sent yet, so a decision can never silently override a request already in flight or resolved. */
export async function recordOperatorRefundDecision(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
  input: OperatorRefundDecisionInput,
): Promise<FullBillingRefundRecord | null> {
  const [row] = await transaction
    .update(billingRefunds)
    .set({
      operatorUserId: input.operatorUserId,
      policyDecision: input.policyDecision,
      amountCents: input.amountCents,
      revisedServiceEndAt: input.revisedServiceEndAt,
      creditRevocationUnits: input.creditRevocationUnits,
      updatedAt: new Date(),
    })
    .where(and(
      eq(billingRefunds.organizationId, organizationId),
      eq(billingRefunds.id, id),
      eq(billingRefunds.state, 'pending'),
      isNull(billingRefunds.stripeRefundId),
    ))
    .returning()
  return row ?? null
}

/** Records that the provider refund was sent (or already exists via idempotent replay) — set BEFORE the provider call resolves is never correct (we don't yet know the id); this is called only after `provider.createRefund` returns. */
export async function markBillingRefundProviderRefund(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
  update: { stripeRefundId: string; state: string },
): Promise<FullBillingRefundRecord | null> {
  const [row] = await transaction
    .update(billingRefunds)
    .set({ stripeRefundId: update.stripeRefundId, state: update.state, updatedAt: new Date() })
    .where(and(eq(billingRefunds.organizationId, organizationId), eq(billingRefunds.id, id)))
    .returning()
  return row ?? null
}

/** Resolves an in-flight refund's final outcome — used both by worker follow-up when the provider already returned a terminal status, and by the `refund.updated`/`charge.refunded`/`refund.failed` webhook once Stripe confirms it asynchronously. */
export async function updateBillingRefundState(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
  state: string,
): Promise<FullBillingRefundRecord | null> {
  const [row] = await transaction
    .update(billingRefunds)
    .set({ state, updatedAt: new Date() })
    .where(and(eq(billingRefunds.organizationId, organizationId), eq(billingRefunds.id, id)))
    .returning()
  return row ?? null
}

// ---------------------------------------------------------------------------
// Auto-recharge (plans/stripe-billing-platform/tasks.md §8 "Implement capped
// auto-recharge and SCA recovery") — one row per organization
// (`billing_auto_recharge_rules.organization_id` is its own primary key).
// ---------------------------------------------------------------------------

export interface BillingAutoRechargeRuleRecord {
  organizationId: string
  ownerUserId: string
  enabled: boolean
  packCatalogKey: string | null
  balanceThresholdUnits: number | null
  monthlyCapCents: number | null
  state: string
  lastFailureAt: Date | null
  lastFailureReason: string | null
  consentVersion: string | null
  pendingPaymentIntentId: string | null
  createdAt: Date
  updatedAt: Date
}

export async function findAutoRechargeRule(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<BillingAutoRechargeRuleRecord | null> {
  const [row] = await transaction
    .select()
    .from(billingAutoRechargeRules)
    .where(eq(billingAutoRechargeRules.organizationId, organizationId))
    .limit(1)
  return row ?? null
}

/** Row-locked fetch — the worker's trigger decision (`auto-recharge.ts`'s `maybeTriggerAutoRecharge`) must lock this row before deciding, so two concurrent sweep ticks for the same organization can't both decide to charge. */
export async function lockAutoRechargeRule(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<BillingAutoRechargeRuleRecord | null> {
  const [row] = await transaction
    .select()
    .from(billingAutoRechargeRules)
    .where(eq(billingAutoRechargeRules.organizationId, organizationId))
    .for('update')
    .limit(1)
  return row ?? null
}

export interface UpsertAutoRechargeRuleInput {
  organizationId: string
  ownerUserId: string
  enabled: boolean
  packCatalogKey: string
  balanceThresholdUnits: number
  monthlyCapCents: number
  state: string
  consentVersion: string
}

/** The only write path for owner-initiated configuration — always resets `pendingPaymentIntentId`/`lastFailureAt`/`lastFailureReason` to null: a fresh configuration is a fresh start, never carrying over a stale in-flight marker or failure reason from before the owner changed anything. */
export async function upsertAutoRechargeRule(
  transaction: TenantTransaction,
  input: UpsertAutoRechargeRuleInput,
): Promise<BillingAutoRechargeRuleRecord> {
  const [row] = await transaction
    .insert(billingAutoRechargeRules)
    .values({ ...input, pendingPaymentIntentId: null, lastFailureAt: null, lastFailureReason: null })
    .onConflictDoUpdate({
      target: billingAutoRechargeRules.organizationId,
      set: {
        ownerUserId: input.ownerUserId,
        enabled: input.enabled,
        packCatalogKey: input.packCatalogKey,
        balanceThresholdUnits: input.balanceThresholdUnits,
        monthlyCapCents: input.monthlyCapCents,
        state: input.state,
        consentVersion: input.consentVersion,
        pendingPaymentIntentId: null,
        lastFailureAt: null,
        lastFailureReason: null,
        updatedAt: new Date(),
      },
    })
    .returning()
  return row
}

/** Owner-initiated disable — never touches `packCatalogKey`/`balanceThresholdUnits`/`monthlyCapCents`/`consentVersion`, so re-enabling later can default back to the owner's last configuration rather than forcing them to re-enter it. */
export async function disableAutoRechargeRule(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<BillingAutoRechargeRuleRecord | null> {
  const [row] = await transaction
    .update(billingAutoRechargeRules)
    .set({ enabled: false, state: 'inactive', pendingPaymentIntentId: null, updatedAt: new Date() })
    .where(eq(billingAutoRechargeRules.organizationId, organizationId))
    .returning()
  return row ?? null
}

/** Pauses a rule BEFORE any charge was ever attempted (e.g. its configured pack retired) — distinct from `resolveAutoRechargeTrigger`, which resolves an already-in-flight charge's outcome and requires a matching `pendingPaymentIntentId` to do so. */
export async function pauseAutoRechargeRule(
  transaction: TenantTransaction,
  organizationId: string,
  update: { state: string; lastFailureAt: Date; lastFailureReason: string },
): Promise<BillingAutoRechargeRuleRecord | null> {
  const [row] = await transaction
    .update(billingAutoRechargeRules)
    .set({
      state: update.state,
      lastFailureAt: update.lastFailureAt,
      lastFailureReason: update.lastFailureReason,
      pendingPaymentIntentId: null,
      updatedAt: new Date(),
    })
    .where(eq(billingAutoRechargeRules.organizationId, organizationId))
    .returning()
  return row ?? null
}

/**
 * Atomically claims the right to trigger a new off-session charge — only succeeds (returns a row)
 * when the rule is still `active` and has no other charge already in flight. Callers MUST have
 * already locked the row via `lockAutoRechargeRule` in the same transaction (this function's own
 * `WHERE` is the second half of that check-then-act, not a substitute for the lock: the lock is what
 * makes two concurrent transactions serialize instead of both reading "eligible" before either
 * writes).
 */
export async function claimAutoRechargeTrigger(
  transaction: TenantTransaction,
  organizationId: string,
  paymentIntentId: string,
): Promise<BillingAutoRechargeRuleRecord | null> {
  const [row] = await transaction
    .update(billingAutoRechargeRules)
    .set({ pendingPaymentIntentId: paymentIntentId, updatedAt: new Date() })
    .where(and(
      eq(billingAutoRechargeRules.organizationId, organizationId),
      eq(billingAutoRechargeRules.state, 'active'),
      isNull(billingAutoRechargeRules.pendingPaymentIntentId),
    ))
    .returning()
  return row ?? null
}

/** Resolves an in-flight charge's outcome — no-ops if `pendingPaymentIntentId` no longer matches (a duplicate/out-of-order webhook delivery arriving after the marker was already cleared by an earlier delivery of the SAME event). */
export async function resolveAutoRechargeTrigger(
  transaction: TenantTransaction,
  organizationId: string,
  expectedPaymentIntentId: string,
  update: { state: string; lastFailureAt?: Date | null; lastFailureReason?: string | null },
): Promise<BillingAutoRechargeRuleRecord | null> {
  const [row] = await transaction
    .update(billingAutoRechargeRules)
    .set({
      pendingPaymentIntentId: null,
      state: update.state,
      lastFailureAt: update.lastFailureAt ?? null,
      lastFailureReason: update.lastFailureReason ?? null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(billingAutoRechargeRules.organizationId, organizationId),
      eq(billingAutoRechargeRules.pendingPaymentIntentId, expectedPaymentIntentId),
    ))
    .returning()
  return row ?? null
}
