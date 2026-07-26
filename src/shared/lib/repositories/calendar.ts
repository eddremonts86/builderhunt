import { and, asc, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import {
  calendarEventOccurrences,
  calendarEventReminders,
  calendarEvents,
  calendarNotificationDeliveries,
  eventParticipants,
  userCalendars,
} from '../db/schema'

/**
 * Tenant-scoped data access for calendars, events, occurrences, participants, reminders, and
 * notification deliveries (plan: calendar-scheduling-interview-intelligence, Phase 2 "Implement
 * calendar repository").
 *
 * Every function takes an already-tenant-scoped `TenantTransaction` (see
 * `~/shared/lib/db/tenant-context.ts`) and STILL re-filters by `organizationId` — and, where the
 * resource is private to one user, by `ownerUserId` — in the query itself. RLS
 * (drizzle/0069_calendar_scheduling_rls_grants.sql) already enforces both, so this is
 * defense-in-depth, matching `billing.ts`/`entitlements.ts`. Selects name their columns
 * explicitly rather than `select()`-ing the whole row, so a column added later is never
 * accidentally serialized to a client.
 */

export class CalendarRepositoryError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'CalendarRepositoryError'
  }
}

// ── Column projections ───────────────────────────────────────────────────────────────────────

const eventColumns = {
  id: calendarEvents.id,
  organizationId: calendarEvents.organizationId,
  calendarId: calendarEvents.calendarId,
  ownerUserId: calendarEvents.ownerUserId,
  type: calendarEvents.type,
  status: calendarEvents.status,
  title: calendarEvents.title,
  description: calendarEvents.description,
  location: calendarEvents.location,
  meetingUrl: calendarEvents.meetingUrl,
  startsAt: calendarEvents.startsAt,
  endsAt: calendarEvents.endsAt,
  timezone: calendarEvents.timezone,
  allDay: calendarEvents.allDay,
  busy: calendarEvents.busy,
  visibility: calendarEvents.visibility,
  rrule: calendarEvents.rrule,
  recurrenceUntil: calendarEvents.recurrenceUntil,
  version: calendarEvents.version,
  sourceType: calendarEvents.sourceType,
  sourceId: calendarEvents.sourceId,
  cancelledAt: calendarEvents.cancelledAt,
} as const

const occurrenceColumns = {
  id: calendarEventOccurrences.id,
  organizationId: calendarEventOccurrences.organizationId,
  eventId: calendarEventOccurrences.eventId,
  recurrenceId: calendarEventOccurrences.recurrenceId,
  startsAt: calendarEventOccurrences.startsAt,
  endsAt: calendarEventOccurrences.endsAt,
  status: calendarEventOccurrences.status,
  materializationVersion: calendarEventOccurrences.materializationVersion,
} as const

const participantColumns = {
  id: eventParticipants.id,
  organizationId: eventParticipants.organizationId,
  eventId: eventParticipants.eventId,
  userId: eventParticipants.userId,
  externalEmail: eventParticipants.externalEmail,
  displayName: eventParticipants.displayName,
  role: eventParticipants.role,
  response: eventParticipants.response,
  accessGranted: eventParticipants.accessGranted,
  respondedAt: eventParticipants.respondedAt,
} as const

const reminderColumns = {
  id: calendarEventReminders.id,
  organizationId: calendarEventReminders.organizationId,
  eventId: calendarEventReminders.eventId,
  participantId: calendarEventReminders.participantId,
  channel: calendarEventReminders.channel,
  offsetMinutes: calendarEventReminders.offsetMinutes,
  enabled: calendarEventReminders.enabled,
  nextFireAt: calendarEventReminders.nextFireAt,
  state: calendarEventReminders.state,
  attempts: calendarEventReminders.attempts,
  lastErrorCode: calendarEventReminders.lastErrorCode,
} as const

