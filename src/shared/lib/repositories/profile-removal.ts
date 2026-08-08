/**
 * Raw DB access for the profile-removal/global-suppression subsystem (plan: audit-trust).
 * `profile_removal_requests`/`profile_suppressions` are system-operational, no-owning-subject
 * tables (see drizzle/0064's comment) — no tenant context, no RLS, plain `publicDb`/`workerDb`
 * access gated entirely by GRANT, same as `repositories/conversion-events.ts`.
 *
 * Deleting suppressed `builders` rows is the one operation here that DOES cross tenant
 * boundaries — `builders` is per-organization and RLS-scoped, so there is no single query that
 * deletes "every org's copy of this person" in one shot. This duplicates its own
 * `listWorkerOrganizationIds`/`withWorkerOrganization` pair rather than importing another
 * module's — the SAME precedent `repositories/alerts-worker.ts`, `repositories/billing-worker.ts`,
 * and `repositories/sprints-worker.ts` already establish (each keeps its own copy).
 */
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { publicDb } from '../db/client'
import { platformDb } from '../db/platform-db'
import { workerDb, type WorkerTransaction } from '../db/worker-db'
import { builders, organizations, profileRemovalRequests, profileSuppressions } from '../db/schema'
import { WORKER_ORGANIZATION_BATCH } from './worker-organization-scan'
import { collectWorkerOrganizationIds } from './worker-organization-scan'
import { SWEEP_BATCH } from '../db/read-bounds'

export type RemovalRequestStatus = 'pending' | 'verified' | 'rejected' | 'expired'

export interface RemovalRequestRow {
  id: string
  source: string
  sourceId: string
  normalizedProfileUrl: string
  requesterEmailHash: string | null
  challengeHash: string
  status: RemovalRequestStatus
  expiresAt: Date
  verifiedAt: Date | null
  createdAt: Date
}

export interface InsertRemovalRequestInput {
  id: string
  source: string
  sourceId: string
  normalizedProfileUrl: string
  requesterEmailHash: string | null
  challengeHash: string
  expiresAt: Date
}

/** The caller's own most recent still-pending request for this identity — lets a repeat visit to
 * `/privacy/remove` reissue the same in-flight challenge instead of racing multiple at once. */
export async function findPendingRemovalRequest(
  source: string,
  sourceId: string,
  db: PostgresJsDatabase = publicDb,
): Promise<RemovalRequestRow | null> {
  const [row] = await db.select().from(profileRemovalRequests)
    .where(and(
      eq(profileRemovalRequests.source, source),
      eq(profileRemovalRequests.sourceId, sourceId),
      eq(profileRemovalRequests.status, 'pending'),
    ))
    .orderBy(desc(profileRemovalRequests.createdAt))
    .limit(1)
  return (row as RemovalRequestRow | undefined) ?? null
}

export async function insertRemovalRequest(
  input: InsertRemovalRequestInput,
  db: PostgresJsDatabase = publicDb,
): Promise<RemovalRequestRow> {
  const [row] = await db.insert(profileRemovalRequests).values(input).returning()
  return row as RemovalRequestRow
}

export async function findRemovalRequestById(
  id: string,
  db: PostgresJsDatabase = publicDb,
): Promise<RemovalRequestRow | null> {
  const [row] = await db.select().from(profileRemovalRequests).where(eq(profileRemovalRequests.id, id)).limit(1)
  return (row as RemovalRequestRow | undefined) ?? null
}

/** No-op (returns false) if the request is no longer `pending` — a duplicate/retried verify call
 * must never re-verify or regress a request past its terminal state. */
export async function markRemovalRequestVerified(
  id: string,
  db: PostgresJsDatabase = publicDb,
): Promise<boolean> {
  const rows = await db.update(profileRemovalRequests)
    .set({ status: 'verified', verifiedAt: new Date() })
    .where(and(eq(profileRemovalRequests.id, id), eq(profileRemovalRequests.status, 'pending')))
    .returning({ id: profileRemovalRequests.id })
  return rows.length > 0
}

export async function markRemovalRequestRejected(
  id: string,
  db: PostgresJsDatabase = publicDb,
): Promise<void> {
  await db.update(profileRemovalRequests)
    .set({ status: 'rejected' })
    .where(and(eq(profileRemovalRequests.id, id), eq(profileRemovalRequests.status, 'pending')))
}

