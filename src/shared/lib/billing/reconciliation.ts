/**
 * Daily financial reconciliation (plans/stripe-billing-platform/tasks.md §10 "Implement daily
 * financial reconciliation"). Pages through the provider's own listing of customers, subscriptions,
 * payment intents, and refunds (`BillingProvider.listForReconciliation`) and compares each against
 * this app's internal record for the same object, across every organization — the SAME
 * O(organizations) cross-org sweep pattern `operations-metrics.ts` already establishes (worker-role,
 * `listWorkerOrganizationIds` + `withWorkerOrganization` per org), not a new access pattern.
 *
 * Scope decisions, made explicit rather than silently assumed:
 * - Disputes are deliberately NOT paged through here. Unlike the other four object types, we never
 *   create a dispute — Stripe always initiates it, and the ONLY way we ever learn about one is a
 *   signed `charge.dispute.*` webhook event (`webhook-handlers.ts`). There is no "did we create what
 *   Stripe has" drift class for an object type we never write to; dispute integrity is a webhook-
 *   signature-and-idempotency concern (§6), already covered, not a listing-reconciliation one.
 * - "Payment intents" reconciles against `billing_credit_grants.stripePaymentIntentId` (the only
 *   internal record of a payment intent we ever kept) by EXISTENCE only — this app never stores a
 *   payment intent's own status/amount locally, so staleness cannot be checked for this type, only
 *   whether Stripe and our credit-grant history agree an id exists at all. A payment intent Stripe
 *   successfully charged with no matching grant is the single most financially serious mismatch this
 *   function can find (money collected, credits never issued) — this is exactly the class of bug
 *   `missing_internal` on this type is built to catch.
 * - Only "subscriptions" mismatches are ever auto-repaired (`syncBillingSubscriptionMirrorFromProvider`
 *   — a pure, idempotent field re-sync, the same three fields a real webhook event would set). Every
 *   other mismatch (missing/extra/duplicate on any type, and missing/extra on customers/refunds/
 *   payment_intents) is report-only forever: creating or deleting a financial row automatically could
 *   paper over a real bug or silently duplicate/lose money, which is never "safe."
 * - Only currently-active subscriptions are compared (`findFullActiveBillingSubscription` — the same
 *   query `subscription-changes.ts` uses) — a canceled subscription carries no further financial risk
 *   to reconcile.
 * - "Duplicate" means the PROVIDER's own listing contains the same id more than once (a pagination/
 *   listing artifact) — an internal duplicate is structurally impossible for customers/subscriptions
 *   (both have a database-level unique index on their Stripe id), so there is no separate "duplicate
 *   internal" class to detect.
 */
import { and, eq, isNotNull } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { workerDb } from '../db/worker-db'
import { billingCreditGrants, billingCustomers, billingReconciliationRuns, billingRefunds } from '../db/schema'
import type { BillingPaymentIntent, BillingProvider, BillingRefund, BillingSubscription, ReconciliationObjectType } from './provider'
import { findFullActiveBillingSubscription, syncBillingSubscriptionMirrorFromProvider } from '../repositories/billing'
import { listWorkerOrganizationIds, withWorkerOrganization } from '../repositories/billing-worker'
import { isLiveMode } from './stripe-client'

const OBJECT_TYPES: ReconciliationObjectType[] = ['customers', 'subscriptions', 'payment_intents', 'refunds']

export type ReconciliationMismatchType = 'missing_internal' | 'extra_internal' | 'stale_internal' | 'duplicate_provider_listing'

export interface ReconciliationMismatch {
  type: ReconciliationMismatchType
  objectType: ReconciliationObjectType
  providerId: string
  detail: string
}

export interface ReconciliationRepair {
  objectType: ReconciliationObjectType
  providerId: string
  action: string
}

/** Which object type to resume from — a run that hit its time budget mid-type restarts at that same type on the next call rather than silently skipping it or redoing already-finished types. */
export interface ReconciliationCursor {
  objectType: ReconciliationObjectType
}

export interface RunReconciliationDeps {
  provider: BillingProvider
  now?: () => Date
  actorUserId?: string | null
  /** Wall-clock budget for this single invocation — once exceeded, the run stops after finishing the current object type and returns a cursor for the next call to resume from, rather than a partial mid-type result. */
  maxDurationMs?: number
  resumeFrom?: ReconciliationCursor | null
  worker?: Parameters<typeof withWorkerOrganization>[2]
}