const deliveryColumns = {
  id: calendarNotificationDeliveries.id,
  organizationId: calendarNotificationDeliveries.organizationId,
  eventId: calendarNotificationDeliveries.eventId,
  reminderId: calendarNotificationDeliveries.reminderId,
  kind: calendarNotificationDeliveries.kind,
  recipientUserId: calendarNotificationDeliveries.recipientUserId,
  state: calendarNotificationDeliveries.state,
  attemptedAt: calendarNotificationDeliveries.attemptedAt,
  deliveredAt: calendarNotificationDeliveries.deliveredAt,
  readAt: calendarNotificationDeliveries.readAt,
  errorCode: calendarNotificationDeliveries.errorCode,
} as const
// `idempotencyKey`, `providerReference`, and `externalRecipientHash` are deliberately absent:
// they are delivery-plumbing internals with no product meaning to a calling user.

export type CalendarEventRecord = { [K in keyof typeof eventColumns]: unknown } & {
  id: string
  organizationId: string
  calendarId: string
  ownerUserId: string
  version: number
  startsAt: Date
  endsAt: Date
}

// ── Calendars ────────────────────────────────────────────────────────────────────────────────

export async function findDefaultCalendar(transaction: TenantTransaction, organizationId: string, ownerUserId: string) {
  const [row] = await transaction
    .select({
      id: userCalendars.id,
      organizationId: userCalendars.organizationId,
      ownerUserId: userCalendars.ownerUserId,
      name: userCalendars.name,
      timezone: userCalendars.timezone,
      isDefault: userCalendars.isDefault,
      color: userCalendars.color,
      defaultReminderOffsets: userCalendars.defaultReminderOffsets,
      defaultReminderChannels: userCalendars.defaultReminderChannels,
    })
    .from(userCalendars)
    .where(and(
      eq(userCalendars.organizationId, organizationId),
      eq(userCalendars.ownerUserId, ownerUserId),
      eq(userCalendars.isDefault, true),
    ))
    .limit(1)
  return row ?? null
}

export async function insertCalendar(
  transaction: TenantTransaction,
  input: {
    organizationId: string
    ownerUserId: string
    name: string
    timezone: string
    isDefault: boolean
    color?: string | null
  },
) {
  const [row] = await transaction
    .insert(userCalendars)
    .values({
      organizationId: input.organizationId,
      ownerUserId: input.ownerUserId,
      name: input.name,
      timezone: input.timezone,
      isDefault: input.isDefault,
      color: input.color ?? null,
    })
    .returning({ id: userCalendars.id })
  return row
}

// ── Events ───────────────────────────────────────────────────────────────────────────────────

export async function findEventById(transaction: TenantTransaction, organizationId: string, eventId: string) {
  const [row] = await transaction
    .select(eventColumns)
    .from(calendarEvents)
    .where(and(eq(calendarEvents.organizationId, organizationId), eq(calendarEvents.id, eventId)))
    .limit(1)
  return row ?? null
}

/**
 * Half-open `[from, to)` range read. An event overlaps the window when it starts before the
 * window ends and ends after the window starts — an event ending exactly at `from` does not
 * appear, matching `calendar.ts`'s `rangesOverlap`.
 */
export async function listEventsInRange(
  transaction: TenantTransaction,
  organizationId: string,
  ownerUserId: string,
  range: { from: Date; to: Date },
) {
  return transaction
    .select(eventColumns)
    .from(calendarEvents)
    .where(and(
      eq(calendarEvents.organizationId, organizationId),
      eq(calendarEvents.ownerUserId, ownerUserId),
      lt(calendarEvents.startsAt, range.to),
      gte(calendarEvents.endsAt, range.from),
    ))
    .orderBy(asc(calendarEvents.startsAt))
}

