/**
 * Timezone-correct availability, recurrence expansion, and scheduling-invitation/consent
 * contracts (plan: calendar-scheduling-interview-intelligence, spec.md "Data model" →
 * "Calendar and scheduling", "Scheduling correctness", "State contracts" → Invitation, and
 * "Consent, privacy, and retention"). Pure — no I/O. Uses `@js-temporal/polyfill` for every
 * local-wall-clock <-> instant conversion (never hand-rolled offset math) and `rrule` for RFC 5545
 * expansion (paired with `calendar.ts`'s `assertSupportedRecurrenceRule`, which this module
 * reuses rather than re-validating the same subset).
 */
import { createHash } from 'node:crypto'
import { Temporal } from '@js-temporal/polyfill'
import { z } from 'zod'
// CommonJS default import — see the note in `calendar.ts`.
import rrulePkg from 'rrule'

const { rrulestr } = rrulePkg
import { assertSupportedRecurrenceRule, rangesOverlap } from './calendar'

export class SchedulingError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'SchedulingError'
  }
}

// ── IANA timezone validation ─────────────────────────────────────────────────────────────────

export function isValidIanaTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone })
    return true
  } catch {
    return false
  }
}

const timeZoneSchema = z.string().min(1).refine(isValidIanaTimeZone, { message: 'Must be a valid IANA timezone identifier' })

// ── Local wall-clock <-> instant resolution (spec.md: "Omit nonexistent DST times and label/disambiguate repeated times") ─

export interface LocalWallClockFields {
  timeZone: string
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

export type LocalWallClockResolution =
  | { kind: 'nonexistent' }
  | { kind: 'ambiguous'; instant: Date; earlierInstant: Date; laterInstant: Date }
  | { kind: 'unique'; instant: Date }

/**
 * Resolves a local wall-clock time to a real instant, distinguishing three DST cases:
 * - `nonexistent`: the wall-clock time falls in a spring-forward gap and never occurred — the
 *   caller must omit it, never silently shift it to a neighboring time.
 * - `ambiguous`: the wall-clock time occurs twice (fall-back) — resolved deterministically to
 *   the earlier (standard-time-preceding) occurrence, matching `Temporal`'s `'compatible'`
 *   disambiguation, with both candidate instants returned so a caller can label it if it wants to.
 * - `unique`: the ordinary case.
 */
export function resolveLocalWallClockInstant(fields: LocalWallClockFields): LocalWallClockResolution {
  const base = { timeZone: fields.timeZone, year: fields.year, month: fields.month, day: fields.day, hour: fields.hour, minute: fields.minute }
  const compatible = Temporal.ZonedDateTime.from(base, { disambiguation: 'compatible' })
  const wallClockPreserved = compatible.hour === fields.hour && compatible.minute === fields.minute && compatible.day === fields.day
  if (!wallClockPreserved) {
    return { kind: 'nonexistent' }
  }
  const earlier = Temporal.ZonedDateTime.from(base, { disambiguation: 'earlier' })
  const later = Temporal.ZonedDateTime.from(base, { disambiguation: 'later' })
  if (earlier.epochNanoseconds !== later.epochNanoseconds) {
    return {
      kind: 'ambiguous',
      instant: new Date(compatible.epochMilliseconds),
      earlierInstant: new Date(earlier.epochMilliseconds),
      laterInstant: new Date(later.epochMilliseconds),
    }
  }
  return { kind: 'unique', instant: new Date(compatible.epochMilliseconds) }
}

function instantToZonedFields(instant: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const zdt = Temporal.Instant.fromEpochMilliseconds(instant.getTime()).toZonedDateTimeISO(timeZone)
  return { year: zdt.year, month: zdt.month, day: zdt.day, hour: zdt.hour, minute: zdt.minute, second: zdt.second }
}

// ── Availability rules and overrides (spec.md: normative persistence contract) ──────────────

const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

function timeToMinutes(hhmm: string): number {
  const [hours, minutes] = hhmm.split(':').map(Number)
  return hours * 60 + minutes
}

const availabilityRuleObjectSchema = z.object({
  ownerUserId: z.string().min(1),
  timeZone: timeZoneSchema,
  weekdays: z.array(z.number().int().min(0).max(6)).min(1),
  localStart: z.string().regex(HHMM_PATTERN),
  localEnd: z.string().regex(HHMM_PATTERN),
  slotMinutes: z.number().int().positive(),
  bufferBeforeMinutes: z.number().int().nonnegative(),
  bufferAfterMinutes: z.number().int().nonnegative(),
  minNoticeMinutes: z.number().int().nonnegative(),
  horizonDays: z.number().int().positive(),
  enabled: z.boolean(),
}).strict()

/** "no overnight rule" (spec.md) — localEnd must fall strictly after localStart on the same day. */
export const availabilityRuleSchema = availabilityRuleObjectSchema.refine(
  (rule) => timeToMinutes(rule.localEnd) > timeToMinutes(rule.localStart),
  { message: 'localEnd must be after localStart — overnight availability rules are not supported', path: ['localEnd'] },
)
export type AvailabilityRule = z.infer<typeof availabilityRuleObjectSchema>

export const AVAILABILITY_OVERRIDE_KINDS = ['available', 'blocked'] as const
export type AvailabilityOverrideKind = (typeof AVAILABILITY_OVERRIDE_KINDS)[number]

const availabilityOverrideObjectSchema = z.object({
  ownerUserId: z.string().min(1),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  localStart: z.string().regex(HHMM_PATTERN).nullable(),
  localEnd: z.string().regex(HHMM_PATTERN).nullable(),
  kind: z.enum(AVAILABILITY_OVERRIDE_KINDS),
  timeZone: timeZoneSchema,
}).strict()

/** "blocked-day rows have null times, available rows require valid times" (spec.md). */
export const availabilityOverrideSchema = availabilityOverrideObjectSchema.refine(
  (override) => {
    if (override.kind === 'blocked') return override.localStart === null && override.localEnd === null
    return (
      override.localStart !== null &&
      override.localEnd !== null &&
      timeToMinutes(override.localEnd) > timeToMinutes(override.localStart)
    )
  },
  { message: 'blocked overrides must have null times; available overrides require localEnd after localStart', path: ['kind'] },
)
export type AvailabilityOverride = z.infer<typeof availabilityOverrideObjectSchema>

// ── Deterministic slot IDs (spec.md: "opaque slot IDs/start/end only") ──────────────────────

/** Deterministic and opaque — recomputing the same owner/instant pair always yields the same ID, so a race-loser's re-fetch and the original candidate slot compare equal without leaking their components. */
export function computeSlotId(ownerUserId: string, startsAt: Date, endsAt: Date): string {
  return createHash('sha256').update(`${ownerUserId}|${startsAt.toISOString()}|${endsAt.toISOString()}`).digest('hex').slice(0, 32)
}

export interface AvailabilitySlot {
  slotId: string
  startsAt: Date
  endsAt: Date
  ambiguousLocalTime: boolean
}

// ── Busy-range subtraction (reuses calendar.ts's half-open overlap helper) ──────────────────

export function subtractBusyRanges<T extends { startsAt: Date; endsAt: Date }>(
  candidates: T[],
  busyRanges: { start: Date; end: Date }[],
): T[] {
  return candidates.filter((candidate) => !busyRanges.some((busy) => rangesOverlap(candidate.startsAt, candidate.endsAt, busy.start, busy.end)))
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000)
}

