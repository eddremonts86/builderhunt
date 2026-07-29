/**
 * Renewal-safe catalog price migration (plans/phase-1/30-stripe-billing-platform/tasks.md §7 "Implement
 * cancellation and renewal-safe price migration"; spec.md §Catalog: "Existing subscribers retain
 * their contracted price until the next eligible renewal. Increases receive at least 30 days'
 * notice; annual prices remain unchanged through the paid year.").
 *
 * **Scope note**: this catalog (`catalog.ts`) has never actually had a second version of any entry
 * — every key is still `version: 1` at its original launch price, and catalog.ts's own module
 * comment explicitly forbids retroactively rewriting an entry's history ("never mutate a released
 * entry in place"). A real price change would need catalog.ts to gain a genuine multi-version
 * STORAGE mechanism (how an old Price ID/amount is retained once superseded) — an unresolved
 * architecture question this task's file list doesn't include a schema/migration for, and one with
 * no real decision to build against yet. What this module fully implements and tests is the TIMING
 * invariant itself, generic over whatever the eventual version-history source turns out to be:
 * given a subscriber's contracted version/price and the currently active version/price/notice-start
 * for the same catalog key, decide whether — and exactly when — a migration is due. Wiring a
 * periodic sweep that calls `applyDuePriceMigration` across every subscription (the worker-side
 * counterpart to `annual-grants.ts`'s sweep) is deferred to whenever a real price change is
 * actually decided, since there is nothing for such a sweep to migrate anyone to today.
 */
import { and, eq } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { billingSubscriptions } from '../db/schema'
import { applyImmediateSubscriptionChange } from '../repositories/billing'
import type { BillingProvider } from './provider'

const PRICE_INCREASE_NOTICE_MS = 30 * 24 * 60 * 60 * 1000

export interface PriceMigrationCandidate {
  contractedVersion: number
  contractedAmountCents: number
  currentVersion: number
  currentAmountCents: number
  /** When the new price became the catalog's current version — the 30-day increase-notice clock starts here, never earlier. */
  priceEffectiveAt: Date
  /** The subscriber's own current paid-through date — a migration never takes effect before this, preserving the annual (or monthly) term already paid for. */
  currentPeriodEnd: Date
}

export type PriceMigrationReason = 'up_to_date' | 'notice_period_not_elapsed' | 'before_renewal' | 'due_at_renewal'

export interface PriceMigrationDecision {
  migrate: boolean
  reason: PriceMigrationReason
  newVersion?: number
  newAmountCents?: number
}

/**
 * Pure — no I/O, no charge, no schedule side effect. Never returns `migrate: true` before BOTH
 * conditions hold: (1) a price increase has cleared its 30-day notice (a decrease has no notice
 * requirement — spec.md only calls out increases), AND (2) the subscriber's own current period has
 * actually ended (this is what "annual prices remain unchanged through the paid year" reduces to
 * generically: never migrate before the term already paid for is over, monthly or annual alike).
 * This is also exactly what makes migrating "no retroactive charge": the new price only ever takes
 * effect at a point where nothing has been charged yet for that upcoming period.
 */
export function resolvePriceMigration(candidate: PriceMigrationCandidate, now: Date): PriceMigrationDecision {
  if (candidate.contractedVersion === candidate.currentVersion) {
    return { migrate: false, reason: 'up_to_date' }
  }

  const isIncrease = candidate.currentAmountCents > candidate.contractedAmountCents
  if (isIncrease) {
    const noticeEndsAt = new Date(candidate.priceEffectiveAt.getTime() + PRICE_INCREASE_NOTICE_MS)
    if (now < noticeEndsAt) {
      return { migrate: false, reason: 'notice_period_not_elapsed' }
    }
  }

  if (now < candidate.currentPeriodEnd) {
    return { migrate: false, reason: 'before_renewal' }
  }

  return { migrate: true, reason: 'due_at_renewal', newVersion: candidate.currentVersion, newAmountCents: candidate.currentAmountCents }
}

export interface PriceMigrationTarget {
  catalogKey: string
  tier: 'pro' | 'pro_max' | 'team'
  interval: 'monthly' | 'annual'
  version: number
  priceId: string
}

/**
 * Applies a due migration: swaps the provider-side Price (idempotent by a key derived from the
 * TARGET version, so a duplicate call for the same subscription/version is a pure no-op on Stripe's
 * side) and updates our own subscription row to match. Returns `false` without doing anything if
 * `decision.migrate` is false, OR if the subscription has ALREADY moved to this version since the
 * decision was computed — re-read fresh from the database here rather than trusting a caller-
 * supplied snapshot, so a retried worker tick or two overlapping runs (the exact "duplicate
 * scheduler is a no-op" case) never re-call the provider at all, not merely rely on the provider's
 * own idempotency to absorb a second call silently.
 */
export async function applyDuePriceMigration(
  transaction: TenantTransaction,
  organizationId: string,
  subscription: { stripeSubscriptionId: string },
  decision: PriceMigrationDecision,
  target: PriceMigrationTarget,
  provider: BillingProvider,
): Promise<boolean> {
  if (!decision.migrate) return false

  const [current] = await transaction
    .select({ catalogVersion: billingSubscriptions.catalogVersion })
    .from(billingSubscriptions)
    .where(and(eq(billingSubscriptions.organizationId, organizationId), eq(billingSubscriptions.stripeSubscriptionId, subscription.stripeSubscriptionId)))
    .limit(1)
  if (!current || current.catalogVersion === target.version) return false // already migrated by an earlier run

  await provider.changeSubscription({
    subscriptionId: subscription.stripeSubscriptionId,
    newPriceId: target.priceId,
    idempotencyKey: `price-migration:${subscription.stripeSubscriptionId}:${target.version}`,
  })

  await applyImmediateSubscriptionChange(transaction, organizationId, subscription.stripeSubscriptionId, {
    catalogKey: target.catalogKey,
    tier: target.tier,
    interval: target.interval,
    catalogVersion: target.version,
    providerSyncedAt: new Date(),
  })

  return true
}
