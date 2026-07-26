/**
 * Closed domain contracts and state machine for the tenant calendar (plan:
 * calendar-scheduling-interview-intelligence, spec.md "Data model" → "Calendar and scheduling",
 * "State contracts", and "Calendar projection contract"). Every persisted or route-facing shape
 * is a strict Zod schema (`.strict()` everywhere) matching `solutions/contracts.ts`'s convention.
 *
 * Pure — no I/O. Routes call the transition/plan functions here instead of writing state columns
 * directly (spec.md: "Only domain transition functions change state. Routes cannot update state
 * columns directly.").
 */
import { z } from 'zod'
// `rrule` ships CommonJS. A named import resolves under vitest but throws
// "Named export 'RRule' not found" in Vite's SSR runtime, so the page 500s while tests pass —
// import the default and destructure.
import rrulePkg from 'rrule'

const { RRule } = rrulePkg

export class CalendarEventError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'CalendarEventError'
  }
}

// ── Event type, visibility, and status (spec.md "State contracts" → Appointment machine) ────

export const CALENDAR_EVENT_TYPES = ['personal', 'interview'] as const
export type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number]

// spec.md: "private-only visibility" — calendar_events.visibility is fixed, never user-choosable.
export const CALENDAR_EVENT_VISIBILITY = 'private' as const
export const eventVisibilitySchema = z.literal(CALENDAR_EVENT_VISIBILITY)

export const CALENDAR_EVENT_STATUSES = [
  'scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'rescheduled', 'no_show',
] as const
export type CalendarEventStatus = (typeof CALENDAR_EVENT_STATUSES)[number]

const CALENDAR_EVENT_STATUS_TRANSITIONS: Record<CalendarEventStatus, readonly CalendarEventStatus[]> = {
  scheduled: ['confirmed', 'cancelled'],
  confirmed: ['in_progress', 'cancelled', 'rescheduled', 'no_show'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  rescheduled: [],
  no_show: [],
}

/** Every valid (from, to) pair for `CALENDAR_EVENT_STATUSES`. */
export function assertValidEventStatusTransition(from: CalendarEventStatus, to: CalendarEventStatus): void {
  if (!CALENDAR_EVENT_STATUS_TRANSITIONS[from].includes(to)) {
    throw new CalendarEventError(`Cannot transition a calendar event from '${from}' to '${to}'`, 'invalid_state_transition')
  }
}

/** spec.md: "Event mutation uses optimistic `version`; stale writes return `409 event_changed`." */
export function assertMatchingEventVersion(current: number, expected: number): void {
  if (current !== expected) {
    throw new CalendarEventError(`Event was modified since it was loaded (expected version ${expected}, found ${current})`, 'event_changed')
  }
}

// ── Participants (spec.md: "internal user or external contact, participant role, response") ─

export const EVENT_PARTICIPANT_ROLES = ['organizer', 'attendee'] as const
export type EventParticipantRole = (typeof EVENT_PARTICIPANT_ROLES)[number]

export const EVENT_PARTICIPANT_RESPONSES = ['needs_action', 'accepted', 'declined', 'tentative'] as const
export type EventParticipantResponse = (typeof EVENT_PARTICIPANT_RESPONSES)[number]

/** Exactly one of `userId`/`externalEmail` — matches the table's "exactly one of `user_id` or `external_email`" invariant. */
const participantIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('internal'), userId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('external'), externalEmail: z.string().email() }).strict(),
])
export type ParticipantIdentity = z.infer<typeof participantIdentitySchema>

export const eventParticipantSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  identity: participantIdentitySchema,
  displayName: z.string().min(1).max(200).nullable(),
  role: z.enum(EVENT_PARTICIPANT_ROLES),
  response: z.enum(EVENT_PARTICIPANT_RESPONSES),
  accessGranted: z.boolean(),
  respondedAt: z.string().datetime().nullable(),
}).strict()
export type EventParticipant = z.infer<typeof eventParticipantSchema>

/** Never leaks `userId`/`externalEmail` to a non-owner viewer — only what an attendee chip or `.ics` line needs. */
export const eventParticipantPublicDtoSchema = z.object({
  displayName: z.string().min(1).max(200).nullable(),
  role: z.enum(EVENT_PARTICIPANT_ROLES),
  response: z.enum(EVENT_PARTICIPANT_RESPONSES),
}).strict()
export type EventParticipantPublicDto = z.infer<typeof eventParticipantPublicDtoSchema>