/** Title/participant/type/date-range search (spec.md "Search filters title, participant, event type, and date range"). */
export async function searchEvents(
  transaction: TenantTransaction,
  organizationId: string,
  ownerUserId: string,
  filter: { title?: string; participant?: string; eventType?: string; from: Date; to: Date },
) {
  const conditions = [
    eq(calendarEvents.organizationId, organizationId),
    eq(calendarEvents.ownerUserId, ownerUserId),
    lt(calendarEvents.startsAt, filter.to),
    gte(calendarEvents.endsAt, filter.from),
  ]
  if (filter.title) conditions.push(sql`${calendarEvents.title} ilike ${'%' + filter.title + '%'}`)
  if (filter.eventType) conditions.push(eq(calendarEvents.type, filter.eventType))
  if (filter.participant) {
    conditions.push(sql`exists (
      select 1 from ${eventParticipants} p
      where p.organization_id = ${calendarEvents.organizationId}
        and p.event_id = ${calendarEvents.id}
        and (p.display_name ilike ${'%' + filter.participant + '%'} or p.external_email ilike ${'%' + filter.participant + '%'})
    )`)
  }
  return transaction.select(eventColumns).from(calendarEvents).where(and(...conditions)).orderBy(asc(calendarEvents.startsAt))
}

export async function insertEvent(
  transaction: TenantTransaction,
  input: {
    organizationId: string
    calendarId: string
    ownerUserId: string
    type: string
    status: string
    title: string
    description?: string | null
    location?: string | null
    meetingUrl?: string | null
    startsAt: Date
    endsAt: Date
    timezone: string
    allDay: boolean
    busy: boolean
    rrule?: string | null
    recurrenceUntil?: Date | null
    sourceType?: string | null
    sourceId?: string | null
  },
) {
  const [row] = await transaction
    .insert(calendarEvents)
    .values({
      organizationId: input.organizationId,
      calendarId: input.calendarId,
      ownerUserId: input.ownerUserId,
      type: input.type,
      status: input.status,
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      meetingUrl: input.meetingUrl ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timezone: input.timezone,
      allDay: input.allDay,
      busy: input.busy,
      rrule: input.rrule ?? null,
      recurrenceUntil: input.recurrenceUntil ?? null,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
    })
    .returning(eventColumns)
  return row
}

/**
 * Optimistic update matching `id + organization + owner + version`. Returns `null` when nothing
 * matched, which the caller maps to `409 event_changed` — it never silently overwrites a row
 * someone else has since modified, and never widens to a different tenant or owner.
 */
export async function updateEventWithVersion(
  transaction: TenantTransaction,
  organizationId: string,
  ownerUserId: string,
  eventId: string,
  expectedVersion: number,
  patch: Partial<{
    title: string
    description: string | null
    location: string | null
    meetingUrl: string | null
    startsAt: Date
    endsAt: Date
    timezone: string
    allDay: boolean
    busy: boolean
    status: string
    rrule: string | null
    recurrenceUntil: Date | null
    cancelledAt: Date | null
  }>,
) {
  const [row] = await transaction
    .update(calendarEvents)
    .set({ ...patch, version: sql`${calendarEvents.version} + 1`, updatedAt: new Date() })
    .where(and(
      eq(calendarEvents.organizationId, organizationId),
      eq(calendarEvents.ownerUserId, ownerUserId),
      eq(calendarEvents.id, eventId),
      eq(calendarEvents.version, expectedVersion),
    ))
    .returning(eventColumns)
  return row ?? null
}

export async function deleteEventWithVersion(
  transaction: TenantTransaction,
  organizationId: string,
  ownerUserId: string,
  eventId: string,
  expectedVersion: number,
) {
  const [row] = await transaction
    .delete(calendarEvents)
    .where(and(
      eq(calendarEvents.organizationId, organizationId),
      eq(calendarEvents.ownerUserId, ownerUserId),
      eq(calendarEvents.id, eventId),
      eq(calendarEvents.version, expectedVersion),
    ))
    .returning({ id: calendarEvents.id })
  return row ?? null
}

// ── Occurrences ──────────────────────────────────────────────────────────────────────────────