export interface RunReconciliationResult {
  id: string
  windowStart: string
  windowEnd: string
  countsChecked: Record<string, number>
  mismatches: ReconciliationMismatch[]
  repairs: ReconciliationRepair[]
  result: 'clean' | 'mismatches_found' | 'repairs_applied'
  /** Non-null only when the time budget was hit before every object type finished — pass this straight back in as `resumeFrom` on the next call. */
  resumeCursor: ReconciliationCursor | null
}

interface InternalRecord {
  organizationId: string
  providerId: string
}

async function collectInternalCustomers(organizationIds: string[], livemode: boolean, worker?: RunReconciliationDeps['worker']): Promise<InternalRecord[]> {
  const results: InternalRecord[] = []
  for (const organizationId of organizationIds) {
    await withWorkerOrganization(organizationId, async (transaction) => {
      const [row] = await transaction
        .select({ stripeCustomerId: billingCustomers.stripeCustomerId })
        .from(billingCustomers)
        .where(and(eq(billingCustomers.organizationId, organizationId), eq(billingCustomers.livemode, livemode)))
        .limit(1)
      if (row) results.push({ organizationId, providerId: row.stripeCustomerId })
    }, worker)
  }
  return results
}

interface InternalSubscriptionRecord extends InternalRecord {
  stripeStatus: string
  cancelAtPeriodEnd: boolean
  currentPeriodEnd: Date | null
}

async function collectInternalSubscriptions(organizationIds: string[], livemode: boolean, worker?: RunReconciliationDeps['worker']): Promise<InternalSubscriptionRecord[]> {
  const results: InternalSubscriptionRecord[] = []
  for (const organizationId of organizationIds) {
    await withWorkerOrganization(organizationId, async (transaction) => {
      const subscription = await findFullActiveBillingSubscription(transaction, organizationId, livemode)
      if (subscription) {
        results.push({
          organizationId,
          providerId: subscription.stripeSubscriptionId,
          stripeStatus: subscription.stripeStatus,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          currentPeriodEnd: subscription.currentPeriodEnd,
        })
      }
    }, worker)
  }
  return results
}

async function collectInternalRefunds(organizationIds: string[], worker?: RunReconciliationDeps['worker']): Promise<Array<InternalRecord & { state: string; amountCents: number }>> {
  const results: Array<InternalRecord & { state: string; amountCents: number }> = []
  for (const organizationId of organizationIds) {
    await withWorkerOrganization(organizationId, async (transaction) => {
      const rows = await transaction
        .select({ stripeRefundId: billingRefunds.stripeRefundId, state: billingRefunds.state, amountCents: billingRefunds.amountCents })
        .from(billingRefunds)
        .where(eq(billingRefunds.organizationId, organizationId))
      for (const row of rows) {
        if (row.stripeRefundId) results.push({ organizationId, providerId: row.stripeRefundId, state: row.state, amountCents: row.amountCents })
      }
    }, worker)
  }
  return results
}

async function collectInternalPaymentIntents(organizationIds: string[], worker?: RunReconciliationDeps['worker']): Promise<InternalRecord[]> {
  const results: InternalRecord[] = []
  for (const organizationId of organizationIds) {
    await withWorkerOrganization(organizationId, async (transaction) => {
      const rows = await transaction
        .select({ stripePaymentIntentId: billingCreditGrants.stripePaymentIntentId })
        .from(billingCreditGrants)
        .where(and(eq(billingCreditGrants.organizationId, organizationId), isNotNull(billingCreditGrants.stripePaymentIntentId)))
      for (const row of rows) {
        if (row.stripePaymentIntentId) results.push({ organizationId, providerId: row.stripePaymentIntentId })
      }
    }, worker)
  }
  return results
}

/** Exported for direct unit testing — `FakeBillingProvider`'s Map-backed storage can never itself produce a duplicate listing, so this pure function is the only way to exercise "duplicate" detection without a real Stripe pagination-overlap artifact to reproduce. */
export function findDuplicateProviderIds(providerRecords: Array<{ id: string }>): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const record of providerRecords) {
    if (seen.has(record.id)) duplicates.add(record.id)
    seen.add(record.id)
  }
  return Array.from(duplicates)
}

