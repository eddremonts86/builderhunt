import { randomUUID } from 'node:crypto'
import { and, eq, gte, inArray, isNotNull, lt, notInArray, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { workerDb, type WorkerTransaction } from '../db/worker-db'
import { calendarEventOccurrences, calendarEvents, jobRuns, operationalSchedules, organizations } from '../db/schema'

/**
 * Worker-role data access for calendar materialization and reminder delivery (plan:
 * calendar-scheduling-interview-intelligence, Phase 3).
 *
 * The worker has no session user, so it operates org-by-org through the established
 * `listWorkerOrganizationIds`/`withWorkerOrganization` cross-tenant loop. This module keeps its
 * OWN copy of that pair rather than importing another module's — the same precedent
 * `alerts-worker.ts`, `billing-worker.ts`, `sprints-worker.ts`, and `profile-removal.ts` each
 * follow. There is deliberately no "all organizations at once" query anywhere: RLS scopes each
 * transaction to exactly one tenant, so a bug in one org's batch cannot read or write another's.
 */

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

/** Recurring, non-cancelled events the materializer needs to expand for this tenant. */
export async function listRecurringEventsForMaterialization(
  transaction: WorkerTransaction,
  organizationId: string,
  limit: number,
) {
  return transaction
    .select({
      id: calendarEvents.id,
      organizationId: calendarEvents.organizationId,
      ownerUserId: calendarEvents.ownerUserId,
      startsAt: calendarEvents.startsAt,
      endsAt: calendarEvents.endsAt,
      timezone: calendarEvents.timezone,
      rrule: calendarEvents.rrule,
      recurrenceUntil: calendarEvents.recurrenceUntil,
      status: calendarEvents.status,
      version: calendarEvents.version,
    })
    .from(calendarEvents)
    .where(and(
      eq(calendarEvents.organizationId, organizationId),
      isNotNull(calendarEvents.rrule),
      sql`${calendarEvents.status} not in ('cancelled', 'rescheduled')`,
    ))
    .limit(limit)
}

/**
 * Removes materialized occurrences for an event that the current expansion no longer produces.
 * Bounded to `>= prunedFrom` so an occurrence in the past — which a user may already have acted
 * on — is never silently deleted by a horizon shift.
 */
export async function pruneObsoleteOccurrences(
  transaction: WorkerTransaction,
  organizationId: string,
  eventId: string,
  keepRecurrenceIds: string[],
  prunedFrom: Date,
) {
  const conditions = [
    eq(calendarEventOccurrences.organizationId, organizationId),
    eq(calendarEventOccurrences.eventId, eventId),
    gte(calendarEventOccurrences.startsAt, prunedFrom),
  ]
  if (keepRecurrenceIds.length > 0) {
    // `notInArray`, not `<> all(${array})` — drizzle expands a JS array into a parameter tuple
    // rather than binding a real Postgres array, which makes `all()` a syntax error at runtime.
    conditions.push(notInArray(calendarEventOccurrences.recurrenceId, keepRecurrenceIds))
  }
  return transaction.delete(calendarEventOccurrences).where(and(...conditions)).returning({ id: calendarEventOccurrences.id })
}

/** Drops every materialized occurrence for an event the organizer has since cancelled. */
export async function pruneOccurrencesForCancelledEvents(transaction: WorkerTransaction, organizationId: string) {
  return transaction
    .delete(calendarEventOccurrences)
    .where(and(
      eq(calendarEventOccurrences.organizationId, organizationId),
      sql`exists (
        select 1 from ${calendarEvents} e
        where e.organization_id = ${calendarEventOccurrences.organizationId}
          and e.id = ${calendarEventOccurrences.eventId}
          and e.status in ('cancelled', 'rescheduled')
      )`,
    ))
    .returning({ id: calendarEventOccurrences.id })
}

// ── Job run bookkeeping (platform-owned, not tenant-scoped) ─────────────────────────────────

export async function findScheduleByJobKey(jobKey: string, db: PostgresJsDatabase | typeof workerDb = workerDb) {
  const [row] = await db
    .select({ id: operationalSchedules.id, jobKey: operationalSchedules.jobKey, enabled: operationalSchedules.enabled })
    .from(operationalSchedules)
    .where(eq(operationalSchedules.jobKey, jobKey))
    .limit(1)
  return row ?? null
}

export async function openJobRun(
  input: { jobKey: string; scheduleId?: string | null; scheduledFor: Date },
  db: PostgresJsDatabase | typeof workerDb = workerDb,
) {
  const [row] = await db
    .insert(jobRuns)
    .values({
      jobKey: input.jobKey,
      scheduleId: input.scheduleId ?? null,
      scheduledFor: input.scheduledFor,
      startedAt: new Date(),
      state: 'running',
    })
    .returning({ id: jobRuns.id })
  return row
}

/** `errorCode` must stay a short, redacted code — these rows surface in a user-visible calendar feed. */
export async function closeJobRun(
  runId: string,
  outcome: { state: 'succeeded' | 'failed'; processedCount: number; failedCount: number; durationMs: number; errorCode?: string | null },
  db: PostgresJsDatabase | typeof workerDb = workerDb,
) {
  const [row] = await db
    .update(jobRuns)
    .set({
      state: outcome.state,
      finishedAt: new Date(),
      processedCount: outcome.processedCount,
      failedCount: outcome.failedCount,
      durationMs: outcome.durationMs,
      errorCode: outcome.errorCode ?? null,
    })
    .where(eq(jobRuns.id, runId))
    .returning({ id: jobRuns.id, state: jobRuns.state })
  return row ?? null
}

/** Read-only projection for the calendar feed's `job_run` lane. */
export async function listRecentJobRuns(
  jobKeys: string[],
  range: { from: Date; to: Date },
  db: PostgresJsDatabase | typeof workerDb = workerDb,
) {
  if (jobKeys.length === 0) return []
  return db
    .select({
      id: jobRuns.id,
      jobKey: jobRuns.jobKey,
      scheduledFor: jobRuns.scheduledFor,
      startedAt: jobRuns.startedAt,
      finishedAt: jobRuns.finishedAt,
      state: jobRuns.state,
      processedCount: jobRuns.processedCount,
      failedCount: jobRuns.failedCount,
      durationMs: jobRuns.durationMs,
      errorCode: jobRuns.errorCode,
    })
    .from(jobRuns)
    .where(and(
      inArray(jobRuns.jobKey, jobKeys),
      gte(jobRuns.scheduledFor, range.from),
      lt(jobRuns.scheduledFor, range.to),
    ))
}
