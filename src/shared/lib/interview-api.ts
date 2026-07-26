/**
 * Normative HTTP contract for calendar, scheduling, and interview routes (plan:
 * calendar-scheduling-interview-intelligence, spec.md "HTTP contract"). Every request schema is
 * `.strict()` and never accepts `organizationId`/`ownerUserId`/`provider`/`price`/`credit*` fields
 * — those are always server-derived from the tenant principal, entitlement lookup, or billing
 * platform, never client input. Response schemas reuse the persisted DTOs from `calendar.ts`,
 * `scheduling.ts`, and `interviews.ts` directly; this file adds new schemas only for request
 * shapes (which must omit server authority) and for a few response envelopes those modules don't
 * already define.
 *
 * `INTERVIEW_API_ROUTES` is the single registry every route handler and every contract test walks
 * — adding a route means adding one entry here, not scattering ad hoc Zod objects across route
 * files.
 */
import { z } from 'zod'
import {
  calendarFeedResponseSchema,
  eventDraftInputSchema,
  eventMutationInputSchema,
  eventSchema,
  notificationDeliverySchema,
  RECURRENCE_MUTATION_SCOPES,
} from './calendar'
import {
  AVAILABILITY_OVERRIDE_KINDS,
  CONSENT_DECISIONS,
  CONSENT_PURPOSES,
  INVITATION_STATUSES,
  SCHEDULING_MODALITIES,
} from './scheduling'
import {
  candidateDocumentSchema,
  DOCUMENT_STATUSES,
  interviewFollowupSuggestOutputSchema,
  interviewReportContentSchema,
  interviewReportSchema,
  INTERVIEW_SESSION_STATES,
  SOURCE_KINDS,
  SPEAKER_ESTIMATES,
} from './interviews'
import { INTERVIEW_CAPTURE_CAPABILITIES } from './interview-config'
import type { BillingAvailabilityDto } from './billing/contracts'

export type ApiAuthority = 'user' | 'owner' | 'participant' | 'capability' | 'fragment_capability' | 'role_minimized'

const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

// ── Shared building blocks ───────────────────────────────────────────────────────────────────

const boundedRangeShape = { from: z.string().datetime(), to: z.string().datetime() }

function withBoundedRange<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...shape, ...boundedRangeShape }).strict().refine(
    (v) => new Date((v as { to: string }).to) > new Date((v as { from: string }).from),
    { message: 'to must be after from', path: ['to'] },
  )
}

const paginationRequestSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).default(20),
}).strict()

const idempotencyKeySchema = z.string().min(1).max(200)

// ── GET /api/calendar/feed ────────────────────────────────────────────────────────────────────

export const calendarFeedRequestSchema = withBoundedRange({
  timezone: z.string().min(1),
  layers: z.array(z.enum(['events', 'jobs', 'alerts'])).max(10),
})
export const calendarFeedResponseSchemaRef = calendarFeedResponseSchema

// ── POST /api/calendar/events ────────────────────────────────────────────────────────────────

export const createEventRequestSchema = eventDraftInputSchema
export const createEventResponseSchema = z.object({
  event: eventSchema,
  materializationVersion: z.number().int().nonnegative(),
}).strict()

// ── PATCH/DELETE /api/calendar/events/:id ────────────────────────────────────────────────────

export const mutateEventRequestSchema = eventMutationInputSchema
export const deleteEventRequestSchema = z.object({
  version: z.number().int().positive(),
  recurrenceScope: z.enum(RECURRENCE_MUTATION_SCOPES).optional(),
  recurrenceId: z.string().min(1).optional(),
}).strict()

export const eventMutationResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('updated'), event: eventSchema, materializationVersion: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('tombstoned'), eventId: z.string().uuid() }).strict(),
])

// ── GET/PUT /api/calendar/availability ───────────────────────────────────────────────────────