export async function listOccurrencesInRange(
  transaction: TenantTransaction,
  organizationId: string,
  range: { from: Date; to: Date },
) {
  return transaction
    .select(occurrenceColumns)
    .from(calendarEventOccurrences)
    .where(and(
      eq(calendarEventOccurrences.organizationId, organizationId),
      lt(calendarEventOccurrences.startsAt, range.to),
      gte(calendarEventOccurrences.endsAt, range.from),
    ))
    .orderBy(asc(calendarEventOccurrences.startsAt))
}

/**
 * Idempotent materialization keyed on the table's `(organization_id, event_id, recurrence_id)`
 * identity — re-running the worker for the same window updates the existing rows instead of
 * duplicating them.
 */
export async function upsertOccurrences(
  transaction: TenantTransaction,
  rows: {
    organizationId: string
    eventId: string
    recurrenceId: string
    startsAt: Date
    endsAt: Date
    status: string
    materializationVersion: number
  }[],
) {
  if (rows.length === 0) return []
  return transaction
    .insert(calendarEventOccurrences)
    .values(rows)
    .onConflictDoUpdate({
      target: [calendarEventOccurrences.organizationId, calendarEventOccurrences.eventId, calendarEventOccurrences.recurrenceId],
      set: {
        startsAt: sql`excluded.starts_at`,
        endsAt: sql`excluded.ends_at`,
        status: sql`excluded.status`,
        materializationVersion: sql`excluded.materialization_version`,
        updatedAt: new Date(),
      },
    })
    .returning(occurrenceColumns)
}

export async function deleteOccurrencesForEvent(transaction: TenantTransaction, organizationId: string, eventId: string) {
  return transaction
    .delete(calendarEventOccurrences)
    .where(and(eq(calendarEventOccurrences.organizationId, organizationId), eq(calendarEventOccurrences.eventId, eventId)))
    .returning({ id: calendarEventOccurrences.id })
}

// ── Participants ─────────────────────────────────────────────────────────────────────────────

export async function listParticipants(transaction: TenantTransaction, organizationId: string, eventId: string) {
  return transaction
    .select(participantColumns)
    .from(eventParticipants)
    .where(and(eq(eventParticipants.organizationId, organizationId), eq(eventParticipants.eventId, eventId)))
    .orderBy(asc(eventParticipants.id))
}

export async function insertParticipants(
  transaction: TenantTransaction,
  rows: {
    organizationId: string
    eventId: string
    eventOwnerUserId: string
    userId?: string | null
    externalEmail?: string | null
    displayName?: string | null
    role: string
    accessGranted: boolean
  }[],
) {
  if (rows.length === 0) return []
  return transaction
    .insert(eventParticipants)
    .values(rows.map((row) => ({
      organizationId: row.organizationId,
      eventId: row.eventId,
      eventOwnerUserId: row.eventOwnerUserId,
      userId: row.userId ?? null,
      externalEmail: row.externalEmail ?? null,
      displayName: row.displayName ?? null,
      role: row.role,
      accessGranted: row.accessGranted,
    })))
    .returning(participantColumns)
}

/** A participant RSVPs to their own row — scoped by `userId`, so it can never touch another attendee's response. */
export async function updateOwnParticipantResponse(
  transaction: TenantTransaction,
  organizationId: string,
  eventId: string,
  userId: string,
  response: string,
) {
  const [row] = await transaction
    .update(eventParticipants)
    .set({ response, respondedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(eventParticipants.organizationId, organizationId),
      eq(eventParticipants.eventId, eventId),
      eq(eventParticipants.userId, userId),
    ))
    .returning(participantColumns)
  return row ?? null
}