async function reconcileObjectType(
  objectType: ReconciliationObjectType,
  organizationIds: string[],
  deps: RunReconciliationDeps,
  livemode: boolean,
): Promise<{ mismatches: ReconciliationMismatch[]; repairs: ReconciliationRepair[]; checked: number }> {
  const mismatches: ReconciliationMismatch[] = []
  const repairs: ReconciliationRepair[] = []
  const providerRecords = await deps.provider.listForReconciliation(objectType)

  for (const duplicateId of findDuplicateProviderIds(providerRecords as Array<{ id: string }>)) {
    mismatches.push({ type: 'duplicate_provider_listing', objectType, providerId: duplicateId, detail: `Provider listing for ${objectType} contains ${duplicateId} more than once` })
  }
  const providerById = new Map<string, unknown>()
  for (const record of providerRecords as Array<{ id: string }>) providerById.set(record.id, record)

  if (objectType === 'customers') {
    const internal = await collectInternalCustomers(organizationIds, livemode, deps.worker)
    const internalIds = new Set(internal.map((r) => r.providerId))
    for (const id of providerById.keys()) {
      if (!internalIds.has(id)) mismatches.push({ type: 'missing_internal', objectType, providerId: id, detail: `Provider has customer ${id}; no internal billing_customers row references it` })
    }
    for (const record of internal) {
      if (!providerById.has(record.providerId)) mismatches.push({ type: 'extra_internal', objectType, providerId: record.providerId, detail: `Internal billing_customers row (org ${record.organizationId}) references customer ${record.providerId}, which the provider does not have` })
    }
    return { mismatches, repairs, checked: providerById.size }
  }

  if (objectType === 'subscriptions') {
    const internal = await collectInternalSubscriptions(organizationIds, livemode, deps.worker)
    const internalById = new Map(internal.map((r) => [r.providerId, r]))
    for (const [id, providerRecord] of providerById) {
      const record = providerRecord as BillingSubscription
      const internalRecord = internalById.get(id)
      if (!internalRecord) {
        mismatches.push({ type: 'missing_internal', objectType, providerId: id, detail: `Provider has subscription ${id}; no internal active billing_subscriptions row references it` })
        continue
      }
      const staleStatus = internalRecord.stripeStatus !== record.status
      const staleCancelFlag = internalRecord.cancelAtPeriodEnd !== record.cancelAtPeriodEnd
      const staleCurrentPeriodEnd = internalRecord.currentPeriodEnd?.toISOString() !== record.currentPeriodEnd
      if (staleStatus || staleCancelFlag || staleCurrentPeriodEnd) {
        mismatches.push({ type: 'stale_internal', objectType, providerId: id, detail: `Internal subscription ${id} (org ${internalRecord.organizationId}) is out of sync with the provider (status/cancelAtPeriodEnd/currentPeriodEnd)` })
        await withWorkerOrganization(internalRecord.organizationId, (transaction) =>
          syncBillingSubscriptionMirrorFromProvider(transaction, internalRecord.organizationId, id, {
            stripeStatus: record.status,
            cancelAtPeriodEnd: record.cancelAtPeriodEnd,
            currentPeriodEnd: new Date(record.currentPeriodEnd),
          }), deps.worker)
        repairs.push({ objectType, providerId: id, action: 'Re-synced stripeStatus/cancelAtPeriodEnd/currentPeriodEnd from the provider' })
      }
    }
    for (const record of internal) {
      if (!providerById.has(record.providerId)) mismatches.push({ type: 'extra_internal', objectType, providerId: record.providerId, detail: `Internal active billing_subscriptions row (org ${record.organizationId}) references subscription ${record.providerId}, which the provider does not have` })
    }
    return { mismatches, repairs, checked: providerById.size }
  }

  if (objectType === 'refunds') {
    const internal = await collectInternalRefunds(organizationIds, deps.worker)
    const internalById = new Map(internal.map((r) => [r.providerId, r]))
    for (const [id, providerRecord] of providerById) {
      const record = providerRecord as BillingRefund
      const internalRecord = internalById.get(id)
      if (!internalRecord) {
        mismatches.push({ type: 'missing_internal', objectType, providerId: id, detail: `Provider has refund ${id}; no internal billing_refunds row references it` })
        continue
      }
      if (internalRecord.state !== 'repair_needed' && internalRecord.state !== record.status) {
        mismatches.push({ type: 'stale_internal', objectType, providerId: id, detail: `Internal refund ${id} (org ${internalRecord.organizationId}) state "${internalRecord.state}" does not match provider status "${record.status}"` })
      }
    }
    for (const record of internal) {
      if (!providerById.has(record.providerId)) mismatches.push({ type: 'extra_internal', objectType, providerId: record.providerId, detail: `Internal billing_refunds row (org ${record.organizationId}) references refund ${record.providerId}, which the provider does not have` })
    }
    return { mismatches, repairs, checked: providerById.size }
  }

  // payment_intents — existence only, see this file's top comment.
  const internal = await collectInternalPaymentIntents(organizationIds, deps.worker)
  const internalIds = new Set(internal.map((r) => r.providerId))
  for (const [id, providerRecord] of providerById) {
    const record = providerRecord as BillingPaymentIntent
    if (record.status === 'succeeded' && !internalIds.has(id)) {
      mismatches.push({ type: 'missing_internal', objectType, providerId: id, detail: `Provider has a SUCCEEDED payment_intent ${id}; no internal billing_credit_grants row references it — money collected, credits possibly never issued` })
    }
  }
  for (const record of internal) {
    if (!providerById.has(record.providerId)) mismatches.push({ type: 'extra_internal', objectType, providerId: record.providerId, detail: `Internal billing_credit_grants row (org ${record.organizationId}) references payment_intent ${record.providerId}, which the provider does not have` })
  }
  return { mismatches, repairs, checked: providerById.size }
}