const availabilityRuleInputSchema = z.object({
  timeZone: z.string().min(1),
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

const availabilityOverrideInputSchema = z.object({
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  localStart: z.string().regex(HHMM_PATTERN).nullable(),
  localEnd: z.string().regex(HHMM_PATTERN).nullable(),
  kind: z.enum(AVAILABILITY_OVERRIDE_KINDS),
  timeZone: z.string().min(1),
}).strict()

export const putAvailabilityRequestSchema = z.object({
  version: z.number().int().positive(),
  rules: z.array(availabilityRuleInputSchema).max(20),
  overrides: z.array(availabilityOverrideInputSchema).max(200),
  defaultReminderOffsets: z.array(z.number().int().nonnegative()).max(10),
  defaultReminderChannels: z.array(z.enum(['email', 'in_app'])).max(2),
}).strict()

export const availabilityPolicyResponseSchema = z.object({
  rules: z.array(availabilityRuleInputSchema),
  overrides: z.array(availabilityOverrideInputSchema),
  defaultReminderOffsets: z.array(z.number().int().nonnegative()),
  defaultReminderChannels: z.array(z.enum(['email', 'in_app'])),
  version: z.number().int().positive(),
}).strict()

// ── GET /api/calendar/export.ics ─────────────────────────────────────────────────────────────

export const exportIcsRequestSchema = withBoundedRange({})
// Response is a raw `.ics` body, not JSON — no response schema by design.

// ── GET/PATCH /api/calendar/notifications ────────────────────────────────────────────────────

export const listNotificationsRequestSchema = paginationRequestSchema
export const listNotificationsResponseSchema = z.object({
  deliveries: z.array(notificationDeliverySchema),
  nextCursor: z.string().min(1).nullable(),
}).strict()

export const markNotificationsReadRequestSchema = z.object({
  deliveryIds: z.array(z.string().uuid()).min(1).max(100),
}).strict()

// ── POST /api/scheduling/invitations ─────────────────────────────────────────────────────────

export const createInvitationRequestSchema = z.object({
  candidateEmail: z.string().email(),
  roleTitle: z.string().min(1).max(200),
  roleContext: z.string().min(1).max(5000),
  durationMinutes: z.number().int().positive().max(480),
  timezone: z.string().min(1),
  modality: z.enum(SCHEDULING_MODALITIES),
  meetingUrl: z.string().url().optional(),
  location: z.string().min(1).max(500).optional(),
  organizationBuilderId: z.string().min(1).optional(),
}).strict()

export const invitationDraftPreviewResponseSchema = z.object({
  roleTitle: z.string(),
  durationMinutes: z.number().int().positive(),
  modality: z.enum(SCHEDULING_MODALITIES),
  availabilityPreview: z.array(z.object({ startsAt: z.string().datetime(), endsAt: z.string().datetime() }).strict()).max(50),
}).strict()

// ── POST /api/scheduling/invitations/:id/send | revoke ───────────────────────────────────────

export const invitationStateChangeRequestSchema = z.object({
  version: z.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
}).strict()

export const invitationStateResponseSchema = z.object({
  invitationId: z.string().uuid(),
  status: z.enum(INVITATION_STATUSES),
  version: z.number().int().positive(),
}).strict()

// ── Public capability routes (spec.md "Public capability security") ─────────────────────────

export const exchangeCapabilitySessionRequestSchema = z.object({
  secret: z.string().min(32).max(200),
}).strict()

export const exchangeCapabilitySessionResponseSchema = z.object({
  roleTitle: z.string(),
  durationMinutes: z.number().int().positive(),
  modality: z.enum(SCHEDULING_MODALITIES),
  policyVersion: z.string().min(1),
  noticeVersion: z.string().min(1),
}).strict()

export const publicSlotsRequestSchema = withBoundedRange({ timezone: z.string().min(1) })
export const publicSlotsResponseSchema = z.object({
  slots: z.array(z.object({
    slotId: z.string().min(1),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
  }).strict()),
}).strict()

const consentDecisionInputSchema = z.object({
  purpose: z.enum(CONSENT_PURPOSES),
  decision: z.enum(CONSENT_DECISIONS),
}).strict()

const candidateLinkInputSchema = z.object({
  url: z.string().url(),
  label: z.string().min(1).max(200).optional(),
}).strict()

export const putCandidateSubmissionRequestSchema = z.object({
  displayName: z.string().min(1).max(200),
  email: z.string().email(),
  notes: z.string().max(5000).optional(),
  links: z.array(candidateLinkInputSchema).max(10),
  consentDecisions: z.array(consentDecisionInputSchema).min(1).max(CONSENT_PURPOSES.length),
}).strict()

export const candidateSubmissionResponseSchema = z.object({
  submissionVersion: z.number().int().positive(),
}).strict()

export const bookSlotRequestSchema = z.object({
  slotId: z.string().min(1),
  submissionVersion: z.number().int().positive(),
  consentReceiptIds: z.array(z.string().uuid()).min(1).max(CONSENT_PURPOSES.length),
  idempotencyKey: idempotencyKeySchema,
}).strict()

export const bookSlotResponseSchema = z.object({
  eventId: z.string().uuid(),
  managementCapability: z.string().min(1),
}).strict()

export const withdrawConsentRequestSchema = z.object({
  purpose: z.enum(CONSENT_PURPOSES),
  noticeVersion: z.string().min(1),
}).strict()

export const withdrawConsentResponseSchema = z.object({
  purpose: z.enum(CONSENT_PURPOSES),
  affectedState: z.enum(['manual_only', 'unaffected']),
}).strict()

export const importCandidateLinkRequestSchema = z.object({
  attestationVersion: z.string().min(1),
}).strict()

export const importCandidateLinkResponseSchema = z.object({
  policyDecision: z.enum(['official_api', 'authorized_crawl', 'user_submitted', 'not_importable']),
  importState: z.enum(['queued', 'not_importable']),
}).strict()

export const createUploadIntentRequestSchema = z.object({
  originalName: z.string().min(1).max(255),
  declaredMediaType: z.string().min(1),
  bytes: z.number().int().positive(),
}).strict()

export const createUploadIntentResponseSchema = z.object({
  documentId: z.string().uuid(),
  uploadUrl: z.string().url(),
  expiresAt: z.string().datetime(),
}).strict()

export const completeUploadRequestSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  bytes: z.number().int().positive(),
}).strict()

