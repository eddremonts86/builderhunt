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
import { and, desc, eq, gte, isNotNull, lt } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { metrics } from '../metrics'
import { platformDb } from '../db/client'
import { billingAutoRechargeRules, billingCheckoutAttempts, billingCreditReservations, billingLedgerEntries, billingReconciliationRuns, billingSubscriptions, billingWebhookEvents } from '../db/schema'
import { getCurrentSellerProfile } from './seller-profile'
import { listOrganizationDisputes } from './disputes'
import { listRiskExceptions } from './risk'
import { isLiveMode } from './stripe-client'
import { listActiveBillingCreditGrants, listBillingRefunds } from '../repositories/billing'
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
  /** Last 24h of `billing_checkout_attempts`, by status, across every organization — an elevated `expired`/`canceled` share is the checkout-failure signal §10 asks for. `billing_checkout_attempts` has no `builderhunt_platform` RLS policy (only `app`/`worker`), so this MUST be read per-organization through the same worker-scoped sweep as everything else below, never through a bare `platformDb` query (which would silently return zero rows forever). */
  checkout: {
    open: number
    complete: number
    expired: number
    canceled: number
  }
  /** Dunning outcome snapshot: organizations currently recovering (in grace) vs. currently blocked (grace exhausted without recovery) — the closest honest signal available without a dedicated recovery-event history (§10 "recovery" metric; `grace.organizationsInGrace` above is one input to it, this reframes both sides together). */
  recovery: {
    inGrace: number
    blocked: number
  }
  /** Age of the oldest still-unprocessed webhook event — distinct from `webhooks`'s mere backlog COUNT; a large age with a small count is still an SLO problem a count alone would hide. */
  webhookAge: {
    oldestPendingMinutes: number | null
  }
  /** Recomputes each active grant's balance from its own `billing_ledger_entries` and diffs it against the denormalized `remainingUnits` column — a non-zero count is a real data-integrity bug, not a business condition (§10 "ledger invariant" metric). */
  ledgerInvariant: {
    violations: number
  }
  /** Current `billing_auto_recharge_rules` state distribution across every organization (§10 "auto-recharge" metric) — this table has no event history, only current state per org. */
  autoRecharge: {
    active: number
    pausedNeedsAuth: number
    pausedFailed: number
  }
  /** In-process counter of Checkout attempts rejected for `country_not_allowed` (`checkout.ts`/`packs.ts`) — the only signal available today, since a country-gate rejection happens BEFORE any `billing_checkout_attempts` row is ever written, leaving no other trace. Resets on server restart, same caveat as every other `metrics.ts` counter. */
  countryGate: {
    rejectionsSinceStart: number
  }
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

async function getOldestPendingWebhookAgeMinutes(db: PostgresJsDatabase | typeof platformDb, now: Date): Promise<number | null> {
  const rows = await db
    .select({ receivedAt: billingWebhookEvents.receivedAt })
    .from(billingWebhookEvents)
    .where(and(eq(billingWebhookEvents.status, 'pending')))
  if (rows.length === 0) return null
  const oldest = rows.reduce((min, row) => (row.receivedAt < min ? row.receivedAt : min), rows[0].receivedAt)
  return Math.floor((now.getTime() - oldest.getTime()) / (60 * 1000))
}

