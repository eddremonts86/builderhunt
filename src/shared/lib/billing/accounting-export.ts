/**
 * Monthly accounting and margin export (plans/stripe-billing-platform/tasks.md §10 "Create
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
import { and, eq, gte, lt } from 'drizzle-orm'
import { resolvePackCatalogEntryByKey, resolveSubscriptionCatalogEntryByKey } from './catalog'
import { billingCreditGrants, billingDisputes, billingSubscriptions } from '../db/schema'
import { listActiveBillingCreditGrants, listBillingRefunds } from '../repositories/billing'
import { listWorkerOrganizationIds, withWorkerOrganization } from '../repositories/billing-worker'

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

export async function getAccountingExport(deps: AccountingExportDeps = {}): Promise<AccountingExportResult> {
  const now = (deps.now ?? (() => new Date()))()
  const defaults = previousMonthWindow(now)
  const windowStart = deps.windowStart ?? defaults.windowStart
  const windowEnd = deps.windowEnd ?? defaults.windowEnd

  const organizationRows = await listWorkerOrganizationIds(deps.worker)

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
      const [periodStarts, packGrants, refunds, disputes, activeGrants] = await Promise.all([
        transaction
          .select({ catalogKey: billingSubscriptions.catalogKey })
          .from(billingSubscriptions)
          .where(and(
            eq(billingSubscriptions.organizationId, organizationId),
            gte(billingSubscriptions.currentPeriodStart, windowStart),
            lt(billingSubscriptions.currentPeriodStart, windowEnd),
          )),
        transaction
          .select({ sourceReference: billingCreditGrants.sourceReference })
          .from(billingCreditGrants)
          .where(and(
            eq(billingCreditGrants.organizationId, organizationId),
            eq(billingCreditGrants.source, 'pack'),
            gte(billingCreditGrants.createdAt, windowStart),
            lt(billingCreditGrants.createdAt, windowEnd),
          )),
        listBillingRefunds(transaction, organizationId),
        transaction
          .select({ amountCents: billingDisputes.amountCents, createdAt: billingDisputes.createdAt })
          .from(billingDisputes)
          .where(eq(billingDisputes.organizationId, organizationId)),
        listActiveBillingCreditGrants(transaction, organizationId),
      ])

      for (const row of periodStarts) {
        const entry = resolveSubscriptionCatalogEntryByKey(row.catalogKey)
        if (entry) {
          subscriptionCents += entry.amountCents
          subscriptionCount += 1
        }
      }

      for (const row of packGrants) {
        const entry = row.sourceReference ? resolvePackCatalogEntryByKey(row.sourceReference) : null
        if (entry) {
          packCents += entry.amountCents
          packCount += 1
        }
      }

      for (const refund of refunds) {
        if (refund.state !== 'succeeded') continue
        if (refund.createdAt < windowStart || refund.createdAt >= windowEnd) continue
        refundAmountCents += refund.amountCents
        refundCount += 1
      }

      for (const dispute of disputes) {
        if (dispute.createdAt < windowStart || dispute.createdAt >= windowEnd) continue
        disputeAmountCents += dispute.amountCents
        disputeCount += 1
      }

      for (const grant of activeGrants) {
        if (grant.expiresAt > now) unexpiredCreditUnits += grant.remainingUnits
      }
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
