/**
 * Monthly accounting and margin export (plans/implemented/30-stripe-billing-platform/tasks.md §10 "Create
 * accounting and margin export"). Same read-only, cross-organization sweep pattern
 * `operations-metrics.ts`/`reconciliation.ts` already establish (`listWorkerOrganizationIds` +
 * `withWorkerOrganization`), no new RLS policy.
 *
 * `spec.md`'s "never fabricate" principle (already codified in `operations-metrics.ts`'s
 * `costMargin: { available: false }` and `reconciliation.ts`'s report-only mismatches) governs every
 * field here too. This app's `BillingProvider` never exposes Stripe balance transactions, payouts, or
 * fees (see `provider.ts`) — and no invoice entity is ever persisted (an `invoice.paid` webhook only
 * grants credits and sends a receipt email; the invoice's own amount/tax/discount is never stored,
 * see `webhook-handlers.ts`'s `handleInvoicePaid`). So several line items this task's own wording asks
 * for (Stripe fees, payout currency/FX/net, outstanding invoices, discounts, tax) have NO real backing
 * data anywhere in this codebase today, and are reported as `{ available: false, reason }` rather
 * than a fabricated or estimated number — the only real Stripe adapter that could ever supply real
 * balance-transaction/payout/fee/tax data does not exist yet (`stripe-provider.ts` deliberately throws
 * if `STRIPE_BILLING_ENABLED` is set).
 *
 * What IS computed from real stored data:
 * - Gross revenue is an ESTIMATE derived from the immutable catalog list price
 *   (`catalog.ts`) resolved against real stored events in the window — NOT a ledger of actual Stripe
 *   charges, since this app never persists a charge/invoice amount. Subscription revenue counts every
 *   `billing_subscriptions` row whose `currentPeriodStart` falls inside the window (a new billing
 *   period starting is the closest available proxy for "an invoice was likely issued"); pack revenue
 *   counts every pack-sourced `billing_credit_grants` row `createdAt` inside the window (a pack
 *   purchase's grant creation IS the purchase event, not an estimate).
 * - Refunds/disputes read directly from `billing_refunds`/`billing_disputes` — real, stored money
 *   movements. Refund amounts only count `state: 'succeeded'` rows (money actually returned).
 *   Disputes are pack-only (see `disputes.ts`'s own module comment on the subscription-dispute gap).
 * - Unexpired-credit liability is `sum(remainingUnits)` over active, unexpired `billing_credit_grants`
 *   — a real, queryable outstanding-obligation figure (in credit units, not dollars, since credits
 *   have no fixed per-unit dollar redemption rate).
 * - Provider cost by tier/feature: `billing_provider_usage` is the schema-level home for this
 *   (`estimatedCostCents`/`actualCostCents` columns exist, RLS/grants exist), but nothing in the app
 *   ever inserts a row into it yet — reported as unavailable, same as `costMargin` on the ops
 *   dashboard, pending the separate task of wiring real cost tracking into the reservation-settlement
 *   path.
 */
import { and, eq, gt, gte, lt, sql } from 'drizzle-orm'
import { PACK_CATALOG, resolvePackCatalogEntryByKey, resolveSubscriptionCatalogEntryByKey, SUBSCRIPTION_CATALOG } from './catalog'
import { billingCreditGrants, billingDisputes, billingRefunds, billingSubscriptions } from '../db/schema'
import { listWorkerOrganizationIds, withWorkerOrganization } from '../repositories/billing-worker'
import { collectWorkerOrganizationIds } from '../repositories/worker-organization-scan'

export interface AccountingExportUnavailable {
  available: false
  reason: string
}

export interface AccountingExportDeps {
  now?: () => Date
  /** UTC month boundaries — both default to the previous full calendar month relative to `now`. */
  windowStart?: Date
  windowEnd?: Date
  worker?: Parameters<typeof withWorkerOrganization>[2]
}