export const completeUploadResponseSchema = z.object({
  documentId: z.string().uuid(),
  status: z.enum(DOCUMENT_STATUSES),
}).strict()

// ── POST /api/interviews/:id/brief ───────────────────────────────────────────────────────────

export const generateBriefRequestSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  creditConfirmation: z.literal(true),
}).strict()

export const generateBriefResponseSchema = z.object({
  status: z.enum(['queued', 'ready', 'failed']),
  version: z.number().int().positive(),
}).strict()

// ── POST /api/interviews/:id/session ─────────────────────────────────────────────────────────

export const INTERVIEW_SESSION_ACTIONS = ['start', 'pause', 'resume', 'finish'] as const

export const interviewSessionActionRequestSchema = z.object({
  action: z.enum(INTERVIEW_SESSION_ACTIONS),
  version: z.number().int().positive(),
}).strict()

export const interviewSessionActionResponseSchema = z.object({
  captureCapability: z.enum(INTERVIEW_CAPTURE_CAPABILITIES),
  state: z.enum(INTERVIEW_SESSION_STATES),
  version: z.number().int().positive(),
}).strict()

// ── POST /api/interviews/:id/transcription-token ─────────────────────────────────────────────

export const requestTranscriptionTokenRequestSchema = z.object({
  version: z.number().int().positive(),
}).strict()

export const transcriptionTokenResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.string().datetime(),
  websocketUrl: z.string().url().refine((url) => url.startsWith('wss://api.eu.deepgram.com'), {
    message: 'websocketUrl must be the EU Deepgram endpoint',
  }),
}).strict()

// ── POST /api/interviews/:id/segments ─────────────────────────────────────────────────────────

const finalSegmentInputSchema = z.object({
  providerSegmentId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  speakerEstimate: z.enum(SPEAKER_ESTIMATES),
  text: z.string(),
  startsMs: z.number().int().nonnegative(),
  endsMs: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1).nullable(),
}).strict()

