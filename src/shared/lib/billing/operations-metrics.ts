/**
 * Read-only aggregation for the platform billing operations dashboard
 * (plans/stripe-billing-platform/tasks.md §9 "Build platform billing operations dashboard").
 * Every number here is derived from data that already exists elsewhere in this module — this file
 * adds no new business logic, only composes and counts. Platform-admin-only; the route calling this
 * never returns anything beyond these aggregate counts (no raw payloads, no per-organization detail,
 * no secrets).
 *
 * Cross-organization counts (grace/refunds/disputes/risk exceptions/credit invariants) are computed
 * by looping over every organization and reading through the existing per-organization repository
 * functions inside a `builderhunt_worker`-scoped transaction (`withWorkerOrganization`) — the SAME
 * O(organizations) cross-org sweep pattern `billing-worker.ts` already establishes and documents as
 * "acceptable at this app's current scale." No new RLS policy was added for this: every one of these
 * tables' existing platform-role RLS policies are still organization-scoped (`USING (organization_id
 * = current_setting('app.organization_id'))`), so a genuinely unscoped cross-org read isn't possible
 * without either a new "platform sees everything" policy or this per-organization loop — the loop was
 * chosen as the smaller, zero-schema-change option for a beta-scale organization count.
 */
import { and, desc, eq, lt } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { platformDb } from '../db/client'
import { billingCreditReservations, billingReconciliationRuns, billingWebhookEvents } from '../db/schema'
import { getCurrentSellerProfile } from './seller-profile'
import { listOrganizationDisputes } from './disputes'
import { listRiskExceptions } from './risk'
import { isLiveMode } from './stripe-client'
import { listBillingRefunds } from '../repositories/billing'
import { listGracePeriodBillingSubscriptions, listWorkerOrganizationIds, withWorkerOrganization } from '../repositories/billing-worker'

export interface WebhookBacklogMetrics {
  pending: number
  processing: number
  failed: number
  ignored: number
  processed: number
}

export interface BillingOperationsMetrics {
  liveMode: boolean
  configuration: {
    version: number
    effectiveAt: string
    statementDescriptor: string
    supportEmail: string
  } | null
  webhooks: WebhookBacklogMetrics
  grace: {
    organizationsInGrace: number
  }
  refunds: {
    pendingRequests: number
  }
  disputes: {
    open: number
  }
  riskExceptions: {
    active: number
  }
  creditInvariants: {
    /** Reservations still `reserved` past their own `deadlineAt` — should have been swept to `expired` by the reservation worker; a non-zero count here means that sweep is stuck or falling behind. */
    staleReservations: number
  }
  reconciliation: {
    lastRun: { windowEnd: string; result: string } | null
  }
  /** Cost/margin tracking does not exist yet (plans/stripe-billing-platform/tasks.md §10 "Create accounting and margin export") — reported explicitly rather than a fabricated number. */
  costMargin: { available: false }
  organizationsScanned: number
}

export interface BillingOperationsMetricsDeps {
  platform?: PostgresJsDatabase | typeof platformDb
  worker?: Parameters<typeof withWorkerOrganization>[2]
}

async function countWebhookBacklog(db: PostgresJsDatabase | typeof platformDb): Promise<WebhookBacklogMetrics> {
  const rows = await db.select({ status: billingWebhookEvents.status }).from(billingWebhookEvents)
  const counts: WebhookBacklogMetrics = { pending: 0, processing: 0, failed: 0, ignored: 0, processed: 0 }
  for (const row of rows) {
    if (row.status in counts) counts[row.status as keyof WebhookBacklogMetrics] += 1
  }
  return counts
}

async function getLastReconciliationRun(db: PostgresJsDatabase | typeof platformDb): Promise<{ windowEnd: string; result: string } | null> {
  const [row] = await db
    .select({ windowEnd: billingReconciliationRuns.windowEnd, result: billingReconciliationRuns.result })
    .from(billingReconciliationRuns)
    .orderBy(desc(billingReconciliationRuns.createdAt))
    .limit(1)
  return row ? { windowEnd: row.windowEnd.toISOString(), result: row.result } : null
}

export async function getBillingOperationsMetrics(deps: BillingOperationsMetricsDeps = {}): Promise<BillingOperationsMetrics> {
  const platform = deps.platform ?? platformDb
  const livemode = isLiveMode()

  const [sellerProfile, webhooks, lastReconciliationRun, organizationIds] = await Promise.all([
    getCurrentSellerProfile(platform),
    countWebhookBacklog(platform),
    getLastReconciliationRun(platform),
    listWorkerOrganizationIds(),
  ])

  let organizationsInGrace = 0
  let pendingRefundRequests = 0
  let openDisputes = 0
  let activeRiskExceptions = 0
  let staleReservations = 0
  const now = new Date()

  for (const { id: organizationId } of organizationIds) {
    await withWorkerOrganization(organizationId, async (transaction) => {
      const [grace, refunds, disputes, riskExceptions, staleReservationRows] = await Promise.all([
        listGracePeriodBillingSubscriptions(transaction, organizationId),
        listBillingRefunds(transaction, organizationId),
        listOrganizationDisputes(transaction, organizationId),
        listRiskExceptions(organizationId, transaction),
        transaction
          .select({ id: billingCreditReservations.id })
          .from(billingCreditReservations)
          .where(and(
            eq(billingCreditReservations.organizationId, organizationId),
            eq(billingCreditReservations.state, 'reserved'),
            lt(billingCreditReservations.deadlineAt, now),
          )),
      ])

      if (grace.length > 0) organizationsInGrace += 1
      pendingRefundRequests += refunds.filter((r) => r.state === 'pending').length
      openDisputes += disputes.filter((d) => d.outcome === 'open').length
      activeRiskExceptions += riskExceptions.filter((r) => !r.revokedAt && (!r.expiresAt || r.expiresAt > now)).length
      staleReservations += staleReservationRows.length
    }, deps.worker)
  }

  return {
    liveMode: livemode,
    configuration: sellerProfile
      ? {
          version: sellerProfile.version,
          effectiveAt: sellerProfile.effectiveAt.toISOString(),
          statementDescriptor: sellerProfile.statementDescriptor,
          supportEmail: sellerProfile.supportEmail,
        }
      : null,
    webhooks,
    grace: { organizationsInGrace },
    refunds: { pendingRequests: pendingRefundRequests },
    disputes: { open: openDisputes },
    riskExceptions: { active: activeRiskExceptions },
    creditInvariants: { staleReservations },
    reconciliation: { lastRun: lastReconciliationRun },
    costMargin: { available: false },
    organizationsScanned: organizationIds.length,
  }
}