/** Scheduled sweep: flips any request still `pending` past its `expiresAt` — the worker-role
 * counterpart to the app-role's own expiry check on read (`isRemovalRequestExpired`). */
export async function expireStaleRemovalRequests(
  now: Date = new Date(),
  db: PostgresJsDatabase = workerDb,
): Promise<number> {
  const rows = await db.update(profileRemovalRequests)
    .set({ status: 'expired' })
    .where(and(eq(profileRemovalRequests.status, 'pending'), lt(profileRemovalRequests.expiresAt, now)))
    .returning({ id: profileRemovalRequests.id })
  return rows.length
}

export interface SuppressionRow {
  id: string
  source: string
  sourceId: string
  normalizedProfileUrlHash: string
  reason: 'verified-removal' | 'legal' | 'abuse'
  createdAt: Date
  revokedAt: Date | null
}

export async function findActiveSuppression(
  source: string,
  sourceId: string,
  db: PostgresJsDatabase = publicDb,
): Promise<SuppressionRow | null> {
  const [row] = await db.select().from(profileSuppressions)
    .where(and(eq(profileSuppressions.source, source), eq(profileSuppressions.sourceId, sourceId), isNull(profileSuppressions.revokedAt)))
    .limit(1)
  return (row as SuppressionRow | undefined) ?? null
}

/** Idempotent — verifying the same request twice (a retried POST) must not error on the active
 * uniqueness constraint; it is treated as "already suppressed," not a failure. */
export async function insertSuppressionIfAbsent(
  input: { id: string; source: string; sourceId: string; normalizedProfileUrlHash: string; reason: 'verified-removal' | 'legal' | 'abuse' },
  db: PostgresJsDatabase = publicDb,
): Promise<void> {
  const existing = await findActiveSuppression(input.source, input.sourceId, db)
  if (existing) return
  await db.insert(profileSuppressions).values(input)
}

/** Every currently-active suppressed `(source, sourceId)` pair — the full set
 * `profile-suppression.ts`'s in-process filter loads to check candidates against. */
export async function listActiveSuppressions(
  db: PostgresJsDatabase = publicDb,
  after: string | null = null,
  limit: number = SWEEP_BATCH,
): Promise<Array<{ id: string; source: string; sourceId: string }>> {
  // A **batch**, drained by `profile-suppression.ts`. A suppressed profile that falls past a ceiling
  // is a profile the product keeps showing after someone exercised their right to have it removed —
  // the one failure here that nobody reports, because the person who asked cannot see the result.
  return db.select({ id: profileSuppressions.id, source: profileSuppressions.source, sourceId: profileSuppressions.sourceId })
    .from(profileSuppressions)
    .where(and(
      isNull(profileSuppressions.revokedAt),
      ...(after ? [gt(profileSuppressions.id, after)] : []),
    ))
    .orderBy(asc(profileSuppressions.id))
    .limit(limit)
}

/** Audited admin/legal action, never a hard delete (spec.md: "deleting it is an audited
 * admin/legal action, not request expiry") — sets `revokedAt`, the row stays for the record. */
export async function revokeSuppression(
  id: string,
  db: PostgresJsDatabase = publicDb,
): Promise<boolean> {
  const rows = await db.update(profileSuppressions)
    .set({ revokedAt: new Date() })
    .where(and(eq(profileSuppressions.id, id), isNull(profileSuppressions.revokedAt)))
    .returning({ id: profileSuppressions.id })
  return rows.length > 0
}

/**
 * A removal request or an active suppression is itself sensitive: below this count, breaking a
 * total down by `source` (or status) risks re-identifying the one or two people behind it — e.g.
 * "1 pending request from devpost" combined with public knowledge of who recently asked to be
 * removed. Mirrors `conversion-events.ts`'s `MIN_SAMPLE_FOR_CI` in spirit (a named, documented
 * threshold below which a real number becomes a redaction), not in mechanism — that one nulls a
 * confidence interval; this one folds the small bucket into "other" instead of naming it.
 */
const MIN_COHORT_FOR_SOURCE_DISCLOSURE = 5