/** Whether `userId` has explicit, access-granted participation — the read gate the RLS policy also enforces. */
export async function hasGrantedParticipation(
  transaction: TenantTransaction,
  organizationId: string,
  eventId: string,
  userId: string,
) {
  const [row] = await transaction
    .select({ id: eventParticipants.id })
    .from(eventParticipants)
    .where(and(
      eq(eventParticipants.organizationId, organizationId),
      eq(eventParticipants.eventId, eventId),
      eq(eventParticipants.userId, userId),
      eq(eventParticipants.accessGranted, true),
    ))
    .limit(1)
  return Boolean(row)
}

// ── Reminders ────────────────────────────────────────────────────────────────────────────────

export async function listRemindersForEvent(transaction: TenantTransaction, organizationId: string, eventId: string) {
  return transaction
    .select(reminderColumns)
    .from(calendarEventReminders)
    .where(and(eq(calendarEventReminders.organizationId, organizationId), eq(calendarEventReminders.eventId, eventId)))
    .orderBy(asc(calendarEventReminders.offsetMinutes))
}

export async function insertReminders(
  transaction: TenantTransaction,
  rows: {
    organizationId: string
    eventId: string
    participantId?: string | null
    channel: string
    offsetMinutes: number
    nextFireAt?: Date | null
  }[],
) {
  if (rows.length === 0) return []
  return transaction
    .insert(calendarEventReminders)
    .values(rows.map((row) => ({
      organizationId: row.organizationId,
      eventId: row.eventId,
      participantId: row.participantId ?? null,
      channel: row.channel,
      offsetMinutes: row.offsetMinutes,
      nextFireAt: row.nextFireAt ?? null,
    })))
    .returning(reminderColumns)
}

/** Worker sweep: reminders that are due, still pending, and still enabled. Org-scoped only — the worker has no session user. */
export async function listDueReminders(transaction: TenantTransaction, organizationId: string, now: Date, limit: number) {
  return transaction
    .select(reminderColumns)
    .from(calendarEventReminders)
    .where(and(
      eq(calendarEventReminders.organizationId, organizationId),
      eq(calendarEventReminders.state, 'pending'),
      eq(calendarEventReminders.enabled, true),
      lte(calendarEventReminders.nextFireAt, now),
    ))
    .orderBy(asc(calendarEventReminders.nextFireAt))
    .limit(limit)
}