export const submitSegmentsRequestSchema = z.object({
  segments: z.array(finalSegmentInputSchema).min(1).max(50),
  idempotencyKey: idempotencyKeySchema,
}).strict()

export const submitSegmentsResponseSchema = z.object({
  highestAcknowledgedSequence: z.number().int().nonnegative(),
}).strict()

// ── POST /api/interviews/:id/suggestions ─────────────────────────────────────────────────────

export const requestSuggestionsRequestSchema = z.object({
  lastAcknowledgedSequence: z.number().int().nonnegative(),
  topics: z.array(z.object({ id: z.string().min(1), state: z.string().min(1) }).strict()).max(20),
}).strict()

export const requestSuggestionsResponseSchema = interviewFollowupSuggestOutputSchema

// ── GET/PATCH/POST /api/interviews/:id/report ────────────────────────────────────────────────

export const patchReportRequestSchema = z.object({
  version: z.number().int().positive(),
  content: interviewReportContentSchema.partial(),
}).strict()

export const generateReportRequestSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  creditConfirmation: z.literal(true),
}).strict()

export const reportResponseSchema = interviewReportSchema

// ── Billing pass-through (owned entirely by the billing platform) ───────────────────────────
// GET /api/billing/summary and POST /api/billing/checkout/credits are not redefined here —
// interview code only links to them, per spec.md. `BillingAvailabilityDtoRef` documents which
// existing billing-platform type interview UI actually consumes.
export type BillingAvailabilityDtoRef = BillingAvailabilityDto

// ── Candidate document (reused across upload-completion and brief-source responses) ─────────

export const candidateDocumentResponseSchema = candidateDocumentSchema

// ── Route registry ───────────────────────────────────────────────────────────────────────────

export interface InterviewApiRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'
  path: string
  authority: ApiAuthority
  requestSchema: z.ZodTypeAny | null
  responseSchema: z.ZodTypeAny | null
}

