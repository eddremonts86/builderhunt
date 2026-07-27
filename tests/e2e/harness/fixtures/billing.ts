/**
 * Wave 1 Task 2 — entitlement/billing state fixtures.
 *
 * Entitlements are granted by billing infrastructure in production (Stripe
 * webhooks / platform-admin plan changes) — there is no self-serve product
 * flow a fixture could drive, so seeding writes `organization_entitlements`
 * directly. Every timestamp derives from the fixed E2E clock so trialing /
 * past-due states are identical on every run.
 */
import type { Sql } from 'postgres'
import type { FixedClock } from '../clock'
import {
  assertSeatLimit,
  type BillingPeriod,
  type EntitlementStatus,
  type EntitlementTier,
} from '../roles'

export interface EntitlementSeed {
  organizationId: string
  tier: EntitlementTier
  status: EntitlementStatus
  seatLimit: number
  billingPeriod: BillingPeriod
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  trialEndsAt: Date | null
}

export interface EntitlementRow {
  tier: string
  status: string
  seatLimit: number
  billingPeriod: string
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  trialEndsAt: Date | null
}

/** A live paid (or free) subscription. Paid tiers get a monthly period anchored at the fixed clock. */
export function activeEntitlement(
  organizationId: string,
  tier: EntitlementTier,
  seatLimit: number,
  clock: FixedClock,
): EntitlementSeed {
  assertSeatLimit(seatLimit)
  const paid = tier !== 'free'
  return {
    organizationId,
    tier,
    status: 'active',
    seatLimit,
    billingPeriod: paid ? 'monthly' : 'none',
    currentPeriodStart: paid ? clock.now() : null,
    currentPeriodEnd: paid ? clock.plus({ days: 30 }) : null,
    trialEndsAt: null,
  }
}

/** A 14-day trial that is still running at the fixed instant. */
export function trialingEntitlement(
  organizationId: string,
  tier: EntitlementTier,
  seatLimit: number,
  clock: FixedClock,
): EntitlementSeed {
  assertSeatLimit(seatLimit)
  return {
    organizationId,
    tier,
    status: 'trialing',
    seatLimit,
    billingPeriod: 'none',
    currentPeriodStart: null,
    currentPeriodEnd: null,
    trialEndsAt: clock.plus({ days: 14 }),
  }
}

/** A paid subscription whose last period ended yesterday and did not renew. */
export function pastDueEntitlement(
  organizationId: string,
  tier: EntitlementTier,
  seatLimit: number,
  clock: FixedClock,
): EntitlementSeed {
  assertSeatLimit(seatLimit)
  return {
    organizationId,
    tier,
    status: 'past_due',
    seatLimit,
    billingPeriod: 'monthly',
    currentPeriodStart: clock.minus({ days: 31 }),
    currentPeriodEnd: clock.minus({ days: 1 }),
    trialEndsAt: null,
  }
}

/** Idempotent upsert — an organization always has exactly one entitlement row. */
export async function seedEntitlement(sql: Sql, seed: EntitlementSeed): Promise<void> {
  assertSeatLimit(seed.seatLimit)
  await sql`
    insert into organization_entitlements
      (organization_id, tier, status, billing_period, current_period_start, current_period_end, trial_ends_at, seat_limit)
    values
      (${seed.organizationId}, ${seed.tier}, ${seed.status}, ${seed.billingPeriod},
       ${seed.currentPeriodStart}, ${seed.currentPeriodEnd}, ${seed.trialEndsAt}, ${seed.seatLimit})
    on conflict (organization_id) do update set
      tier = excluded.tier,
      status = excluded.status,
      billing_period = excluded.billing_period,
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      trial_ends_at = excluded.trial_ends_at,
      seat_limit = excluded.seat_limit,
      updated_at = now()
  `
}

export async function readEntitlementRow(sql: Sql, organizationId: string): Promise<EntitlementRow | null> {
  const rows = await sql<
    {
      tier: string
      status: string
      seat_limit: number
      billing_period: string
      current_period_start: Date | null
      current_period_end: Date | null
      trial_ends_at: Date | null
    }[]
  >`
    select tier, status, seat_limit, billing_period, current_period_start, current_period_end, trial_ends_at
    from organization_entitlements
    where organization_id = ${organizationId}
  `
  const row = rows[0]
  if (!row) return null
  return {
    tier: row.tier,
    status: row.status,
    seatLimit: row.seat_limit,
    billingPeriod: row.billing_period,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    trialEndsAt: row.trial_ends_at,
  }
}
