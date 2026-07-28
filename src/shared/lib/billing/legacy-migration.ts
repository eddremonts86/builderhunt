/**
 * Migrates manual (non-Stripe) organization entitlements into the new billing schema without
 * charging anyone (plans/phase-1/29-stripe-billing-platform/tasks.md §10 "Migrate manual entitlements without
 * charging"; spec.md §Migration: "Manual organization entitlements remain valid until their current
 * end... Import current manual periods, operator trials, and promotional credits as audited
 * `legacy_manual` records... Voluntary Checkout activation atomically ends overlapping manual
 * authority without duplicating access or credits.").
 *
 * CRITICAL SCOPE DECISION, confirmed by reading `feature-authorization.ts`'s `checkEntitlement`:
 * the NEW credit-gated features (AI sourcing sprints, semantic search, etc.) require a REAL, active
 * `billing_subscriptions` row (`findActiveBillingSubscription` + `isActivePaidSubscription`) —
 * `organization_entitlements.tier` and credit balance are never consulted for that gate. A manually
 * granted organization has no `billing_subscriptions` row and never will until it completes real
 * Stripe Checkout. This means importing a manual entitlement as a `legacy_manual` credit grant
 * changes NO access whatsoever — a legacy org's feature access continues exactly as it does today,
 * gated by whatever legacy code path already reads `organization_entitlements.tier`/`billing-shared.ts`'s
 * `PLAN_LIMITS`. The `legacy_manual` grant this module creates is pure audit bookkeeping: a
 * structured, queryable record of "this organization has this much manually-granted allowance,
 * expiring on this date" in the SAME schema real Stripe grants live in (so accounting/reporting —
 * `accounting-export.ts`'s unexpired-credit liability, `operations-metrics.ts` — has visibility into
 * legacy organizations too), replacing what was previously only a free-text `organization_entitlements.notes`
 * value with no structure. Creates no Stripe Customer, subscription, or charge — ever.
 */
import { randomUUID, createHash } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import type { WorkerTransaction } from '../db/worker-db'
import { billingCreditGrants, billingSubscriptions, organizationEntitlements } from '../db/schema'
import { resolveSubscriptionCatalogEntryByKey } from './catalog'
import { CreditLedgerError, expireCreditGrant, grantCredits } from './credits'
import { findCreditGrantByMonthlyWindowKey } from '../repositories/billing-ledger'

export type LegacyMigratableTier = 'pro' | 'team'

const LEGACY_TIER_CATALOG_KEY: Record<LegacyMigratableTier, 'pro_monthly' | 'team_monthly'> = {
  pro: 'pro_monthly',
  team: 'team_monthly',
}

/** `null` for anything that isn't a legacy-manual-grantable tier — `free` (nothing to migrate) or an unexpected value like `pro_max` (never manually grantable; a real Stripe subscription is the only way to reach it, so a `pro_max` entitlement with no `billing_subscriptions` row is a genuine data anomaly worth flagging as a conflict, not silently resolving). */
export function resolveLegacyMonthlyCredits(tier: string): number | null {
  if (tier !== 'pro' && tier !== 'team') return null
  const entry = resolveSubscriptionCatalogEntryByKey(LEGACY_TIER_CATALOG_KEY[tier])
  return entry?.monthlyCredits ?? null
}

/** A legacy entitlement with neither `currentPeriodEnd` nor `trialEndsAt` set is a genuinely valid state in the old manual system (an operator-granted plan with no defined end) — spec.md's "remain valid until their current end" doesn't distinguish that from a time-boxed grant. `billing_credit_grants.expiresAt` is NOT NULL, so something must be written; ten years out is a deliberately generous, documented stand-in for "no defined end," not a guess at a real date. */
const NO_DEFINED_END_FALLBACK_YEARS = 10

export function resolveLegacyGrantExpiry(entitlement: { currentPeriodEnd: Date | null; trialEndsAt: Date | null }, now: Date): Date {
  if (entitlement.currentPeriodEnd) return entitlement.currentPeriodEnd
  if (entitlement.trialEndsAt) return entitlement.trialEndsAt
  const fallback = new Date(now)
  fallback.setFullYear(fallback.getFullYear() + NO_DEFINED_END_FALLBACK_YEARS)
  return fallback
}

export interface LegacyEntitlementInput {
  organizationId: string
  tier: string
  currentPeriodEnd: Date | null
  trialEndsAt: Date | null
}

export type LegacyMigrationOutcome =
  | { outcome: 'migrated'; grantId: string; units: number; expiresAt: Date }
  | { outcome: 'would_migrate'; units: number; expiresAt: Date }
  | { outcome: 'skipped_free_tier' }
  | { outcome: 'skipped_already_has_subscription' }
  | { outcome: 'skipped_already_migrated' }
  | { outcome: 'conflict_unresolvable_tier' }