export interface RemovalOperationsMetrics {
  totalRequests: number
  byStatus: Record<RemovalRequestStatus, number>
  /** Only sources whose own request count meets `MIN_COHORT_FOR_SOURCE_DISCLOSURE` are named — the
   * rest are folded into `otherSourcesCount` so their existence is visible without their identity. */
  bySource: Array<{ source: string; count: number }>
  otherSourcesCount: number
  /** Aging buckets for requests still `pending` — how long they have been waiting, not who they are. */
  pendingAging: {
    underOneDay: number
    oneToSevenDays: number
    sevenToThirtyDays: number
    overThirtyDays: number
  }
  /** Still `pending` past their own `expiresAt` — the scheduled sweep (`expireStaleRemovalRequests`)
   * should have moved these to `expired` by now and hasn't; a real operational backlog, not
   * identity-bearing on its own, so never suppressed regardless of size. */
  overduePendingCount: number
  activeSuppressions: number
  generatedAt: string
}

/**
 * Bounded, redacted aggregate for the Admin Metrics "removal operations" section
 * (plans/UI/tasks.md Wave 5 "Render redacted removal operations metrics"). Never returns a
 * `sourceId`, `normalizedProfileUrl(Hash)`, `requesterEmailHash`, `challengeHash`, or any other
 * per-request field — only counts.
 */
export async function getRemovalOperationsMetrics(now: Date = new Date(), db: PostgresJsDatabase | typeof platformDb = platformDb): Promise<RemovalOperationsMetrics> {
  const requests = await db.select({
    status: profileRemovalRequests.status,
    source: profileRemovalRequests.source,
    createdAt: profileRemovalRequests.createdAt,
    expiresAt: profileRemovalRequests.expiresAt,
  }).from(profileRemovalRequests)

  const byStatus: Record<RemovalRequestStatus, number> = { pending: 0, verified: 0, rejected: 0, expired: 0 }
  const bySourceCounts = new Map<string, number>()
  const pendingAging = { underOneDay: 0, oneToSevenDays: 0, sevenToThirtyDays: 0, overThirtyDays: 0 }
  let overduePendingCount = 0

  const oneDayMs = 24 * 60 * 60 * 1000
  for (const row of requests) {
    const status = row.status as RemovalRequestStatus
    byStatus[status] = (byStatus[status] ?? 0) + 1
    bySourceCounts.set(row.source, (bySourceCounts.get(row.source) ?? 0) + 1)

    if (status === 'pending') {
      const ageMs = now.getTime() - row.createdAt.getTime()
      if (ageMs < oneDayMs) pendingAging.underOneDay += 1
      else if (ageMs < 7 * oneDayMs) pendingAging.oneToSevenDays += 1
      else if (ageMs < 30 * oneDayMs) pendingAging.sevenToThirtyDays += 1
      else pendingAging.overThirtyDays += 1

      if (row.expiresAt.getTime() < now.getTime()) overduePendingCount += 1
    }
  }

  const bySource: Array<{ source: string; count: number }> = []
  let otherSourcesCount = 0
  for (const [source, count] of bySourceCounts) {
    if (count >= MIN_COHORT_FOR_SOURCE_DISCLOSURE) bySource.push({ source, count })
    else otherSourcesCount += count
  }
  bySource.sort((a, b) => b.count - a.count)

  const [{ count: activeSuppressions }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(profileSuppressions)
    .where(isNull(profileSuppressions.revokedAt))

  return {
    totalRequests: requests.length,
    byStatus,
    bySource,
    otherSourcesCount,
    pendingAging,
    overduePendingCount,
    activeSuppressions,
    generatedAt: now.toISOString(),
  }
}

/**
 * One batch of organization ids, ascending — bounded since plan 12.
 *
 * Callers must **drain** this, not take the first batch: a worker that silently skips the
 * five-hundred-and-first organization has not failed, it has just not done the work, and nobody is
 * waiting on that tenant to notice. `collectWorkerOrganizationIds`/`drainWorkerOrganizations` in
 * `worker-organization-scan.ts` are the shapes that cannot get the termination condition wrong.
 */
export function listWorkerOrganizationIds(
  db: PostgresJsDatabase | typeof workerDb = workerDb,
  after: string | null = null,
  limit: number = WORKER_ORGANIZATION_BATCH,
) {
  return db.select({ id: organizations.id }).from(organizations)
    .where(after ? gt(organizations.id, after) : undefined)
    .orderBy(asc(organizations.id))
    .limit(limit)
}

export function withWorkerOrganization<TResult>(
  organizationId: string,
  operation: (transaction: WorkerTransaction) => Promise<TResult>,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`
      select
        set_config('app.organization_id', ${organizationId}, true),
        set_config('app.organization_role', 'worker', true),
        set_config('app.request_id', ${randomUUID()}, true)
    `)
    return operation(transaction as WorkerTransaction)
  })
}

