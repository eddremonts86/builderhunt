import { desc, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { workerDb } from '../db/worker-db'
import { abuseSignals } from '../db/schema'
import { abuseSignalsCapability } from '../table/capabilities/abuse-signals'
import { buildKeysetPage } from '../table/keyset'
import type { PageRequest, PageResult, TableQuery } from '../table/types'

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

/**
 * Unscoped, most-recent-first, bounded — the platform-admin abuse console feed
 * (abuse-and-usage-integrity Phase 5 task 3). `abuse_signals` has no owning subject and no RLS at
 * all (see this file's header comment), so an unscoped read is a plain sequential scan bounded by
 * `LIMIT`, same risk profile the per-user/per-org readers above already accept.
 */
export async function listRecentAbuseSignals(
  limit = 100,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
): Promise<AbuseSignalRecord[]> {
  return db.select().from(abuseSignals)
    .orderBy(desc(abuseSignals.createdAt))
    .limit(limit)
}

/**
 * One keyset page of the same feed, for the console.
 *
 * `listRecentAbuseSignals` above stays for callers that want "the last N and nothing more" — it is
 * bounded and correct for that. What it cannot do is page: `LIMIT 100` with no cursor means the
 * console can only ever show the newest hundred signals, and an operator investigating an incident
 * from last week has no way to reach it.
 */
export async function pageAbuseSignals(
  query: TableQuery,
  page: PageRequest,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
): Promise<PageResult<AbuseSignalRecord>> {
  return buildKeysetPage<AbuseSignalRecord>(db, abuseSignalsCapability, query, page, {
    select: {
      id: abuseSignals.id,
      type: abuseSignals.type,
      severity: abuseSignals.severity,
      details: abuseSignals.details,
      userId: abuseSignals.userId,
      organizationId: abuseSignals.organizationId,
      requestId: abuseSignals.requestId,
      createdAt: abuseSignals.createdAt,
    },
    mapRow: (row) => ({
      id: row.id as string,
      type: row.type as string,
      severity: row.severity as string,
      details: (row.details ?? null) as Record<string, unknown> | null,
      userId: (row.userId ?? null) as string | null,
      organizationId: (row.organizationId ?? null) as string | null,
      requestId: (row.requestId ?? null) as string | null,
      createdAt: row.createdAt as Date,
    }),
  })
}
