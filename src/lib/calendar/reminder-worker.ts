import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { workerDb } from '~/shared/lib/db/worker-db'
import { sendCalendarEventEmail, type SendResult } from '~/shared/lib/email'
import { insertDeliveryIfAbsent, markReminderState } from '~/shared/lib/repositories/calendar'
import {
  closeJobRun,
  findDeliveryByIdempotencyKey,
  findScheduleByJobKey,
  findUserEmail,
  listDueReminderJobs,
  listWorkerOrganizationIds,
  markDeliveryOutcome,
  openJobRun,
  withWorkerOrganization,
} from '~/shared/lib/repositories/calendar-worker'
import { buildEventIcs } from './ics'

/**
 * Delivers due calendar reminders (plan: calendar-scheduling-interview-intelligence, Phase 3
 * "Implement reminder and participant-notification delivery").
 *
 * Exactly-once is enforced by the database, not by care: every send is preceded by an insert into
 * `calendar_notification_deliveries` keyed on a deterministic idempotency key, and that column has
 * a unique index. Two workers racing on the same reminder both attempt the insert; one wins, the
 * other gets a conflict and stands down. This is why the insert happens BEFORE the send rather
 * than after — a crash between insert and send costs one missed reminder, whereas a crash between
 * send and insert would cost a duplicate every retry, forever.
 *
 * Tenant isolation is per-iteration: one `withWorkerOrganization` transaction per organization,
 * with no cross-tenant query anywhere. One tenant failing rolls back only that tenant's batch.
 */

export const REMINDER_JOB_KEY = 'calendar.reminder-delivery'

/**
 * After this many failed attempts a reminder stops retrying. A reminder is time-sensitive by
 * definition — retrying a "your interview starts in 15 minutes" notice for an hour delivers
 * something worse than nothing, so the cap is deliberately low.
 */
export const MAX_REMINDER_ATTEMPTS = 3

const REMINDERS_PER_TENANT = 200

export interface ReminderWorkerResult {
  organizationsProcessed: number
  delivered: number
  /** Already delivered by an earlier or concurrent run — counted separately so a spike is visible rather than hidden inside `delivered`. */
  skippedDuplicate: number
  suppressed: number
  failed: number
  exhausted: number
  failedOrganizations: { organizationId: string; errorCode: string }[]
}

export interface ReminderWorkerOptions {
  now?: Date
  db?: PostgresJsDatabase | typeof workerDb
  /** Injected in tests so delivery can be asserted without an email provider. */
  send?: (to: string, details: Parameters<typeof sendCalendarEventEmail>[1]) => Promise<SendResult>
}

type ReminderJob = Awaited<ReturnType<typeof listDueReminderJobs>>[number]

/**
 * Why a reminder was dropped instead of sent. Each is a spec-mandated suppression, and each is
 * terminal: the reminder is marked `cancelled`, never retried.
 */
type SuppressionReason =
  | 'event_cancelled'
  | 'participant_removed'
  | 'participant_declined'
  | 'stale_schedule'
  | 'no_recipient_address'

function suppressionFor(job: ReminderJob): SuppressionReason | null {
  // spec.md: reminders "never resend after event cancellation or recipient removal".
  if (job.eventStatus === 'cancelled' || job.eventStatus === 'rescheduled') return 'event_cancelled'

  // A non-null `participantId` that resolved to no participant row means the attendee was removed
  // between arming and firing. Today the composite FK is ON DELETE CASCADE, so removing a
  // participant already removes their reminders and this branch is unreachable — it is kept as a
  // second line of defence for any future soft-removal path, and because a dangling participant
  // link must never fall through to the owner's address.
  if (job.participantId !== null && job.participantUserId === null && job.participantExternalEmail === null) {
    return 'participant_removed'
  }
  if (job.participantResponse === 'declined') return 'participant_declined'

  // `nextFireAt` is derived from the event start at arm time. If it no longer matches the event's
  // CURRENT start, this reminder was computed against a schedule that has since moved, and firing
  // it would notify the recipient at the wrong time. `updateEvent` re-arms reminders on a start
  // change, so reaching this branch means an out-of-band write — suppress rather than mislead.
  if (job.nextFireAt) {
    const expectedFireAt = job.eventStartsAt.getTime() - job.offsetMinutes * 60_000
    if (Math.abs(job.nextFireAt.getTime() - expectedFireAt) > 60_000) return 'stale_schedule'
  }

  return null
}

/**
 * Deterministic across retries and across concurrent workers, and distinct per occurrence.
 *
 * The occurrence is identified by the fire time rather than the reminder id alone: a recurring
 * series reuses one reminder row across every occurrence, so keying on the row would collapse the
 * whole series into a single "already delivered" record.
 */
function deliveryIdempotencyKey(job: ReminderJob, recipientKey: string): string {
  const occurrence = (job.nextFireAt ?? job.eventStartsAt).toISOString()
  return `calendar-reminder:${job.reminderId}:${occurrence}:${job.channel}:${job.offsetMinutes}:${recipientKey}`
}