export async function runReconciliation(deps: RunReconciliationDeps): Promise<RunReconciliationResult> {
  const now = (deps.now ?? (() => new Date()))()
  const maxDurationMs = deps.maxDurationMs ?? 60_000
  // Writing the run row needs `builderhunt_worker` (INSERT-granted, `0028_billing_rls_grants.sql`) —
  // `builderhunt_platform` is SELECT-only on this table, read-side only (see `operations-metrics.ts`'s
  // `getLastReconciliationRun` and the ops dashboard).
  const worker = deps.worker ?? workerDb
  const livemode = isLiveMode()
  const windowStart = now

  const organizationRows = await listWorkerOrganizationIds(deps.worker)
  const organizationIds = organizationRows.map((r) => r.id)

  const startIndex = deps.resumeFrom ? OBJECT_TYPES.indexOf(deps.resumeFrom.objectType) : 0
  const allMismatches: ReconciliationMismatch[] = []
  const allRepairs: ReconciliationRepair[] = []
  const countsChecked: Record<string, number> = {}
  let resumeCursor: ReconciliationCursor | null = null
  const deadline = Date.now() + maxDurationMs

  for (let i = Math.max(0, startIndex); i < OBJECT_TYPES.length; i++) {
    const objectType = OBJECT_TYPES[i]
    const { mismatches, repairs, checked } = await reconcileObjectType(objectType, organizationIds, deps, livemode)
    allMismatches.push(...mismatches)
    allRepairs.push(...repairs)
    countsChecked[objectType] = checked

    if (Date.now() > deadline && i < OBJECT_TYPES.length - 1) {
      resumeCursor = { objectType: OBJECT_TYPES[i + 1] }
      break
    }
  }

  const windowEnd = (deps.now ?? (() => new Date()))()
  const result = allRepairs.length > 0 ? 'repairs_applied' : allMismatches.length > 0 ? 'mismatches_found' : 'clean'
  const id = randomUUID()

  // Only persist a run row for a COMPLETE pass — a partial (resumed) run has nothing conclusive to
  // report yet; the eventual completing call is what writes the durable record.
  if (!resumeCursor) {
    await worker.insert(billingReconciliationRuns).values({
      id,
      windowStart,
      windowEnd,
      countsChecked,
      // The stored row uses the pre-existing, more generic {type, reference, detail/action} shape
      // (`billingReconciliationRuns`'s own jsonb column types) — `reference` combines objectType and
      // providerId since the table has no separate column for each; the richer typed shape above
      // (`ReconciliationMismatch`/`ReconciliationRepair`) is what this function actually returns to
      // its caller and is what tests assert against.
      mismatches: allMismatches.map((m) => ({ type: m.type, reference: `${m.objectType}:${m.providerId}`, detail: m.detail })),
      repairs: allRepairs.map((r) => ({ type: 'subscription_mirror_resync', reference: `${r.objectType}:${r.providerId}`, action: r.action })),
      result,
      actorUserId: deps.actorUserId ?? null,
    })
  }

  return {
    id,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    countsChecked,
    mismatches: allMismatches,
    repairs: allRepairs,
    result,
    resumeCursor,
  }
}
