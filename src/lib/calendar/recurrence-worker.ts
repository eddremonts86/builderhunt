import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { workerDb } from '~/shared/lib/db/worker-db'
import { expandRecurrenceRule } from '~/shared/lib/scheduling'
import { upsertOccurrences } from '~/shared/lib/repositories/calendar'
import {
  listRecurringEventsForMaterialization,
  listWorkerOrganizationIds,
  pruneObsoleteOccurrences,
  pruneOccurrencesForCancelledEvents,
  withWorkerOrganization,
} from '~/shared/lib/repositories/calendar-worker'
import { withJobRun } from '~/shared/lib/repositories/platform-operations'

/**
 * Materializes recurring calendar events into concrete occurrence rows (plan:
 * calendar-scheduling-interview-intelligence, Phase 3 "Implement recurrence materialization
 * worker").
 *
 * Idempotent by construction: expansion is a pure function of `(rrule, dtstart, timezone,
 * horizon)`, and the write is an upsert on the table's `(organization_id, event_id,
 * recurrence_id)` identity. Running it twice — or twice concurrently — converges on the same
 * occurrence set rather than duplicating rows.
 *
 * Tenant isolation is per-iteration: each organization gets its own `withWorkerOrganization`
 * transaction, so one tenant's failure rolls back only that tenant's batch and the loop continues.
 * There is no cross-tenant query anywhere in this file.
 */

export const RECURRENCE_JOB_KEY = 'calendar.recurrence-materialization'

/** Past window is short — occurrences behind it are history a user may have acted on, so they are never pruned. */
export const MATERIALIZATION_PAST_DAYS = 30
export const MATERIALIZATION_FUTURE_DAYS = 180
const EVENTS_PER_TENANT = 200

export interface RecurrenceWorkerResult {
  organizationsProcessed: number
  eventsExpanded: number
  occurrencesWritten: number
  occurrencesPruned: number
  failedOrganizations: { organizationId: string; errorCode: string }[]
}

export interface RecurrenceWorkerOptions {
  now?: Date
  db?: PostgresJsDatabase | typeof workerDb
  /** Injected in tests so a fixture can pin the window without touching the clock. */
  pastDays?: number
  futureDays?: number
}

export async function runRecurrenceWorker(options: RecurrenceWorkerOptions = {}): Promise<RecurrenceWorkerResult> {
  const now = options.now ?? new Date()
  const db = options.db ?? workerDb
  const pastDays = options.pastDays ?? MATERIALIZATION_PAST_DAYS
  const futureDays = options.futureDays ?? MATERIALIZATION_FUTURE_DAYS

  const rangeFrom = new Date(now.getTime() - pastDays * 24 * 60 * 60_000)
  const rangeTo = new Date(now.getTime() + futureDays * 24 * 60 * 60_000)

  // Same shared recorder as every other worker; see reminder-worker.ts for why calendar workers
  // record inside the function rather than at their route.
  return withJobRun({ jobKey: RECURRENCE_JOB_KEY, now, db }, async () => {
    const result: RecurrenceWorkerResult = {
      organizationsProcessed: 0,
      eventsExpanded: 0,
      occurrencesWritten: 0,
      occurrencesPruned: 0,
      failedOrganizations: [],
    }

    const organizationIds = await listWorkerOrganizationIds(db)

    for (const { id: organizationId } of organizationIds) {
      try {
        const tenantResult = await withWorkerOrganization(organizationId, async (transaction) => {
          // Cancelled events lose their whole materialization first, so a cancelled series never
          // keeps firing reminders off stale occurrence rows.
          const cancelledPruned = await pruneOccurrencesForCancelledEvents(transaction, organizationId)

          const events = await listRecurringEventsForMaterialization(transaction, organizationId, EVENTS_PER_TENANT)
          let written = 0
          let pruned = cancelledPruned.length

          for (const event of events) {
            if (!event.rrule) continue

            // `recurrenceUntil` narrows the window further, but never widens it past the horizon.
            const effectiveTo = event.recurrenceUntil && event.recurrenceUntil < rangeTo ? event.recurrenceUntil : rangeTo
            if (effectiveTo <= rangeFrom) continue

            const durationMs = event.endsAt.getTime() - event.startsAt.getTime()
            const occurrences = expandRecurrenceRule({
              rruleText: event.rrule,
              eventStartsAt: event.startsAt,
              eventDurationMs: durationMs,
              timeZone: event.timezone,
              rangeFrom,
              rangeTo: effectiveTo,
              exceptionInstants: [],
          })

          if (occurrences.length > 0) {
            const rows = await upsertOccurrences(transaction, occurrences.map((occurrence) => ({
              organizationId,
              eventId: event.id,
              recurrenceId: occurrence.recurrenceId,
              startsAt: occurrence.startsAt,
              endsAt: occurrence.endsAt,
              status: 'active',
              materializationVersion: event.version,
            })))
            written += rows.length
          }

          // Prune anything the current expansion no longer produces — an edited rule, a shortened
          // UNTIL, or a shifted start. Bounded to `now` forward so past occurrences survive.
          const obsolete = await pruneObsoleteOccurrences(
            transaction,
            organizationId,
            event.id,
            occurrences.map((occurrence) => occurrence.recurrenceId),
            now,
          )
          pruned += obsolete.length
        }

        return { eventsExpanded: events.length, written, pruned }
      }, db)

      result.organizationsProcessed += 1
      result.eventsExpanded += tenantResult.eventsExpanded
      result.occurrencesWritten += tenantResult.written
      result.occurrencesPruned += tenantResult.pruned
    } catch (error) {
      // One tenant's failure must not abort the sweep, and the recorded code stays redacted —
      // these rows are projected into a user-visible calendar feed.
      result.failedOrganizations.push({
        organizationId,
        errorCode: error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'materialization_failed',
      })
    }
  }

  return {
    ...result,
    processedCount: result.occurrencesWritten,
    failedCount: result.failedOrganizations.length,
    errorCode: result.failedOrganizations.length > 0 ? 'partial_tenant_failure' : null,
  }
  })
}