export async function runReminderWorker(options: ReminderWorkerOptions = {}): Promise<ReminderWorkerResult> {
  const now = options.now ?? new Date()
  const db = options.db ?? workerDb
  const send = options.send ?? sendCalendarEventEmail

  const startedAt = Date.now()
  const schedule = await findScheduleByJobKey(REMINDER_JOB_KEY, db)
  const run = await openJobRun({ jobKey: REMINDER_JOB_KEY, scheduleId: schedule?.id ?? null, scheduledFor: now }, db)

  const result: ReminderWorkerResult = {
    organizationsProcessed: 0,
    delivered: 0,
    skippedDuplicate: 0,
    suppressed: 0,
    failed: 0,
    exhausted: 0,
    failedOrganizations: [],
  }

  const organizationIds = await listWorkerOrganizationIds(db)

  for (const { id: organizationId } of organizationIds) {
    try {
      const tenantResult = await withWorkerOrganization(organizationId, async (transaction) => {
        const jobs = await listDueReminderJobs(transaction, organizationId, now, REMINDERS_PER_TENANT)
        const counts = { delivered: 0, skippedDuplicate: 0, suppressed: 0, failed: 0, exhausted: 0 }

        for (const job of jobs) {
          const suppression = suppressionFor(job)
          if (suppression) {
            await markReminderState(transaction, organizationId, job.reminderId, 'cancelled', suppression)
            counts.suppressed += 1
            continue
          }

          // Owner reminders carry a null participant; the event's own owner is the recipient.
          const recipientUserId = job.participantId === null ? job.ownerUserId : job.participantUserId
          const recipientEmail = job.participantId === null
            ? job.ownerEmail
            : job.participantUserId
              ? await findUserEmail(transaction, job.participantUserId)
              : job.participantExternalEmail

          if (!recipientEmail) {
            await markReminderState(transaction, organizationId, job.reminderId, 'cancelled', 'no_recipient_address')
            counts.suppressed += 1
            continue
          }

          const idempotencyKey = deliveryIdempotencyKey(job, recipientUserId ?? `external:${recipientEmail}`)

          // Claim the send before performing it. See the module comment for why this order matters.
          const claimed = await insertDeliveryIfAbsent(transaction, {
            organizationId,
            eventId: job.eventId,
            reminderId: job.reminderId,
            kind: 'reminder',
            recipientUserId: recipientUserId ?? null,
            // External recipients are recorded by address, never by a hash we would have to
            // reverse later; the column name predates this and the value is the plain address's
            // stable identifier for dedupe only.
            externalRecipientHash: recipientUserId ? null : recipientEmail,
            idempotencyKey,
          })

          let deliveryId = claimed?.id ?? null
          if (deliveryId === null) {
            // Conflict: someone already claimed this key. Only a row that FAILED is ours to retry —
            // a sent or in-flight one means the recipient already has (or is getting) the notice.
            const existing = await findDeliveryByIdempotencyKey(transaction, organizationId, idempotencyKey)
            if (!existing || existing.state !== 'failed') {
              await markReminderState(transaction, organizationId, job.reminderId, 'sent')
              counts.skippedDuplicate += 1
              continue
            }
            deliveryId = existing.id
          }

          const icsContent = buildEventIcs({
            eventId: job.eventId,
            version: job.eventVersion,
            title: job.eventTitle,
            startsAt: job.eventStartsAt,
            endsAt: job.eventEndsAt,
            timezone: job.eventTimezone,
            location: job.eventLocation,
            meetingUrl: job.eventMeetingUrl,
            organizerEmail: job.ownerEmail,
          }, 'REQUEST')

          const sendResult = await send(recipientEmail, {
            kind: 'reminder',
            title: job.eventTitle,
            startsAt: job.eventStartsAt,
            endsAt: job.eventEndsAt,
            timezone: job.eventTimezone,
            location: job.eventLocation,
            meetingUrl: job.eventMeetingUrl,
            icsContent,
          })

          if (sendResult.ok) {
            await markDeliveryOutcome(transaction, organizationId, deliveryId, { state: 'sent', providerReference: sendResult.id ?? null })
            await markReminderState(transaction, organizationId, job.reminderId, 'sent')
            counts.delivered += 1
            continue
          }

          // Transient failure: record a short code (never the provider's message — these rows are
          // user-visible) and leave the reminder pending so the next sweep retries it, until the cap.
          await markDeliveryOutcome(transaction, organizationId, deliveryId, { state: 'failed', errorCode: 'send_failed' })
          const exhausted = job.attempts + 1 >= MAX_REMINDER_ATTEMPTS
          await markReminderState(transaction, organizationId, job.reminderId, exhausted ? 'failed' : 'pending', 'send_failed')
          counts.failed += 1
          if (exhausted) counts.exhausted += 1
        }

        return counts
      }, db)

      result.organizationsProcessed += 1
      result.delivered += tenantResult.delivered
      result.skippedDuplicate += tenantResult.skippedDuplicate
      result.suppressed += tenantResult.suppressed
      result.failed += tenantResult.failed
      result.exhausted += tenantResult.exhausted
    } catch (error) {
      result.failedOrganizations.push({
        organizationId,
        errorCode: error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'reminder_delivery_failed',
      })
    }
  }

  await closeJobRun(run.id, {
    state: result.failedOrganizations.length === 0 ? 'succeeded' : 'failed',
    processedCount: result.delivered,
    failedCount: result.failed + result.failedOrganizations.length,
    durationMs: Date.now() - startedAt,
    errorCode: result.failedOrganizations.length > 0 ? 'partial_tenant_failure' : null,
  }, db)

  return result
}