// ── Slot generation ──────────────────────────────────────────────────────────────────────────

export interface GenerateAvailabilitySlotsParams {
  ownerUserId: string
  rule: AvailabilityRule
  overrides: AvailabilityOverride[]
  busyRanges: { start: Date; end: Date }[]
  rangeFrom: Date
  rangeTo: Date
  now: Date
}

/**
 * Subtracts busy occurrences (expanded by the rule's buffers), overrides, minimum notice, and
 * booking horizon before returning slots (spec.md "Scheduling correctness"). Returns opaque slot
 * IDs/start/end only, sorted chronologically (deterministic ordering) — never the busy range that
 * caused a rejection.
 */
export function generateAvailabilitySlots(params: GenerateAvailabilitySlotsParams): AvailabilitySlot[] {
  const { ownerUserId, rule, overrides, busyRanges, rangeFrom, rangeTo, now } = params
  if (!rule.enabled) return []

  const earliestAllowed = addMinutes(now, rule.minNoticeMinutes)
  const horizonEnd = addMinutes(now, rule.horizonDays * 24 * 60)
  const effectiveFrom = rangeFrom > earliestAllowed ? rangeFrom : earliestAllowed
  const effectiveTo = rangeTo < horizonEnd ? rangeTo : horizonEnd
  if (effectiveTo <= effectiveFrom) return []

  const overridesByDate = new Map(overrides.map((override) => [override.localDate, override]))
  const bufferedBusyRanges = busyRanges.map((range) => ({
    start: addMinutes(range.start, -rule.bufferBeforeMinutes),
    end: addMinutes(range.end, rule.bufferAfterMinutes),
  }))

  const results: AvailabilitySlot[] = []
  const startFields = instantToZonedFields(effectiveFrom, rule.timeZone)
  let cursorDate = Temporal.PlainDate.from({ year: startFields.year, month: startFields.month, day: startFields.day })
  const endFields = instantToZonedFields(effectiveTo, rule.timeZone)
  const lastDate = Temporal.PlainDate.from({ year: endFields.year, month: endFields.month, day: endFields.day })

  // Iterate day-by-day in the rule's timezone — bounded by the effective range, never unbounded.
  while (Temporal.PlainDate.compare(cursorDate, lastDate) <= 0) {
    const localDateKey = cursorDate.toString()
    const override = overridesByDate.get(localDateKey)
    const weekday = cursorDate.dayOfWeek % 7 // Temporal: 1=Monday..7=Sunday -> 0=Sunday..6=Saturday

    let dayStart: string | null = null
    let dayEnd: string | null = null
    if (override) {
      if (override.kind === 'blocked') {
        cursorDate = cursorDate.add({ days: 1 })
        continue
      }
      dayStart = override.localStart
      dayEnd = override.localEnd
    } else if (rule.weekdays.includes(weekday)) {
      dayStart = rule.localStart
      dayEnd = rule.localEnd
    }

    if (dayStart && dayEnd) {
      for (let minute = timeToMinutes(dayStart); minute + rule.slotMinutes <= timeToMinutes(dayEnd); minute += rule.slotMinutes) {
        const resolved = resolveLocalWallClockInstant({
          timeZone: rule.timeZone,
          year: cursorDate.year,
          month: cursorDate.month,
          day: cursorDate.day,
          hour: Math.floor(minute / 60),
          minute: minute % 60,
        })
        if (resolved.kind === 'nonexistent') continue
        const startsAt = resolved.instant
        const endsAt = addMinutes(startsAt, rule.slotMinutes)
        if (startsAt < effectiveFrom || endsAt > effectiveTo) continue
        results.push({
          slotId: computeSlotId(ownerUserId, startsAt, endsAt),
          startsAt,
          endsAt,
          ambiguousLocalTime: resolved.kind === 'ambiguous',
        })
      }
    }
    cursorDate = cursorDate.add({ days: 1 })
  }

  return subtractBusyRanges(results, bufferedBusyRanges).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
}

