import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

/**
 * A transaction that carries tenant context, the way every real request does.
 *
 * `withTenantContext` sets `app.organization_id` on the transaction before any query runs, and every
 * RLS policy on a tenant-private table reads it. A test that calls a service through a bare
 * `db.transaction(...)` therefore exercises a state production never has: no context at all. It
 * passed only because the disposable database's connection role is the owner, which ignores RLS.
 *
 * That mattered the moment credit writes started elevating to `builderhunt_worker`
 * (`src/shared/lib/billing/credit-write-role.ts`): under a role that RLS applies to, an INSERT with
 * no context fails `WITH CHECK`, and 93 tests across 6 files failed at once. They were not broken by
 * the elevation — they had never been running the policy.
 *
 * `slot-service.test.ts` and `booking-service.test.ts` already did this inline; this is the same
 * thing, named, so the next service test does not have to rediscover it.
 */
export function tenantTransaction<T>(
  db: PostgresJsDatabase,
  organizationId: string,
  work: (transaction: Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0]) => Promise<T> | T,
): Promise<T> {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`)
    return work(transaction)
  })
}
