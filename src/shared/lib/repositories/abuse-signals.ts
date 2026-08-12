import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
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

/**
 * Counts abuse signals per severity inside a window, in one grouped query (plan 57, Admin track).
 *
 * ## Why not `listRecentAbuseSignals(limit)` and a length
 *
 * That function is capped, which is correct for a table and wrong for a count: past the cap the number stops
 * growing, so a dashboard reports "100 signals" whether there are a hundred or a hundred thousand — and reports
 * it without any indication that it is a ceiling. Grouping by severity returns one row per distinct severity, so
 * the result size is decided by the vocabulary rather than by how much abuse happened.
 *
 * ## What deliberately does not come back
 *
 * No `userId`, no `organizationId`, no `requestId`, no `details`. A distribution is the whole answer an operator
 * needs from a summary — "is this an incident or a Tuesday" — and every one of those columns is the identity or
 * the evidence that the plan's own rule keeps off an operator page. The detail rows live behind
 * `/admin/abuse`, which is authorized per row.
 */
export async function countAbuseSignalsBySeverity(
  since: Date,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
): Promise<Map<string, number>> {
  // unbounded-read-ok: grouped by severity inside a window, so the row count is the severity vocabulary and not
  // the signal volume. A LIMIT would drop a severity rather than bound anything.
  const rows = await db
    .select({ severity: abuseSignals.severity, total: sql<number>`count(*)::int` })
    .from(abuseSignals)
    .where(gte(abuseSignals.createdAt, since))
    .groupBy(abuseSignals.severity)

  const counts = new Map<string, number>()
  for (const row of rows) {
    // Severity is free text in the column, so it is validated rather than trusted: an arbitrary value reaching a
    // metric key would put unbounded label cardinality on the page, which is the same failure the route-family
    // allowlist exists to prevent.
    if (/^[a-z_]{1,32}$/.test(row.severity)) counts.set(row.severity, Number(row.total ?? 0))
  }
  return counts
}

/**
 * The account and entitlement anomaly types that a detector actually writes.
 *
 * ## Why the list is here and not derived from the CHECK constraint
 *
 * `abuse_signals_type_check` allows fourteen values (0043, widened by 0046), and three of them —
 * `signup_velocity`, `linked_account`, `reserve_leak` — are written by **nothing**: they were reserved in the
 * vocabulary and no detector was ever built. Grouping over the constraint's full set would render three permanent
 * zeros, and "0 signup velocity anomalies" reads as a clean signal rather than as an absent detector. That is the
 * substitution this plan exists to remove, arriving through a `GROUP BY`.
 *
 * The remaining seven allowed types are abuse of a different kind — credit farming, pool drain, refund farming,
 * margin drift, credit spend velocity, export burst, cross-tenant denial. They belong to billing integrity and
 * data exfiltration, not to "is something wrong with this account", so they stay in the severity distribution
 * where they already are.
 *
 * Each of these four is emitted by a real code path: `checkImpossibleTravelAndEmit` and
 * `checkMidSessionUaChangeAndEmit` from `tenant-principal.ts` on authenticated requests, and the concurrent-session
 * and seat-overuse detectors from the same module. A zero here therefore means "no detections", which is the
 * honest reading and the one an operator wants.
 */
export const ACCOUNT_ANOMALY_TYPES = [
  'impossible_travel',
  'ua_change',
  'concurrent_sessions',
  'seat_overuse',
] as const
export type AccountAnomalyType = (typeof ACCOUNT_ANOMALY_TYPES)[number]

/**
 * Counts account and entitlement anomalies per type inside a window, in one grouped query.
 *
 * Every requested type appears in the result, including the ones with no rows — a distribution missing its zeros
 * is a distribution whose shape changes between reads, and an operator comparing two windows would see a type
 * disappear rather than see it fall to nothing. The `IN` list is a closed vocabulary from code, so the row count
 * is bounded by four regardless of how many signals were written.
 *
 * Returns nothing about *who*: no `userId`, no `organizationId`, no `details`. Same rule as the severity
 * distribution beside it — the detail rows are behind `/admin/abuse`, authorized per row.
 */
export async function countAbuseSignalsByType(
  since: Date,
  types: readonly string[] = ACCOUNT_ANOMALY_TYPES,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
): Promise<Map<string, number>> {
  // Defensive rather than decorative: these become metric keys, and an unvalidated value reaching one puts
  // unbounded label cardinality on an operator page. The callers pass literals; a future one might not.
  const requested = types.filter((type) => /^[a-z_]{1,32}$/.test(type))
  // Every type starts at zero so the shape is stable across windows.
  const counts = new Map<string, number>(requested.map((type) => [type, 0]))
  if (requested.length === 0) return counts

  // unbounded-read-ok: grouped by type and filtered to a closed four-value vocabulary, so the row count is the
  // vocabulary and not the signal volume. A LIMIT would drop a type rather than bound anything.
  const rows = await db
    .select({ type: abuseSignals.type, total: sql<number>`count(*)::int` })
    .from(abuseSignals)
    .where(and(gte(abuseSignals.createdAt, since), inArray(abuseSignals.type, [...requested])))
    .groupBy(abuseSignals.type)

  for (const row of rows) {
    if (counts.has(row.type)) counts.set(row.type, Number(row.total ?? 0))
  }
  return counts
}