// ── Recurrence expansion (spec.md: supported RFC 5545 subset, "plus exception dates") ───────

function toFloatingUtcDate(fields: { year: number; month: number; day: number; hour: number; minute: number; second: number }): Date {
  return new Date(Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second))
}

function formatFloatingForRRule(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
}

export interface ExpandRecurrenceRuleParams {
  rruleText: string
  eventStartsAt: Date
  eventDurationMs: number
  timeZone: string
  rangeFrom: Date
  rangeTo: Date
  /** Instants to exclude — a candidate.md "this occurrence" exception is modeled as an exclusion here, not an RRULE EXDATE token. */
  exceptionInstants: Date[]
}

export interface RecurrenceOccurrence {
  startsAt: Date
  endsAt: Date
  recurrenceId: string
  ambiguousLocalTime: boolean
}

/**
 * Expands a validated RRULE into concrete occurrence instants over `[rangeFrom, rangeTo)`,
 * preserving the original local wall-clock time across DST transitions (a 9am local meeting
 * stays 9am local, not a fixed UTC offset) by round-tripping each generated occurrence through
 * the timezone rather than treating `rrule`'s output as already timezone-aware. Nonexistent
 * (spring-forward gap) occurrences are omitted, never approximated.
 */
export function expandRecurrenceRule(params: ExpandRecurrenceRuleParams): RecurrenceOccurrence[] {
  const { rruleText, eventStartsAt, eventDurationMs, timeZone, rangeFrom, rangeTo, exceptionInstants } = params
  assertSupportedRecurrenceRule(rruleText)

  const startFields = instantToZonedFields(eventStartsAt, timeZone)
  const dtStart = toFloatingUtcDate(startFields)
  const rule = rrulestr(`DTSTART:${formatFloatingForRRule(dtStart)}\nRRULE:${rruleText.replace(/^RRULE:/i, '')}`)

  const floatingFrom = toFloatingUtcDate(instantToZonedFields(rangeFrom, timeZone))
  const floatingTo = toFloatingUtcDate(instantToZonedFields(rangeTo, timeZone))
  const floatingOccurrences = rule.between(floatingFrom, floatingTo, true)

  const exceptionKeys = new Set(exceptionInstants.map((instant) => instant.toISOString()))
  const results: RecurrenceOccurrence[] = []
  for (const floating of floatingOccurrences) {
    const resolved = resolveLocalWallClockInstant({
      timeZone,
      year: floating.getUTCFullYear(),
      month: floating.getUTCMonth() + 1,
      day: floating.getUTCDate(),
      hour: floating.getUTCHours(),
      minute: floating.getUTCMinutes(),
    })
    if (resolved.kind === 'nonexistent') continue
    const startsAt = resolved.instant
    if (exceptionKeys.has(startsAt.toISOString())) continue
    results.push({
      startsAt,
      endsAt: new Date(startsAt.getTime() + eventDurationMs),
      recurrenceId: startsAt.toISOString(),
      ambiguousLocalTime: resolved.kind === 'ambiguous',
    })
  }

  return results.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
}