export const INTERVIEW_API_ROUTES: readonly InterviewApiRoute[] = [
  { method: 'GET', path: '/api/calendar/feed', authority: 'user', requestSchema: calendarFeedRequestSchema, responseSchema: calendarFeedResponseSchemaRef },
  { method: 'POST', path: '/api/calendar/events', authority: 'user', requestSchema: createEventRequestSchema, responseSchema: createEventResponseSchema },
  { method: 'PATCH', path: '/api/calendar/events/:id', authority: 'owner', requestSchema: mutateEventRequestSchema, responseSchema: eventMutationResultSchema },
  { method: 'DELETE', path: '/api/calendar/events/:id', authority: 'owner', requestSchema: deleteEventRequestSchema, responseSchema: eventMutationResultSchema },
  { method: 'GET', path: '/api/calendar/availability', authority: 'owner', requestSchema: null, responseSchema: availabilityPolicyResponseSchema },
  { method: 'PUT', path: '/api/calendar/availability', authority: 'owner', requestSchema: putAvailabilityRequestSchema, responseSchema: availabilityPolicyResponseSchema },
  { method: 'GET', path: '/api/calendar/export.ics', authority: 'user', requestSchema: exportIcsRequestSchema, responseSchema: null },
  { method: 'GET', path: '/api/calendar/notifications', authority: 'user', requestSchema: listNotificationsRequestSchema, responseSchema: listNotificationsResponseSchema },
  { method: 'PATCH', path: '/api/calendar/notifications', authority: 'user', requestSchema: markNotificationsReadRequestSchema, responseSchema: listNotificationsResponseSchema },
  { method: 'POST', path: '/api/scheduling/invitations', authority: 'owner', requestSchema: createInvitationRequestSchema, responseSchema: invitationDraftPreviewResponseSchema },
  { method: 'POST', path: '/api/scheduling/invitations/:id/send', authority: 'owner', requestSchema: invitationStateChangeRequestSchema, responseSchema: invitationStateResponseSchema },
  { method: 'POST', path: '/api/scheduling/invitations/:id/revoke', authority: 'owner', requestSchema: invitationStateChangeRequestSchema, responseSchema: invitationStateResponseSchema },
  { method: 'POST', path: '/api/public/scheduling/:id/session', authority: 'fragment_capability', requestSchema: exchangeCapabilitySessionRequestSchema, responseSchema: exchangeCapabilitySessionResponseSchema },
  { method: 'GET', path: '/api/public/scheduling/:id/slots', authority: 'capability', requestSchema: publicSlotsRequestSchema, responseSchema: publicSlotsResponseSchema },
  { method: 'PUT', path: '/api/public/scheduling/:id/submission', authority: 'capability', requestSchema: putCandidateSubmissionRequestSchema, responseSchema: candidateSubmissionResponseSchema },
  { method: 'POST', path: '/api/public/scheduling/:id/book', authority: 'capability', requestSchema: bookSlotRequestSchema, responseSchema: bookSlotResponseSchema },
  { method: 'POST', path: '/api/public/scheduling/:id/withdraw', authority: 'capability', requestSchema: withdrawConsentRequestSchema, responseSchema: withdrawConsentResponseSchema },
  { method: 'POST', path: '/api/public/scheduling/:id/links/:linkId/import', authority: 'capability', requestSchema: importCandidateLinkRequestSchema, responseSchema: importCandidateLinkResponseSchema },
  { method: 'POST', path: '/api/public/scheduling/:id/uploads', authority: 'capability', requestSchema: createUploadIntentRequestSchema, responseSchema: createUploadIntentResponseSchema },
  { method: 'POST', path: '/api/public/scheduling/:id/uploads/:documentId/complete', authority: 'capability', requestSchema: completeUploadRequestSchema, responseSchema: completeUploadResponseSchema },
  { method: 'POST', path: '/api/interviews/:id/brief', authority: 'participant', requestSchema: generateBriefRequestSchema, responseSchema: generateBriefResponseSchema },
  { method: 'POST', path: '/api/interviews/:id/session', authority: 'participant', requestSchema: interviewSessionActionRequestSchema, responseSchema: interviewSessionActionResponseSchema },
  { method: 'POST', path: '/api/interviews/:id/transcription-token', authority: 'participant', requestSchema: requestTranscriptionTokenRequestSchema, responseSchema: transcriptionTokenResponseSchema },
  { method: 'POST', path: '/api/interviews/:id/segments', authority: 'participant', requestSchema: submitSegmentsRequestSchema, responseSchema: submitSegmentsResponseSchema },
  { method: 'POST', path: '/api/interviews/:id/suggestions', authority: 'participant', requestSchema: requestSuggestionsRequestSchema, responseSchema: requestSuggestionsResponseSchema },
  { method: 'GET', path: '/api/interviews/:id/report', authority: 'participant', requestSchema: null, responseSchema: reportResponseSchema },
  { method: 'PATCH', path: '/api/interviews/:id/report', authority: 'participant', requestSchema: patchReportRequestSchema, responseSchema: reportResponseSchema },
  { method: 'POST', path: '/api/interviews/:id/report', authority: 'participant', requestSchema: generateReportRequestSchema, responseSchema: reportResponseSchema },
  { method: 'GET', path: '/api/billing/summary', authority: 'role_minimized', requestSchema: null, responseSchema: null },
  { method: 'POST', path: '/api/billing/checkout/credits', authority: 'owner', requestSchema: null, responseSchema: null },
] as const

// ── Authority-field guard (spec.md: "reject organization/owner/provider/price/credit authority fields from client inputs") ─

const FORBIDDEN_CLIENT_INPUT_FIELDS = ['organizationId', 'ownerUserId', 'provider', 'price', 'priceId', 'creditAmount', 'creditUnits']

/** Walks a Zod object's own shape keys (not nested/refined internals) looking for a server-authority field name — used by the contract test to sweep every request schema mechanically. */
export function findForbiddenAuthorityFields(schema: z.ZodTypeAny): string[] {
  const shape: Record<string, unknown> | undefined = (schema as unknown as { shape?: Record<string, unknown> }).shape
  if (!shape) return []
  return Object.keys(shape).filter((key) => FORBIDDEN_CLIENT_INPUT_FIELDS.includes(key))
}

export { SOURCE_KINDS }