export function toEventParticipantPublicDto(participant: EventParticipant): EventParticipantPublicDto {
  return {
    displayName: participant.displayName,
    role: participant.role,
    response: participant.response,
  }
}

// ── Reminders and notification deliveries ────────────────────────────────────────────────────

export const REMINDER_CHANNELS = ['email', 'in_app'] as const
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number]

/** spec.md: "0, 5, 10, 15, 30, 60, 1440, or 10080 minutes before start." */
export const REMINDER_OFFSET_MINUTES = [0, 5, 10, 15, 30, 60, 1440, 10080] as const
export type ReminderOffsetMinutes = (typeof REMINDER_OFFSET_MINUTES)[number]

export function isSupportedReminderOffset(minutes: number): minutes is ReminderOffsetMinutes {
  return (REMINDER_OFFSET_MINUTES as readonly number[]).includes(minutes)
}

const reminderOffsetSchema = z.number().int().refine(isSupportedReminderOffset, {
  message: `Reminder offset must be one of ${REMINDER_OFFSET_MINUTES.join(', ')} minutes`,
})

export const REMINDER_STATES = ['pending', 'sent', 'failed', 'cancelled'] as const
export type ReminderState = (typeof REMINDER_STATES)[number]

export const eventReminderSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  participantId: z.string().uuid().nullable(),
  channel: z.enum(REMINDER_CHANNELS),
  offsetMinutes: reminderOffsetSchema,
  enabled: z.boolean(),
  nextFireAt: z.string().datetime().nullable(),
  state: z.enum(REMINDER_STATES),
  attempts: z.number().int().nonnegative(),
  lastErrorCode: z.string().nullable(),
}).strict()
export type EventReminder = z.infer<typeof eventReminderSchema>

export const NOTIFICATION_DELIVERY_KINDS = ['reminder', 'invitation', 'reschedule', 'cancellation'] as const
export type NotificationDeliveryKind = (typeof NOTIFICATION_DELIVERY_KINDS)[number]

export const NOTIFICATION_DELIVERY_STATES = ['pending', 'sent', 'failed'] as const
export type NotificationDeliveryState = (typeof NOTIFICATION_DELIVERY_STATES)[number]

/** Exactly one recipient form — matches the table's "exactly one recipient form" invariant. */
const deliveryRecipientSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('internal'), recipientUserId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('external'), externalRecipientHash: z.string().min(1) }).strict(),
])

export const notificationDeliverySchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  reminderId: z.string().uuid().nullable(),
  kind: z.enum(NOTIFICATION_DELIVERY_KINDS),
  recipient: deliveryRecipientSchema,
  idempotencyKey: z.string().min(1),
  providerReference: z.string().nullable(),
  state: z.enum(NOTIFICATION_DELIVERY_STATES),
  attemptedAt: z.string().datetime().nullable(),
  deliveredAt: z.string().datetime().nullable(),
  readAt: z.string().datetime().nullable(),
  errorCode: z.string().nullable(),
}).strict()
export type NotificationDelivery = z.infer<typeof notificationDeliverySchema>

// ── Occurrences (spec.md: "deterministic materialization for range reads, conflict checks") ─

export const CALENDAR_EVENT_OCCURRENCE_STATUSES = ['active', 'cancelled'] as const
export type CalendarEventOccurrenceStatus = (typeof CALENDAR_EVENT_OCCURRENCE_STATUSES)[number]

const eventOccurrenceObjectSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  recurrenceId: z.string().min(1),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  status: z.enum(CALENDAR_EVENT_OCCURRENCE_STATUSES),
  materializationVersion: z.number().int().nonnegative(),
}).strict()

export const eventOccurrenceSchema = eventOccurrenceObjectSchema.refine(
  (occurrence) => new Date(occurrence.endsAt) > new Date(occurrence.startsAt),
  { message: 'endsAt must be after startsAt', path: ['endsAt'] },
)
export type EventOccurrence = z.infer<typeof eventOccurrenceObjectSchema>

// ── Half-open range overlap (spec.md: "Persist instants...", conflict checks) ───────────────

/** Half-open `[start, end)` overlap — an event ending exactly when another starts does not conflict. */
export function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd
}

// ── Recurrence rule (spec.md: "supported RFC 5545 subset ... Unsupported rules are rejected, not approximated") ─

const SUPPORTED_RRULE_KEYS = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'COUNT', 'UNTIL'])
const SUPPORTED_RRULE_FREQUENCIES = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])

