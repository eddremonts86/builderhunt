import { desc, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { workerDb } from '../db/worker-db'
import { abuseSignals } from '../db/schema'

/**
 * System-operational, no RLS — `abuse_signals` has no owning subject (see
 * `drizzle/0044_abuse_usage_integrity_rls_grants.sql`), so writes/reads go
 * through the worker role directly with no tenant/user context to set,
 * unlike `user-devices.ts`/`account-risk.ts`. `db` defaults to the real
 * `workerDb` singleton; tests inject a disposable database, same convention
 * as `repositories/billing-worker.ts`.
 */

export interface AbuseSignalRecord {
  id: string
  type: string
  severity: string
  details: Record<string, unknown> | null
  userId: string | null
  organizationId: string | null
  requestId: string | null
  createdAt: Date
}

export interface InsertAbuseSignalInput {
  id: string
  type: string
  severity: string
  userId?: string | null
  organizationId?: string | null
  requestId?: string | null
  details?: Record<string, unknown>
}

export async function insertAbuseSignal(
  input: InsertAbuseSignalInput,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
): Promise<AbuseSignalRecord> {
  const [row] = await db.insert(abuseSignals).values({
    id: input.id,
    type: input.type,
    severity: input.severity,
    userId: input.userId ?? null,
    organizationId: input.organizationId ?? null,
    requestId: input.requestId ?? null,
    details: input.details ?? {},
  }).returning()
  return row
}

/** Most-recent-first, bounded — used by dashboards/tests, never an unbounded scan. */
export async function listAbuseSignalsForUser(
  userId: string,
  limit = 50,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
): Promise<AbuseSignalRecord[]> {
  return db.select().from(abuseSignals)
    .where(eq(abuseSignals.userId, userId))
    .orderBy(desc(abuseSignals.createdAt))
    .limit(limit)
}

/** Most-recent-first, bounded — used by dashboards/tests, never an unbounded scan. */
export async function listAbuseSignalsForOrganization(
  organizationId: string,
  limit = 50,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
): Promise<AbuseSignalRecord[]> {
  return db.select().from(abuseSignals)
    .where(eq(abuseSignals.organizationId, organizationId))
    .orderBy(desc(abuseSignals.createdAt))
    .limit(limit)
}
