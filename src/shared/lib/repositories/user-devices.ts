import { and, desc, eq, gte } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { TenantTransaction } from '../db/client'
import { userDevices } from '../db/schema'
import { workerDb } from '../db/worker-db'
import { USER_SCOPED_LIMIT } from '../db/read-bounds'

/**
 * Account-subject (`user_id`) — `builderhunt_app` has SELECT + INSERT + UPDATE
 * (see `drizzle/0044_abuse_usage_integrity_rls_grants.sql`), a synchronous
 * request-path write (first-party device-cookie upsert on session create),
 * the same "owner-initiated request" category as `billing_checkout_attempts`.
 * `TenantTransaction` already carries `app.user_id` alongside
 * `app.organization_id` on every call (`db/tenant-context.ts`), so this needs
 * no new context-setting plumbing.
 */

export interface UserDeviceRecord {
  id: string
  userId: string
  deviceHash: string
  uaFamily: string | null
  firstSeenAt: Date
  lastSeenAt: Date
  lastIpAsn: string | null
  lastCountry: string | null
  trustState: string
}

export async function findUserDevice(
  transaction: TenantTransaction,
  userId: string,
  deviceHash: string,
): Promise<UserDeviceRecord | null> {
  const [row] = await transaction.select().from(userDevices)
    .where(and(eq(userDevices.userId, userId), eq(userDevices.deviceHash, deviceHash)))
    .limit(1)
  return row ?? null
}

/** Used by `/settings/security`'s active-sessions view — a user's own device count is small. */
export async function listUserDevicesForUser(
  transaction: TenantTransaction,
  userId: string,
): Promise<UserDeviceRecord[]> {
  // One row per device this person has signed in from — `USER_SCOPED_LIMIT` grows by deliberate
  // human action, and an account past it is the abuse system's problem, not the pager's.
  return transaction.select().from(userDevices).where(eq(userDevices.userId, userId))
    .orderBy(desc(userDevices.lastSeenAt))
    .limit(USER_SCOPED_LIMIT)
}

/**
 * Cross-user, worker-only (`drizzle/0045_user_devices_worker_read_grant.sql` — SELECT-only,
 * unscoped by `app.user_id`, since a clustering read has no single subject to scope by). Used by
 * `abuse/linked-accounts.ts`'s clustering read model; never exposed to `builderhunt_app`. Bounded
 * by `sinceDate` and `limit` — never an unbounded full-table scan.
 */
export async function listRecentDeviceHashesAcrossUsers(
  sinceDate: Date,
  limit = 5000,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
): Promise<UserDeviceRecord[]> {
  return db.select().from(userDevices).where(gte(userDevices.lastSeenAt, sinceDate)).limit(limit)
}

export interface UpsertUserDeviceInput {
  id: string
  userId: string
  deviceHash: string
  uaFamily?: string | null
  lastIpAsn?: string | null
  lastCountry?: string | null
}

/** Returns the row plus whether this device was already known before this call. */
export async function upsertUserDevice(
  transaction: TenantTransaction,
  input: UpsertUserDeviceInput,
): Promise<{ device: UserDeviceRecord; isNewDevice: boolean }> {
  const existing = await findUserDevice(transaction, input.userId, input.deviceHash)
  const [device] = await transaction.insert(userDevices).values({
    id: input.id,
    userId: input.userId,
    deviceHash: input.deviceHash,
    uaFamily: input.uaFamily ?? null,
    lastIpAsn: input.lastIpAsn ?? null,
    lastCountry: input.lastCountry ?? null,
  }).onConflictDoUpdate({
    target: [userDevices.userId, userDevices.deviceHash],
    set: {
      lastSeenAt: new Date(),
      uaFamily: input.uaFamily ?? null,
      lastIpAsn: input.lastIpAsn ?? null,
      lastCountry: input.lastCountry ?? null,
    },
  }).returning()
  return { device, isNewDevice: !existing }
}