/** Throws with `code: 'invalid_input'` on anything outside the supported subset — never silently approximates an unsupported rule. */
export function assertSupportedRecurrenceRule(rruleText: string): void {
  const body = rruleText.replace(/^RRULE:/i, '')
  const parts = body.split(';').filter(Boolean)
  if (parts.length === 0) {
    throw new CalendarEventError('Recurrence rule must not be empty', 'invalid_input')
  }
  let hasFreq = false
  for (const part of parts) {
    const [key, value] = part.split('=')
    if (!key || value === undefined || value === '') {
      throw new CalendarEventError(`Malformed recurrence rule segment: ${part}`, 'invalid_input')
    }
    const upperKey = key.toUpperCase()
    if (!SUPPORTED_RRULE_KEYS.has(upperKey)) {
      throw new CalendarEventError(`Unsupported recurrence rule property: ${key}`, 'invalid_input')
    }
    if (upperKey === 'FREQ' && !SUPPORTED_RRULE_FREQUENCIES.has(value.toUpperCase())) {
      throw new CalendarEventError(`Unsupported recurrence frequency: ${value}`, 'invalid_input')
    }
    if (upperKey === 'FREQ') hasFreq = true
  }
  if (!hasFreq) {
    throw new CalendarEventError('Recurrence rule must include FREQ', 'invalid_input')
  }
  try {
    RRule.parseString(body)
  } catch (error) {
    throw new CalendarEventError(`Invalid recurrence rule: ${error instanceof Error ? error.message : String(error)}`, 'invalid_input')
  }
}

// ── Recurrence mutation scope and split guard (spec.md: "this occurrence, this and following, entire series") ─

export const RECURRENCE_MUTATION_SCOPES = ['this', 'following', 'series'] as const
export type RecurrenceMutationScope = (typeof RECURRENCE_MUTATION_SCOPES)[number]

export type RecurrenceMutationPlan =
  | { kind: 'single_occurrence_exception'; recurrenceId: string }
  | { kind: 'truncate_and_link_successor'; recurrenceId: string }
  | { kind: 'rematerialize_series' }

/**
 * `this` creates an occurrence-level exception/override; `following` truncates the old series
 * and creates a linked successor; `series` increments the series version and rematerializes.
 */
export function resolveRecurrenceMutationPlan(params: { scope: RecurrenceMutationScope; recurrenceId: string | null }): RecurrenceMutationPlan {
  const { scope, recurrenceId } = params
  if (scope === 'series') return { kind: 'rematerialize_series' }
  if (!recurrenceId) {
    throw new CalendarEventError(`Recurrence scope '${scope}' requires an occurrence recurrenceId`, 'invalid_input')
  }
  return scope === 'this'
    ? { kind: 'single_occurrence_exception', recurrenceId }
    : { kind: 'truncate_and_link_successor', recurrenceId }
}

// ── Calendar event (spec.md: normative persistence contract, calendar_events row) ───────────

const eventObjectSchema = z.object({
  id: z.string().uuid(),
  calendarId: z.string().uuid(),
  ownerUserId: z.string().min(1),
  type: z.enum(CALENDAR_EVENT_TYPES),
  status: z.enum(CALENDAR_EVENT_STATUSES),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).nullable(),
  location: z.string().max(500).nullable(),
  meetingUrl: z.string().url().nullable(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  timezone: z.string().min(1),
  allDay: z.boolean(),
  busy: z.boolean(),
  visibility: eventVisibilitySchema,
  rrule: z.string().nullable(),
  recurrenceUntil: z.string().datetime().nullable(),
  version: z.number().int().positive(),
  sourceType: z.string().nullable(),
  sourceId: z.string().nullable(),
  cancelledAt: z.string().datetime().nullable(),
}).strict()

export const eventSchema = eventObjectSchema
  .refine((event) => new Date(event.endsAt) > new Date(event.startsAt), { message: 'endsAt must be after startsAt', path: ['endsAt'] })
  .refine((event) => (event.sourceType === null) === (event.sourceId === null), { message: 'sourceType and sourceId must be null together', path: ['sourceId'] })
export type CalendarEvent = z.infer<typeof eventObjectSchema>

const eventDraftReminderInputSchema = z.object({
  channel: z.enum(REMINDER_CHANNELS),
  offsetMinutes: reminderOffsetSchema,
}).strict()

const eventDraftParticipantInputSchema = z.object({
  identity: participantIdentitySchema,
  displayName: z.string().min(1).max(200).optional(),
  role: z.enum(EVENT_PARTICIPANT_ROLES),
}).strict()

