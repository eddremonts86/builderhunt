import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { httpStatusForApiErrorCode, type ApiErrorCode } from '~/shared/lib/api-errors'
import { REMINDER_OFFSET_MINUTES } from '~/shared/lib/calendar'
import { MAX_RANGE_SPAN_DAYS } from '~/shared/lib/interview-api'
import { httpUrlSchema } from '~/shared/lib/url-safety'
import { createEvent, listRange, search } from '~/lib/calendar/service'
import { ensureDefaultCalendar } from '~/shared/lib/repositories/calendar'

/**
 * Authenticated range/search read and event creation (plan:
 * calendar-scheduling-interview-intelligence, Phase 3 "Add calendar event APIs").
 *
 * Authorization lives in `lib/calendar/service.ts`; this route only parses, enters tenant
 * context, and maps coded service errors to HTTP. Error bodies carry a stable code and never a
 * provider message, stack, or another user's data.
 */

/**
 * The span cap matches `MAX_RANGE_SPAN_DAYS` for the same reason the feed has one: this
 * read loads every event in the range before the response is built, so the span is the
 * caller-controlled dimension of the query. Local rather than reusing
 * `withBoundedRange` because this schema also drives the search filters and is parsed
 * from a query string where the range is optional in neither branch.
 */
const rangeQuerySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  title: z.string().max(200).optional(),
  participant: z.string().max(200).optional(),
  eventType: z.enum(['personal', 'interview']).optional(),
}).refine((query) => new Date(query.to) > new Date(query.from), {
  message: 'to must be after from', path: ['to'],
}).refine(
  (query) => new Date(query.to).getTime() - new Date(query.from).getTime()
    <= MAX_RANGE_SPAN_DAYS * 24 * 60 * 60 * 1000,
  { message: `the range must not span more than ${MAX_RANGE_SPAN_DAYS} days`, path: ['to'] },
)

const createBodySchema = z.object({
  type: z.enum(['personal', 'interview']),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  location: z.string().max(500).optional(),
  // `httpUrlSchema`, not `z.string().url()`: an interview event's meeting URL is rendered as an
  // anchor on the candidate portal and on the organizer's list, and `z.string().url()` accepts
  // `javascript:alert(1)`. The shared `eventDraftInputSchema` already uses it; this route-local
  // copy of the body shape did not, which made the shared schema's guarantee reachable only
  // through paths that happened to use it.
  meetingUrl: httpUrlSchema.optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  timezone: z.string().min(1).max(64),
  allDay: z.boolean().default(false),
  busy: z.boolean().default(true),
  rrule: z.string().max(500).optional(),
  recurrenceUntil: z.string().datetime().optional(),
  reminders: z.array(z.object({
    channel: z.enum(['email', 'in_app']),
    offsetMinutes: z.number().int().refine((m) => (REMINDER_OFFSET_MINUTES as readonly number[]).includes(m)),
  })).max(20).default([]),
  participants: z.array(z.object({
    userId: z.string().min(1).optional(),
    externalEmail: z.string().email().optional(),
    displayName: z.string().min(1).max(200).optional(),
    role: z.enum(['organizer', 'attendee']).default('attendee'),
  })).max(50).default([]),
  acknowledgeOverlapWarning: z.boolean().default(false),
}).strict()

/** Maps a coded service/domain error to its HTTP status, defaulting to 400 for anything unrecognized. */
export function calendarErrorResponse(error: unknown) {
  if (error instanceof TenantAuthorizationError) {
    return Response.json({ error: 'authentication_required' }, { status: 401 })
  }
  const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : null
  if (code === 'overlap_warning') {
    return Response.json({ error: 'overlap_warning', message: 'This time overlaps an existing event' }, { status: 409 })
  }
  if (code === 'event_changed' || code === 'invalid_state_transition') {
    return Response.json({ error: 'state_changed' }, { status: 409 })
  }
  // 501, not the default 400: the request is well-formed and the caller cannot fix it by changing
  // anything. A 400 here would send a client into a validation-error path for a capability the
  // server simply does not have yet — see the note on recurrence scopes in `calendar/service.ts`.
  if (code === 'not_implemented') {
    return Response.json({ error: 'not_implemented' }, { status: 501 })
  }
  if (code) {
    const known: ApiErrorCode[] = ['invalid_input', 'forbidden', 'not_found', 'slot_unavailable', 'state_changed']
    if ((known as string[]).includes(code)) {
      return Response.json({ error: code }, { status: httpStatusForApiErrorCode(code as ApiErrorCode) })
    }
  }
  console.error('calendar events route error:', error)
  return Response.json({ error: 'invalid_input' }, { status: 400 })
}

function disabledResponse() {
  return Response.json({ error: 'dependency_unavailable' }, { status: 503 })
}

export const Route = createFileRoute('/api/calendar/events/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST']),

      GET: async ({ request }) => {
        try {
          if (env.CALENDAR_ENABLED === 'false') return disabledResponse()
          const principal = await requireTenantPrincipal(request)
          const url = new URL(request.url)
          const parsed = rangeQuerySchema.safeParse(Object.fromEntries(url.searchParams))
          if (!parsed.success) return Response.json({ error: 'invalid_input' }, { status: 400 })

          const range = { from: new Date(parsed.data.from), to: new Date(parsed.data.to) }
          const isSearch = Boolean(parsed.data.title || parsed.data.participant || parsed.data.eventType)
          const rows = await withTenantContext(principal, (tx) => (isSearch
            ? search(tx, principal, { ...parsed.data, ...range })
            : listRange(tx, principal, range)))
          return Response.json({ events: rows })
        } catch (error) {
          return calendarErrorResponse(error)
        }
      },
      POST: async ({ request }) => {
        try {
          if (env.CALENDAR_ENABLED === 'false') return disabledResponse()
          const principal = await requireTenantPrincipal(request)
          const parsed = createBodySchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 })
          }

          const created = await withTenantContext(principal, async (tx) => {
            // Every user gets a default calendar lazily, so the UI never has to expose calendar
            // management before there is anything to manage. Shared with the two scheduling paths
            // that also need one to exist — see `ensureDefaultCalendar`.
            const calendar = await ensureDefaultCalendar(tx, {
              organizationId: principal.organizationId,
              ownerUserId: principal.userId,
              timezone: parsed.data.timezone,
            })
            return createEvent(tx, principal, {
              ...parsed.data,
              calendarId: calendar.id,
              startsAt: new Date(parsed.data.startsAt),
              endsAt: new Date(parsed.data.endsAt),
              recurrenceUntil: parsed.data.recurrenceUntil ? new Date(parsed.data.recurrenceUntil) : null,
            })
          })
          return Response.json(created, { status: 201 })
        } catch (error) {
          return calendarErrorResponse(error)
        }
      },
    },
  },
})
