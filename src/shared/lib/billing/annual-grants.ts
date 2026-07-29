/**
 * The remaining 11 monthly credit windows for an annual subscription
 * (plans/phase-1/30-stripe-billing-platform/tasks.md §7 "Issue annual subscription
 * credits monthly"; spec.md: "a daily idempotent worker grants the
 * remaining 11 windows on calendar anniversaries of the billing anchor,
 * clamped to month end. Each grant expires at the next anniversary and is
 * unique by subscription/window/type").
 *
 * The FIRST window is granted by `webhook-handlers.ts`'s `handleInvoicePaid`
 * at the moment the annual invoice is paid — this module covers windows
 * 2-12 only, invoked from `worker.ts`'s daily sweep. Stripe never sends a
 * mid-year event for an annual subscription, so there is nothing for a
 * webhook handler to react to; a worker sweep is the only way to notice
 * "an anniversary has now passed."
 *
 * All date math is UTC-only (`getUTCFullYear`/`Date.UTC`/etc.) — never local
 * time — so behavior is identical regardless of server timezone or DST.
 */
import { randomUUID } from 'node:crypto'
import { CreditLedgerError, grantCredits } from './credits'
import type { WorkerTransaction } from '../db/worker-db'

const TOTAL_WINDOWS = 12

/**
 * The calendar-month anniversary of `anchor`, `monthsAhead` months later,
 * clamped to the target month's last day (e.g. an anchor of Jan 31 lands on
 * Feb 28, or Feb 29 in a leap year — never rolling over into March). Time
 * of day is preserved from the anchor.
 */
export function computeAnniversary(anchor: Date, monthsAhead: number): Date {
  const year = anchor.getUTCFullYear()
  const month = anchor.getUTCMonth() + monthsAhead
  const day = anchor.getUTCDate()
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(
    year,
    month,
    Math.min(day, lastDayOfTargetMonth),
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  ))
}

export interface AnnualGrantWindow {
  /** 2..12 — window 1 is `handleInvoicePaid`'s own grant, not this module's concern. */
  index: number
  windowStart: Date
  windowEnd: Date
}

/**
 * Pure — no I/O. Returns every window (2..12) whose start has already
 * passed as of `now`, in order. A worker that hasn't run in a while
 * "catches up" naturally: multiple windows can be due at once, and each is
 * granted independently (idempotent by its own key), never combined into
 * one bigger grant.
 */
export function deriveDueAnnualGrantWindows(subscriptionStart: Date, periodEnd: Date, now: Date): AnnualGrantWindow[] {
  const windows: AnnualGrantWindow[] = []
  for (let index = 2; index <= TOTAL_WINDOWS; index += 1) {
    const windowStart = computeAnniversary(subscriptionStart, index - 1)
    if (windowStart > now) break
    const windowEnd = index === TOTAL_WINDOWS ? periodEnd : computeAnniversary(subscriptionStart, index)
    windows.push({ index, windowStart, windowEnd })
  }
  return windows
}

export interface AnnualSubscriptionSnapshot {
  stripeSubscriptionId: string
  monthlyCredits: number
  currentPeriodStart: Date
  currentPeriodEnd: Date
}

/**
 * Issues every due-but-not-yet-granted window for one annual subscription.
 * Idempotent per window (`monthly_window_already_granted` from a prior run
 * is swallowed, never re-thrown) — safe to call from a worker that runs
 * more than once a day, or that missed a run and is catching up on several
 * windows at once. Returns how many NEW grants this call actually issued.
 */
export async function issueAnnualSubscriptionGrants(
  tx: WorkerTransaction,
  organizationId: string,
  subscription: AnnualSubscriptionSnapshot,
  now: Date,
): Promise<number> {
  const windows = deriveDueAnnualGrantWindows(subscription.currentPeriodStart, subscription.currentPeriodEnd, now)
  let issued = 0
  for (const window of windows) {
    try {
      const result = await grantCredits(tx, {
        grantId: randomUUID(),
        ledgerEntryId: randomUUID(),
        organizationId,
        source: 'subscription_annual_window',
        sourceReference: subscription.stripeSubscriptionId,
        monthlyWindowKey: `${subscription.stripeSubscriptionId}:window-${window.index}`,
        units: subscription.monthlyCredits,
        expiresAt: window.windowEnd,
        idempotencyKey: `annual-grant:${subscription.stripeSubscriptionId}:${window.index}`,
      })
      // `grantCredits` itself is idempotent by `idempotencyKey` and returns `replayed: true`
      // without inserting anything when this exact window was already granted by an earlier
      // (or concurrent) run — only count a genuinely NEW grant.
      if (!result.replayed) issued += 1
    } catch (error) {
      if (error instanceof CreditLedgerError && error.code === 'monthly_window_already_granted') continue
      throw error
    }
  }
  return issued
}