// ── Scheduling invitations (spec.md "State contracts" → Invitation machine) ─────────────────

export const INVITATION_STATUSES = ['draft', 'sent', 'opened', 'booked', 'declined', 'expired', 'revoked'] as const
export type InvitationStatus = (typeof INVITATION_STATUSES)[number]

const INVITATION_STATUS_TRANSITIONS: Record<InvitationStatus, readonly InvitationStatus[]> = {
  draft: ['sent', 'revoked'],
  sent: ['opened', 'expired', 'revoked'],
  opened: ['booked', 'declined', 'expired', 'revoked'],
  booked: [],
  declined: [],
  expired: [],
  revoked: [],
}

export function assertValidInvitationStatusTransition(from: InvitationStatus, to: InvitationStatus): void {
  if (!INVITATION_STATUS_TRANSITIONS[from].includes(to)) {
    throw new SchedulingError(`Cannot transition a scheduling invitation from '${from}' to '${to}'`, 'invalid_state_transition')
  }
}

export const SCHEDULING_MODALITIES = ['in_person', 'remote_call'] as const
export type SchedulingModality = (typeof SCHEDULING_MODALITIES)[number]

// ── Consent receipts (spec.md "Confirmed product decisions" + privacy_consents table) ───────

export const CONSENT_PURPOSES = [
  'terms_and_privacy',
  'candidate_document_processing',
  'public_web_import',
  'ai_interview_assistance',
  'live_audio_transcription',
] as const
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number]

export const CONSENT_DECISIONS = ['accepted', 'declined'] as const
export type ConsentDecision = (typeof CONSENT_DECISIONS)[number]

export const consentReceiptSchema = z.object({
  id: z.string().uuid(),
  invitationId: z.string().uuid(),
  sessionId: z.string().uuid().nullable(),
  subjectEmailHash: z.string().min(1),
  purpose: z.enum(CONSENT_PURPOSES),
  noticeVersion: z.string().min(1),
  decision: z.enum(CONSENT_DECISIONS),
  decidedAt: z.string().datetime(),
  withdrawnAt: z.string().datetime().nullable(),
  requestEvidenceHash: z.string().min(1),
  supersedesId: z.string().uuid().nullable(),
}).strict()
export type ConsentReceipt = z.infer<typeof consentReceiptSchema>

/**
 * `terms_and_privacy` is always required. The three feature-specific purposes are only required
 * when that booking actually invokes the feature (spec.md: "Consent authorizes only the purposes
 * disclosed at booking" — a booking with no document upload never needs document-processing
 * consent).
 */
export function resolveRequiredConsentPurposes(bookingContext: {
  includesDocumentUpload: boolean
  includesWebImport: boolean
  includesAiAssistance: boolean
  includesLiveTranscription: boolean
}): ConsentPurpose[] {
  const required: ConsentPurpose[] = ['terms_and_privacy']
  if (bookingContext.includesDocumentUpload) required.push('candidate_document_processing')
  if (bookingContext.includesWebImport) required.push('public_web_import')
  if (bookingContext.includesAiAssistance) required.push('ai_interview_assistance')
  if (bookingContext.includesLiveTranscription) required.push('live_audio_transcription')
  return required
}

/** spec.md: "The public portal cannot confirm a slot until every required purpose is accepted." */
export function hasAcceptedAllRequiredConsents(
  decisions: { purpose: ConsentPurpose; decision: ConsentDecision }[],
  required: readonly ConsentPurpose[],
): boolean {
  return required.every((purpose) => decisions.some((entry) => entry.purpose === purpose && entry.decision === 'accepted'))
}

// ── Safe public errors (spec.md "Public capability security": "non-enumerating", never reveal internals) ─

const PUBLIC_SCHEDULING_ERROR_CODES = [
  'invalid_input',
  'invitation_unavailable',
  'slot_unavailable',
  'consent_required',
  'rate_limited',
] as const
export type PublicSchedulingErrorCode = (typeof PUBLIC_SCHEDULING_ERROR_CODES)[number]

/** Maps any internal error to the fixed public code set — never leaks org IDs, internal conflicts, or object keys to an unauthenticated caller. */
export function toSafePublicSchedulingErrorCode(code: string): PublicSchedulingErrorCode {
  return (PUBLIC_SCHEDULING_ERROR_CODES as readonly string[]).includes(code)
    ? (code as PublicSchedulingErrorCode)
    : 'invalid_input'
}