export interface AccountingExportResult {
  windowStart: string
  windowEnd: string
  organizationsScanned: number
  grossRevenue: {
    basis: 'catalog_price_estimate'
    currency: 'usd'
    subscriptionCents: number
    subscriptionCount: number
    packCents: number
    packCount: number
    totalCents: number
  }
  discounts: AccountingExportUnavailable
  tax: AccountingExportUnavailable
  refunds: { currency: 'usd'; amountCents: number; count: number }
  disputes: { currency: 'usd'; amountCents: number; count: number; scopeNote: string }
  stripeFees: AccountingExportUnavailable
  payout: AccountingExportUnavailable
  outstandingInvoices: AccountingExportUnavailable
  unexpiredCreditLiability: { units: number }
  providerCostByTierFeature: AccountingExportUnavailable
}

const UNAVAILABLE = (reason: string): AccountingExportUnavailable => ({ available: false, reason })

/** Previous full UTC calendar month relative to `now` — the natural window for a job run just after month-end. */
function previousMonthWindow(now: Date): { windowStart: Date; windowEnd: Date } {
  const windowEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  return { windowStart, windowEnd }
}

/**
 * Distinct catalog keys one organization can have bought inside one month.
 *
 * The two revenue reads group by a catalog key and multiply the count by the price the catalog holds
 * in code, so their row count is the catalog's cardinality — not the number of purchases. Named from
 * the register rather than as a literal so it moves when the catalog does.
 */
const SUBSCRIPTION_CATALOG_KEY_CEILING = Object.keys(SUBSCRIPTION_CATALOG).length + Object.keys(PACK_CATALOG).length