export async function markReminderState(
  transaction: TenantTransaction,
  organizationId: string,
  reminderId: string,
  state: string,
  errorCode?: string | null,
) {
  const [row] = await transaction
    .update(calendarEventReminders)
    .set({
      state,
      lastErrorCode: errorCode ?? null,
      attempts: sql`${calendarEventReminders.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(calendarEventReminders.organizationId, organizationId), eq(calendarEventReminders.id, reminderId)))
    .returning(reminderColumns)
  return row ?? null
}

/**
 * Re-arms every still-pending reminder against a new event start.
 *
 * Without this, rescheduling an event leaves each reminder's `nextFireAt` pinned to the ORIGINAL
 * start, so a meeting moved from Tuesday to Friday still fires its "in 15 minutes" reminder on
 * Tuesday. The offset is the durable intent; the absolute fire time is derived from it, so it has
 * to be recomputed whenever the thing it is derived from moves.
 */
export async function rearmRemindersForEvent(
  transaction: TenantTransaction,
  organizationId: string,
  eventId: string,
  startsAt: Date,
) {
  return transaction
    .update(calendarEventReminders)
    .set({
      nextFireAt: sql`${startsAt.toISOString()}::timestamptz - make_interval(mins => ${calendarEventReminders.offsetMinutes})`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(calendarEventReminders.organizationId, organizationId),
      eq(calendarEventReminders.eventId, eventId),
      eq(calendarEventReminders.state, 'pending'),
    ))
    .returning({ id: calendarEventReminders.id, nextFireAt: calendarEventReminders.nextFireAt })
}

/** spec.md: reminders "never resend after event cancellation or recipient removal". */
export async function cancelRemindersForEvent(transaction: TenantTransaction, organizationId: string, eventId: string) {
  return transaction
    .update(calendarEventReminders)
    .set({ state: 'cancelled', updatedAt: new Date() })
    .where(and(
      eq(calendarEventReminders.organizationId, organizationId),
      eq(calendarEventReminders.eventId, eventId),
      eq(calendarEventReminders.state, 'pending'),
    ))
    .returning({ id: calendarEventReminders.id })
}

// ── Notification deliveries ──────────────────────────────────────────────────────────────────

export async function listOwnDeliveries(
  transaction: TenantTransaction,
  organizationId: string,
  recipientUserId: string,
  limit: number,
) {
  return transaction
    .select(deliveryColumns)
    .from(calendarNotificationDeliveries)
    .where(and(
      eq(calendarNotificationDeliveries.organizationId, organizationId),
      eq(calendarNotificationDeliveries.recipientUserId, recipientUserId),
    ))
    .orderBy(asc(calendarNotificationDeliveries.createdAt))
    .limit(limit)
}

export async function countUnreadDeliveries(transaction: TenantTransaction, organizationId: string, recipientUserId: string) {
  const [row] = await transaction
    .select({ count: sql<number>`count(*)::int` })
    .from(calendarNotificationDeliveries)
    .where(and(
      eq(calendarNotificationDeliveries.organizationId, organizationId),
      eq(calendarNotificationDeliveries.recipientUserId, recipientUserId),
      sql`${calendarNotificationDeliveries.readAt} is null`,
    ))
  return row?.count ?? 0
}

/** Marks an explicit allowlist of the caller's OWN delivery IDs read — never a blanket "mark all". */
export async function markDeliveriesRead(
  transaction: TenantTransaction,
  organizationId: string,
  recipientUserId: string,
  deliveryIds: string[],
) {
  if (deliveryIds.length === 0) return []
  return transaction
    .update(calendarNotificationDeliveries)
    .set({ readAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(calendarNotificationDeliveries.organizationId, organizationId),
      eq(calendarNotificationDeliveries.recipientUserId, recipientUserId),
      inArray(calendarNotificationDeliveries.id, deliveryIds),
    ))
    .returning({ id: calendarNotificationDeliveries.id })
}

/** Idempotent by `idempotencyKey` — a retried worker run returns the existing row rather than double-sending. */
export async function insertDeliveryIfAbsent(
  transaction: TenantTransaction,
  input: {
    organizationId: string
    eventId: string
    reminderId?: string | null
    kind: string
    recipientUserId?: string | null
    externalRecipientHash?: string | null
    idempotencyKey: string
  },
) {
  const [row] = await transaction
    .insert(calendarNotificationDeliveries)
    .values({
      organizationId: input.organizationId,
      eventId: input.eventId,
      reminderId: input.reminderId ?? null,
      kind: input.kind,
      recipientUserId: input.recipientUserId ?? null,
      externalRecipientHash: input.externalRecipientHash ?? null,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({ target: calendarNotificationDeliveries.idempotencyKey })
    .returning(deliveryColumns)
  return row ?? null
}

/** Busy ranges for availability subtraction: confirmed/scheduled, busy-flagged events only. */
export async function listBusyRanges(
  transaction: TenantTransaction,
  organizationId: string,
  ownerUserId: string,
  range: { from: Date; to: Date },
) {
  return transaction
    .select({ start: calendarEvents.startsAt, end: calendarEvents.endsAt })
    .from(calendarEvents)
    .where(and(
      eq(calendarEvents.organizationId, organizationId),
      eq(calendarEvents.ownerUserId, ownerUserId),
      eq(calendarEvents.busy, true),
      or(eq(calendarEvents.status, 'scheduled'), eq(calendarEvents.status, 'confirmed'), eq(calendarEvents.status, 'in_progress')),
      lt(calendarEvents.startsAt, range.to),
      gte(calendarEvents.endsAt, range.from),
    ))
    .orderBy(asc(calendarEvents.startsAt))
}