/**
 * Imports ONE organization's current manual entitlement as an audited `legacy_manual` credit grant.
 * Idempotent and safe to rerun: an organization that already has a real Stripe subscription is
 * skipped (its manual authority has already been superseded — see `endOverlappingManualAuthority`),
 * and a rerun for an already-migrated organization recognizes its own one-time `monthlyWindowKey`
 * and reports `skipped_already_migrated` rather than granting a second time.
 *
 * `dryRun: true` runs every READ-side check (subscription lookup, tier resolution, existing-grant
 * lookup) and reports exactly what WOULD happen (`would_migrate` instead of `migrated`) without ever
 * calling `grantCredits` — the backfill script's `--dry-run` flag depends on this being a genuine
 * no-write path, not a simulated-then-rolled-back one, so a dry run against a real database is
 * provably side-effect-free.
 */
export async function importLegacyEntitlementAsCredits(
  transaction: WorkerTransaction,
  input: LegacyEntitlementInput,
  now: Date = new Date(),
  dryRun = false,
): Promise<LegacyMigrationOutcome> {
  if (input.tier === 'free') return { outcome: 'skipped_free_tier' }

  const [existingSubscription] = await transaction
    .select({ id: billingSubscriptions.id })
    .from(billingSubscriptions)
    .where(and(eq(billingSubscriptions.organizationId, input.organizationId), isNull(billingSubscriptions.canceledAt)))
    .limit(1)
  if (existingSubscription) return { outcome: 'skipped_already_has_subscription' }

  const units = resolveLegacyMonthlyCredits(input.tier)
  if (units === null) return { outcome: 'conflict_unresolvable_tier' }

  const expiresAt = resolveLegacyGrantExpiry(input, now)
  const monthlyWindowKey = `legacy:${input.organizationId}`

  if (dryRun) {
    const existingGrant = await findCreditGrantByMonthlyWindowKey(transaction, input.organizationId, monthlyWindowKey)
    return existingGrant ? { outcome: 'skipped_already_migrated' } : { outcome: 'would_migrate', units, expiresAt }
  }

  try {
    const result = await grantCredits(transaction, {
      grantId: randomUUID(),
      ledgerEntryId: randomUUID(),
      organizationId: input.organizationId,
      source: 'legacy_manual',
      monthlyWindowKey,
      units,
      expiresAt,
      idempotencyKey: `legacy-migration:${input.organizationId}`,
    })
    if (result.replayed) return { outcome: 'skipped_already_migrated' }
    return { outcome: 'migrated', grantId: result.grant.id, units, expiresAt }
  } catch (err) {
    if (err instanceof CreditLedgerError && err.code === 'monthly_window_already_granted') {
      return { outcome: 'skipped_already_migrated' }
    }
    throw err
  }
}

/**
 * Ends manual authority the moment a real Stripe subscription is created for an organization — call
 * from the SAME transaction as `webhook-handlers.ts`'s `handleSubscriptionUpsert` (`!existing`
 * branch), right alongside `projectSubscriptionEntitlement`. That call already atomically overwrites
 * `tier`/`status`/`billingPeriod`/period columns via its single-row upsert on `organization_entitlements`
 * — this function covers exactly what it deliberately leaves untouched:
 * - `trialEndsAt`/`notes`: stale manual-era values that would otherwise survive on a real subscriber
 *   forever, since `projectSubscriptionEntitlement` never sets them.
 * - Any still-`active` `legacy_manual` credit grant: expired so it can never stack against the new
 *   subscription's own credits ("without duplicating access or credits", spec.md).
 *
 * A no-op for an organization that never had manual authority (no grant to expire, nothing to clear).
 */
export async function endOverlappingManualAuthority(tx: WorkerTransaction, organizationId: string): Promise<void> {
  await tx
    .update(organizationEntitlements)
    .set({ trialEndsAt: null, notes: null, updatedAt: new Date() })
    .where(eq(organizationEntitlements.organizationId, organizationId))

  const [activeLegacyGrant] = await tx
    .select({ id: billingCreditGrants.id })
    .from(billingCreditGrants)
    .where(and(
      eq(billingCreditGrants.organizationId, organizationId),
      eq(billingCreditGrants.source, 'legacy_manual'),
      eq(billingCreditGrants.state, 'active'),
    ))
    .limit(1)
  if (!activeLegacyGrant) return

  await expireCreditGrant(tx, {
    organizationId,
    grantId: activeLegacyGrant.id,
    ledgerEntryId: randomUUID(),
    idempotencyKey: `legacy-cutover-expire:${activeLegacyGrant.id}`,
    reason: 'Superseded by voluntary Stripe Checkout activation',
  })
}

/** Stable, order-independent hash over every migrated record's defining fields — the backfill script writes this to `migration_backfill_runs.checksum` once a run completes, and a rerun (finding the identical already-migrated set via `skipped_already_migrated`) must produce the SAME checksum. */
export function computeLegacyMigrationChecksum(records: Array<{ organizationId: string; tier: string; units: number; expiresAt: Date }>): string {
  const canonical = records
    .map((r) => `${r.organizationId}:${r.tier}:${r.units}:${r.expiresAt.toISOString()}`)
    .sort()
    .join('|')
  return createHash('sha256').update(canonical).digest('hex')
}