const eventDraftObjectSchema = z.object({
  type: z.enum(CALENDAR_EVENT_TYPES),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  location: z.string().max(500).optional(),
  meetingUrl: z.string().url().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  timezone: z.string().min(1),
  allDay: z.boolean(),
  busy: z.boolean(),
  rrule: z.string().optional(),
  recurrenceUntil: z.string().datetime().optional(),
  reminders: z.array(eventDraftReminderInputSchema).max(20),
  participants: z.array(eventDraftParticipantInputSchema).max(50),
}).strict()

export const eventDraftInputSchema = eventDraftObjectSchema.refine(
  (draft) => new Date(draft.endsAt) > new Date(draft.startsAt),
  { message: 'endsAt must be after startsAt', path: ['endsAt'] },
)
export type EventDraftInput = z.infer<typeof eventDraftObjectSchema>

export const eventMutationInputSchema = z.object({
  version: z.number().int().positive(),
  recurrenceScope: z.enum(RECURRENCE_MUTATION_SCOPES).optional(),
  recurrenceId: z.string().min(1).optional(),
  patch: eventDraftObjectSchema.partial(),
}).strict()
export type EventMutationInput = z.infer<typeof eventMutationInputSchema>

// ── Search and export filters (spec.md: "Search filters title, participant, event type, and date range") ─

const dateRangeShape = {
  from: z.string().datetime(),
  to: z.string().datetime(),
}

export const calendarSearchFilterSchema = z.object({
  title: z.string().max(200).optional(),
  participant: z.string().max(200).optional(),
  eventType: z.enum(CALENDAR_EVENT_TYPES).optional(),
  ...dateRangeShape,
}).strict().refine((filter) => new Date(filter.to) > new Date(filter.from), { message: 'to must be after from', path: ['to'] })
export type CalendarSearchFilter = z.infer<typeof calendarSearchFilterSchema>

export const calendarExportFilterSchema = z.object({
  ...dateRangeShape,
}).strict().refine((filter) => new Date(filter.to) > new Date(filter.from), { message: 'to must be after from', path: ['to'] })
export type CalendarExportFilter = z.infer<typeof calendarExportFilterSchema>

// ── Feed projection contract (spec.md "Calendar projection contract") ───────────────────────
// A discriminated union of editable internal events and four read-only, non-draggable
// projections. Projection items are never copied into `calendar_events` and always carry
// `editable: false` so the client can never mistake one for a mutable event.

export const CALENDAR_FEED_ITEM_KINDS = ['event', 'job_projection', 'alert_projection', 'job_run', 'alert_result'] as const
export type CalendarFeedItemKind = (typeof CALENDAR_FEED_ITEM_KINDS)[number]

const feedEventItemSchema = eventObjectSchema.extend({
  kind: z.literal('event'),
  editable: z.literal(true),
}).strict()

const feedProjectionBaseShape = {
  sourceType: z.string().min(1),
  sourceId: z.string().min(1),
  editable: z.literal(false),
  title: z.string().min(1),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  safeSourceRoute: z.string().min(1),
}

const feedJobProjectionItemSchema = z.object({
  ...feedProjectionBaseShape,
  kind: z.literal('job_projection'),
  estimateOnly: z.literal(true),
}).strict()

const feedAlertProjectionItemSchema = z.object({
  ...feedProjectionBaseShape,
  kind: z.literal('alert_projection'),
  estimateOnly: z.literal(true),
}).strict()

const feedJobRunItemSchema = z.object({
  ...feedProjectionBaseShape,
  kind: z.literal('job_run'),
  estimateOnly: z.literal(false),
  state: z.string().min(1),
}).strict()

const feedAlertResultItemSchema = z.object({
  ...feedProjectionBaseShape,
  kind: z.literal('alert_result'),
  estimateOnly: z.literal(false),
  matchCount: z.number().int().nonnegative(),
}).strict()

export const calendarFeedItemSchema = z.discriminatedUnion('kind', [
  feedEventItemSchema,
  feedJobProjectionItemSchema,
  feedAlertProjectionItemSchema,
  feedJobRunItemSchema,
  feedAlertResultItemSchema,
])
export type CalendarFeedItem = z.infer<typeof calendarFeedItemSchema>

export const calendarFeedResponseSchema = z.object({
  items: z.array(calendarFeedItemSchema),
  generatedAt: z.string().datetime(),
  staleSources: z.array(z.string()),
}).strict()
export type CalendarFeedResponse = z.infer<typeof calendarFeedResponseSchema>