export async function getAccountingExport(deps: AccountingExportDeps = {}): Promise<AccountingExportResult> {
  const now = (deps.now ?? (() => new Date()))()
  const defaults = previousMonthWindow(now)
  const windowStart = deps.windowStart ?? defaults.windowStart
  const windowEnd = deps.windowEnd ?? defaults.windowEnd

  // Drained rather than one batch: `listWorkerOrganizationIds` is bounded (plan 12), and a worker
  // that stops at the batch size has silently skipped every organization past it.
  const organizationRows = (await collectWorkerOrganizationIds((after, limit) => listWorkerOrganizationIds(deps.worker, after, limit))).map((id) => ({ id }))

  let subscriptionCents = 0
  let subscriptionCount = 0
  let packCents = 0
  let packCount = 0
  let refundAmountCents = 0
  let refundCount = 0
  let disputeAmountCents = 0
  let disputeCount = 0
  let unexpiredCreditUnits = 0

  for (const { id: organizationId } of organizationRows) {
    await withWorkerOrganization(organizationId, async (transaction) => {
      /*
       * Counted in SQL (plan 12), and every filter that used to run in JavaScript is now a predicate.
       *
       * Three of these five reads used to be unfiltered — every refund, every dispute and every
       * active grant the organization had ever had — with the window applied afterwards in a `for`
       * loop. An export whose cost grows with an account's entire history is a report that gets
       * slower every month it is run, and the two that fed `listBillingRefunds` and
       * `listActiveBillingCreditGrants` were among the reads plan 10 deliberately left unbounded
       * because *this* caller needed all of them. It does not need the rows; it needs the totals.
       *
       * The two revenue reads stay row-shaped but group first: their amounts come from the catalog in
       * code, not from a column, so SQL can only give the counts per key. One row per distinct
       * catalog key is bounded by the catalog itself.
       */
      const [periodStarts, packGrants, refundTotals, disputeTotals, creditTotals] = await Promise.all([
        transaction
          .select({ catalogKey: billingSubscriptions.catalogKey, count: sql<number>`count(*)::int` })
          .from(billingSubscriptions)
          .where(and(
            eq(billingSubscriptions.organizationId, organizationId),
            gte(billingSubscriptions.currentPeriodStart, windowStart),
            lt(billingSubscriptions.currentPeriodStart, windowEnd),
          ))
          .groupBy(billingSubscriptions.catalogKey)
          // One row per distinct subscription catalog key in the window — bounded by the catalog.
          .limit(SUBSCRIPTION_CATALOG_KEY_CEILING),
        transaction
          .select({ sourceReference: billingCreditGrants.sourceReference, count: sql<number>`count(*)::int` })
          .from(billingCreditGrants)
          .where(and(
            eq(billingCreditGrants.organizationId, organizationId),
            eq(billingCreditGrants.source, 'pack'),
            gte(billingCreditGrants.createdAt, windowStart),
            lt(billingCreditGrants.createdAt, windowEnd),
          ))
          .groupBy(billingCreditGrants.sourceReference)
          // One row per distinct pack catalog key in the window — bounded by the same catalog.
          .limit(SUBSCRIPTION_CATALOG_KEY_CEILING),
        transaction
          .select({
            amountCents: sql<number>`coalesce(sum(${billingRefunds.amountCents}), 0)::int`,
            count: sql<number>`count(*)::int`,
          })
          .from(billingRefunds)
          .where(and(
            eq(billingRefunds.organizationId, organizationId),
            eq(billingRefunds.state, 'succeeded'),
            gte(billingRefunds.createdAt, windowStart),
            lt(billingRefunds.createdAt, windowEnd),
          )),
        transaction
          .select({
            amountCents: sql<number>`coalesce(sum(${billingDisputes.amountCents}), 0)::int`,
            count: sql<number>`count(*)::int`,
          })
          .from(billingDisputes)
          .where(and(
            eq(billingDisputes.organizationId, organizationId),
            gte(billingDisputes.createdAt, windowStart),
            lt(billingDisputes.createdAt, windowEnd),
          )),
        transaction
          .select({ units: sql<number>`coalesce(sum(${billingCreditGrants.remainingUnits}), 0)::int` })
          .from(billingCreditGrants)
          .where(and(
            eq(billingCreditGrants.organizationId, organizationId),
            eq(billingCreditGrants.state, 'active'),
            // `> now`, matching the JS `grant.expiresAt > now` it replaces exactly — a grant expiring
            // at this instant was excluded before and stays excluded.
            gt(billingCreditGrants.expiresAt, now),
          )),
      ])

      for (const row of periodStarts) {
        const entry = resolveSubscriptionCatalogEntryByKey(row.catalogKey)
        if (entry) {
          subscriptionCents += entry.amountCents * row.count
          subscriptionCount += row.count
        }
      }

      for (const row of packGrants) {
        const entry = row.sourceReference ? resolvePackCatalogEntryByKey(row.sourceReference) : null
        if (entry) {
          packCents += entry.amountCents * row.count
          packCount += row.count
        }
      }

      refundAmountCents += refundTotals[0]?.amountCents ?? 0
      refundCount += refundTotals[0]?.count ?? 0
      disputeAmountCents += disputeTotals[0]?.amountCents ?? 0
      disputeCount += disputeTotals[0]?.count ?? 0
      unexpiredCreditUnits += creditTotals[0]?.units ?? 0
    }, deps.worker)
  }

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    organizationsScanned: organizationRows.length,
    grossRevenue: {
      basis: 'catalog_price_estimate',
      currency: 'usd',
      subscriptionCents,
      subscriptionCount,
      packCents,
      packCount,
      totalCents: subscriptionCents + packCents,
    },
    discounts: UNAVAILABLE('No coupon/discount amount is ever persisted — allowPromotionCodes is a checkout-time flag only, the resulting discount is never stored'),
    tax: UNAVAILABLE('Stripe Tax computes and owns the collected tax amount; this app never persists an invoice\'s tax line'),
    refunds: { currency: 'usd', amountCents: refundAmountCents, count: refundCount },
    disputes: {
      currency: 'usd',
      amountCents: disputeAmountCents,
      count: disputeCount,
      scopeNote: 'Pack purchase disputes only — subscription-invoice disputes are never recorded (see disputes.ts)',
    },
    stripeFees: UNAVAILABLE('BillingProvider exposes no balance-transaction/fee data, and no real Stripe adapter exists yet to source it from'),
    payout: UNAVAILABLE('BillingProvider exposes no payout data (currency/FX/net) — Stripe alone owns payout scheduling and currency conversion'),
    outstandingInvoices: UNAVAILABLE('No invoice entity is ever persisted — invoice.paid/payment_failed are handled as pure webhook trigger events, the invoice amount/status is never stored'),
    unexpiredCreditLiability: { units: unexpiredCreditUnits },
    providerCostByTierFeature: UNAVAILABLE('billing_provider_usage exists in the schema but nothing writes to it yet — real cost tracking is a separate, not-yet-built task'),
  }
}