export async function getBillingOperationsMetrics(deps: BillingOperationsMetricsDeps = {}): Promise<BillingOperationsMetrics> {
  const platform = deps.platform ?? platformDb
  const livemode = isLiveMode()
  const now = new Date()
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  const [sellerProfile, webhooks, lastReconciliationRun, webhookAgeMinutes, organizationIds] = await Promise.all([
    getCurrentSellerProfile(platform),
    countWebhookBacklog(platform),
    getLastReconciliationRun(platform),
    getOldestPendingWebhookAgeMinutes(platform, now),
    listWorkerOrganizationIds(),
  ])

  let organizationsInGrace = 0
  let organizationsBlocked = 0
  let pendingRefundRequests = 0
  let openDisputes = 0
  let activeRiskExceptions = 0
  let staleReservations = 0
  let ledgerInvariantViolations = 0
  let autoRechargeActive = 0
  let autoRechargePausedNeedsAuth = 0
  let autoRechargePausedFailed = 0
  const checkout: BillingOperationsMetrics['checkout'] = { open: 0, complete: 0, expired: 0, canceled: 0 }

  for (const { id: organizationId } of organizationIds) {
    await withWorkerOrganization(organizationId, async (transaction) => {
      const [grace, refunds, disputes, riskExceptions, staleReservationRows, activeGrants, autoRechargeRule, blockedSubscription, checkoutAttempts] = await Promise.all([
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
        listActiveBillingCreditGrants(transaction, organizationId),
        transaction
          .select({ state: billingAutoRechargeRules.state })
          .from(billingAutoRechargeRules)
          .where(eq(billingAutoRechargeRules.organizationId, organizationId)),
        transaction
          .select({ id: billingSubscriptions.id })
          .from(billingSubscriptions)
          .where(and(eq(billingSubscriptions.organizationId, organizationId), isNotNull(billingSubscriptions.paymentBlockedAt)))
          .limit(1),
        transaction
          .select({ status: billingCheckoutAttempts.status })
          .from(billingCheckoutAttempts)
          .where(and(eq(billingCheckoutAttempts.organizationId, organizationId), gte(billingCheckoutAttempts.createdAt, oneDayAgo))),
      ])

      if (grace.length > 0) organizationsInGrace += 1
      if (blockedSubscription.length > 0) organizationsBlocked += 1
      pendingRefundRequests += refunds.filter((r) => r.state === 'pending').length
      openDisputes += disputes.filter((d) => d.outcome === 'open').length
      activeRiskExceptions += riskExceptions.filter((r) => !r.revokedAt && (!r.expiresAt || r.expiresAt > now)).length
      staleReservations += staleReservationRows.length

      for (const rule of autoRechargeRule) {
        if (rule.state === 'active') autoRechargeActive += 1
        else if (rule.state === 'paused_needs_auth') autoRechargePausedNeedsAuth += 1
        else if (rule.state === 'paused_failed') autoRechargePausedFailed += 1
      }

      for (const attempt of checkoutAttempts) {
        if (attempt.status in checkout) checkout[attempt.status as keyof typeof checkout] += 1
      }

      for (const grant of activeGrants) {
        const ledgerRows = await transaction
          .select({ unitsDelta: billingLedgerEntries.unitsDelta })
          .from(billingLedgerEntries)
          .where(and(eq(billingLedgerEntries.organizationId, organizationId), eq(billingLedgerEntries.grantId, grant.id)))
        const computedRemaining = ledgerRows.reduce((sum, row) => sum + row.unitsDelta, 0)
        if (computedRemaining !== grant.remainingUnits) ledgerInvariantViolations += 1
      }
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
    checkout,
    recovery: { inGrace: organizationsInGrace, blocked: organizationsBlocked },
    webhookAge: { oldestPendingMinutes: webhookAgeMinutes },
    ledgerInvariant: { violations: ledgerInvariantViolations },
    autoRecharge: { active: autoRechargeActive, pausedNeedsAuth: autoRechargePausedNeedsAuth, pausedFailed: autoRechargePausedFailed },
    countryGate: { rejectionsSinceStart: metrics.get().checkoutCountryGateRejections },
    organizationsScanned: organizationIds.length,
  }
}

/**
 * SLO thresholds for the platform billing operations metrics (plans/stripe-billing-platform/
 * tasks.md §10 "...critical SLO alerts"). No prior doc in this codebase defines a concrete number
 * for any of these — this is the first place one is set, deliberately conservative (catches a real
 * problem, not routine noise) and documented in `docs/operations/stripe-alerts.md`. Pure function,
 * no I/O: takes the metrics `getBillingOperationsMetrics` already computed and returns the critical
 * conditions among them.
 */
export function evaluateBillingAlerts(metricsSnapshot: BillingOperationsMetrics): string[] {
  const alerts: string[] = []
  if (metricsSnapshot.webhookAge.oldestPendingMinutes !== null && metricsSnapshot.webhookAge.oldestPendingMinutes > 120) {
    alerts.push(`Oldest pending webhook event is ${metricsSnapshot.webhookAge.oldestPendingMinutes} minutes old (SLO: 120)`)
  }
  if (metricsSnapshot.webhooks.failed > 0) {
    alerts.push(`${metricsSnapshot.webhooks.failed} webhook event(s) permanently failed`)
  }
  if (metricsSnapshot.ledgerInvariant.violations > 0) {
    alerts.push(`${metricsSnapshot.ledgerInvariant.violations} credit ledger invariant violation(s) detected`)
  }
  if (metricsSnapshot.autoRecharge.pausedFailed > 0) {
    alerts.push(`${metricsSnapshot.autoRecharge.pausedFailed} organization(s) have auto-recharge paused due to failure`)
  }
  if (metricsSnapshot.reconciliation.lastRun && metricsSnapshot.reconciliation.lastRun.result !== 'clean') {
    alerts.push(`Last reconciliation run was not clean (${metricsSnapshot.reconciliation.lastRun.result})`)
  }
  return alerts
}
