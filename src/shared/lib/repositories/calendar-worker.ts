import { randomUUID } from 'node:crypto'
import { and, asc, eq, gt, gte, inArray, isNotNull, lt, lte, notInArray, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { workerDb, type WorkerTransaction } from '../db/worker-db'
import {
  authUsers,
  calendarEventOccurrences,
  calendarEventReminders,
  calendarEvents,
  calendarNotificationDeliveries,
  eventParticipants,
  jobRuns,
  operationalSchedules,
  organizations,
  schedulingInvitations,
} from '../db/schema'
import { WORKER_ORGANIZATION_BATCH } from './worker-organization-scan'

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

// ── Reminder delivery (plan Phase 3, "Implement reminder and participant-notification delivery") ──

/**
 * A due reminder joined to everything the delivery decision needs, in one query.
 *
 * The join is deliberately eager rather than a per-reminder follow-up read: the suppression rules
 * (cancelled event, removed participant, stale materialization) all depend on the CURRENT state of
 * the event and participant rows, and reading them in the same snapshot as the reminder is what
 * makes "the event was cancelled a millisecond ago" resolve consistently instead of racing.
 *
 * `participantId is null` means the reminder belongs to the event owner — the LEFT JOIN keeps that
 * row rather than dropping it, and the null participant columns are the signal.
 */
export async function listDueReminderJobs(
  transaction: WorkerTransaction,
  organizationId: string,
  now: Date,
  limit: number,
) {
  return transaction
    .select({
      reminderId: calendarEventReminders.id,
      channel: calendarEventReminders.channel,
      offsetMinutes: calendarEventReminders.offsetMinutes,
      attempts: calendarEventReminders.attempts,
      nextFireAt: calendarEventReminders.nextFireAt,
      participantId: calendarEventReminders.participantId,
      eventId: calendarEvents.id,
      eventTitle: calendarEvents.title,
      eventStartsAt: calendarEvents.startsAt,
      eventEndsAt: calendarEvents.endsAt,
      eventTimezone: calendarEvents.timezone,
      eventLocation: calendarEvents.location,
      eventMeetingUrl: calendarEvents.meetingUrl,
      eventStatus: calendarEvents.status,
      eventVersion: calendarEvents.version,
      ownerUserId: calendarEvents.ownerUserId,
      ownerEmail: authUsers.email,
      participantUserId: eventParticipants.userId,
      participantExternalEmail: eventParticipants.externalEmail,
      participantResponse: eventParticipants.response,
    })
    .from(calendarEventReminders)
    .innerJoin(calendarEvents, and(
      eq(calendarEvents.organizationId, calendarEventReminders.organizationId),
      eq(calendarEvents.id, calendarEventReminders.eventId),
    ))
    .innerJoin(authUsers, eq(authUsers.id, calendarEvents.ownerUserId))
    .leftJoin(eventParticipants, and(
      eq(eventParticipants.organizationId, calendarEventReminders.organizationId),
      eq(eventParticipants.id, calendarEventReminders.participantId),
    ))
    .where(and(
      eq(calendarEventReminders.organizationId, organizationId),
      eq(calendarEventReminders.state, 'pending'),
      eq(calendarEventReminders.enabled, true),
      lte(calendarEventReminders.nextFireAt, now),
    ))
    .orderBy(asc(calendarEventReminders.nextFireAt))
    .limit(limit)
}

/** Resolves an internal participant's login email; external participants carry their own address. */
export async function findUserEmail(transaction: WorkerTransaction, userId: string) {
  const [row] = await transaction.select({ email: authUsers.email }).from(authUsers).where(eq(authUsers.id, userId)).limit(1)
  return row?.email ?? null
}

/** Closes out a delivery attempt. `errorCode` stays a short code — deliveries surface in the UI. */
export async function markDeliveryOutcome(
  transaction: WorkerTransaction,
  organizationId: string,
  deliveryId: string,
  outcome: { state: 'sent' | 'failed'; providerReference?: string | null; errorCode?: string | null },
) {
  const now = new Date()
  const [row] = await transaction
    .update(calendarNotificationDeliveries)
    .set({
      state: outcome.state,
      attemptedAt: now,
      deliveredAt: outcome.state === 'sent' ? now : null,
      providerReference: outcome.providerReference ?? null,
      errorCode: outcome.errorCode ?? null,
      updatedAt: now,
    })
    .where(and(
      eq(calendarNotificationDeliveries.organizationId, organizationId),
      eq(calendarNotificationDeliveries.id, deliveryId),
    ))
    .returning({ id: calendarNotificationDeliveries.id, state: calendarNotificationDeliveries.state })
  return row ?? null
}

/** Looked up on an idempotency-key conflict so a previously FAILED delivery can be retried rather than mistaken for a success. */
export async function findDeliveryByIdempotencyKey(transaction: WorkerTransaction, organizationId: string, idempotencyKey: string) {
  const [row] = await transaction
    .select({
      id: calendarNotificationDeliveries.id,
      state: calendarNotificationDeliveries.state,
    })
    .from(calendarNotificationDeliveries)
    .where(and(
      eq(calendarNotificationDeliveries.organizationId, organizationId),
      eq(calendarNotificationDeliveries.idempotencyKey, idempotencyKey),
    ))
    .limit(1)
  return row ?? null
}

/**
 * Everything needed to notify both parties about a booked interview, in one read.
 *
 * Worker-role, and that is not an optimisation. The candidate-facing routes authorize as
 * `builderhunt_capability`, which holds SELECT and nothing else (drizzle/0078) — so writing the
 * delivery ledger rows a notification needs is impossible in the transaction that served the request.
 * The notification therefore runs afterwards in its own worker transaction and re-reads by invitation
 * id rather than being handed rows across a role boundary.
 *
 * Returns null when the invitation has no booked event: a decline or an expiry has nothing to attach an
 * ICS to, and a caller that treats "no event" as an error would log noise for the normal case.
 */
export async function findSchedulingNotificationContext(
  transaction: WorkerTransaction,
  organizationId: string,
  invitationId: string,
) {
  const [row] = await transaction
    .select({
      invitationId: schedulingInvitations.id,
      ownerUserId: schedulingInvitations.ownerUserId,
      roleTitle: schedulingInvitations.roleTitle,
      candidateEmail: schedulingInvitations.candidateEmailNormalized,
      invitationTimezone: schedulingInvitations.timezone,
      eventId: calendarEvents.id,
      eventVersion: calendarEvents.version,
      eventTitle: calendarEvents.title,
      eventStatus: calendarEvents.status,
      startsAt: calendarEvents.startsAt,
      endsAt: calendarEvents.endsAt,
      timezone: calendarEvents.timezone,
      location: calendarEvents.location,
      meetingUrl: calendarEvents.meetingUrl,
    })
    .from(schedulingInvitations)
    .innerJoin(calendarEvents, eq(calendarEvents.id, schedulingInvitations.bookedEventId))
    .where(and(
      eq(schedulingInvitations.organizationId, organizationId),
      eq(schedulingInvitations.id, invitationId),
    ))
    .limit(1)
  return row ?? null
}
