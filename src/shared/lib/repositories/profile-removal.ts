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
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { publicDb } from '../db/client'
import { workerDb, type WorkerTransaction } from '../db/worker-db'
import { builders, organizations, profileRemovalRequests, profileSuppressions } from '../db/schema'

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
): Promise<Array<{ source: string; sourceId: string }>> {
  return db.select({ source: profileSuppressions.source, sourceId: profileSuppressions.sourceId })
    .from(profileSuppressions)
    .where(isNull(profileSuppressions.revokedAt))
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

export function listWorkerOrganizationIds(db: PostgresJsDatabase | typeof workerDb = workerDb) {
  return db.select({ id: organizations.id }).from(organizations)
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
  const orgIds = await listWorkerOrganizationIds(db)
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