/** Deletes every `builders` row matching `(source, sourceId)` across EVERY organization —
 * `builders` is a per-organization cache (spec.md: "`builders` is a per-user cache"), so a single
 * suppressed identity can have one cached row per org that ever searched for them. O(organizations)
 * per verification — acceptable at this app's current scale, same tradeoff
 * `repositories/billing-worker.ts`'s header comment already documents for its own cross-org sweep. */
export async function deleteBuildersAcrossOrganizations(
  source: string,
  sourceId: string,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
): Promise<number> {
  // Drained rather than one batch: `listWorkerOrganizationIds` is bounded (plan 12), and a worker
  // that stops at the batch size has silently skipped every organization past it.
  const orgIds = (await collectWorkerOrganizationIds((after, limit) => listWorkerOrganizationIds(db, after, limit))).map((id) => ({ id }))
  let deleted = 0
  for (const { id: organizationId } of orgIds) {
    const rows = await withWorkerOrganization(organizationId, (tx) =>
      tx.delete(builders)
        .where(and(eq(builders.organizationId, organizationId), eq(builders.source, source), eq(builders.sourceId, sourceId)))
        .returning({ id: builders.id }),
    db)
    deleted += rows.length
  }
  return deleted
}

/**
 * Counts of removal requests, grouped by state and by source. Nothing else.
 *
 * ## What is deliberately absent, and why each one
 *
 * A removal request is someone asking not to be in a product. The request itself is therefore *more* sensitive
 * than the profile it concerns — it reveals that a specific person objects to being indexed, which is exactly
 * the kind of fact an operator has no business browsing. So this returns numbers, and the omissions are the
 * design:
 *
 * - **No requester identity, not even the hashed email.** A hash is still a join key: two dashboards holding
 *   the same hash can be correlated, and an operator with a candidate address can confirm a match by hashing
 *   it. Counts cannot be correlated with anything.
 * - **No profile URL or source id.** The pair identifies the person as precisely as a name would.
 * - **No free-text reason.** People explain themselves in these fields, sometimes at length and often about
 *   harassment or safety. That text has one legitimate reader — whoever processes the request — and a metrics
 *   endpoint is not it.
 * - **No timestamps per request.** A `createdAt` plus a source narrows a request to one person on a quiet day.
 *
 * What remains is enough to answer the only operational questions a dashboard should ask: is the queue growing,
 * and is one source producing most of it.
 */
export interface RemovalRequestMetrics {
  byStatus: Record<RemovalRequestStatus, number>
  bySource: Array<{ source: string; count: number }>
  total: number
}

export async function getRemovalRequestMetrics(
  db: PostgresJsDatabase<Record<string, never>> = publicDb,
): Promise<RemovalRequestMetrics> {
  const [statusRows, sourceRows] = await Promise.all([
    db.execute<{ status: string; count: string }>(
      sql`select status, count(*)::text as count from profile_removal_requests group by status`,
    ),
    db.execute<{ source: string; count: string }>(
      sql`select source, count(*)::text as count from profile_removal_requests group by source order by 2 desc`,
    ),
  ])

  // Every status is present with a zero rather than omitted. A missing key reads as "no data" and invites a
  // dashboard to render a gap where the honest answer is "none yet".
  const byStatus: Record<RemovalRequestStatus, number> = {
    pending: 0,
    verified: 0,
    rejected: 0,
    expired: 0,
  }
  for (const row of statusRows as unknown as Array<{ status: string; count: string }>) {
    if (row.status in byStatus) byStatus[row.status as RemovalRequestStatus] = Number(row.count)
  }

  const bySource = (sourceRows as unknown as Array<{ source: string; count: string }>).map((row) => ({
    source: row.source,
    count: Number(row.count),
  }))

  return { byStatus, bySource, total: Object.values(byStatus).reduce((sum, count) => sum + count, 0) }
}
