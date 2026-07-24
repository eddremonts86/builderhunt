import { and, eq, sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { seatUsageDaily } from '../db/schema'

/**
 * Tenant-private (`organization_id`) — `builderhunt_app` has SELECT + INSERT +
 * UPDATE (see `drizzle/0044_abuse_usage_integrity_rls_grants.sql`), a
 * synchronous own-org counter increment on every metered action. Uses the
 * existing `TenantTransaction`/`withTenantContext` infrastructure, same as
 * every other tenant-private repository.
 */

export interface SeatUsageRecord {
  id: string
  organizationId: string
  userId: string
  day: string
  action: string
  count: number
  creditUnits: number
}

export async function getSeatUsage(
  transaction: TenantTransaction,
  organizationId: string,
  userId: string,
  day: string,
  action: string,
): Promise<SeatUsageRecord | null> {
  const [row] = await transaction.select().from(seatUsageDaily)
    .where(and(
      eq(seatUsageDaily.organizationId, organizationId),
      eq(seatUsageDaily.userId, userId),
      eq(seatUsageDaily.day, day),
      eq(seatUsageDaily.action, action),
    ))
    .limit(1)
  return row ?? null
}

export interface IncrementSeatUsageInput {
  id: string
  organizationId: string
  userId: string
  day: string
  action: string
  count?: number
  creditUnits?: number
}

/** Upserts the (organization, user, day, action) counter, adding to any existing count. */
export async function incrementSeatUsage(
  transaction: TenantTransaction,
  input: IncrementSeatUsageInput,
): Promise<SeatUsageRecord> {
  const count = input.count ?? 1
  const creditUnits = input.creditUnits ?? 0
  const [row] = await transaction.insert(seatUsageDaily).values({
    id: input.id,
    organizationId: input.organizationId,
    userId: input.userId,
    day: input.day,
    action: input.action,
    count,
    creditUnits,
  }).onConflictDoUpdate({
    target: [seatUsageDaily.organizationId, seatUsageDaily.userId, seatUsageDaily.day, seatUsageDaily.action],
    set: {
      count: sql`${seatUsageDaily.count} + ${count}`,
      creditUnits: sql`${seatUsageDaily.creditUnits} + ${creditUnits}`,
    },
  }).returning()
  return row
}
