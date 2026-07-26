import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { httpStatusForApiErrorCode, type ApiErrorCode } from '~/shared/lib/api-errors'
import { REMINDER_OFFSET_MINUTES } from '~/shared/lib/calendar'
import { createEvent, listRange, search } from '~/lib/calendar/service'
import { findDefaultCalendar, insertCalendar } from '~/shared/lib/repositories/calendar'

/**
 * Authenticated range/search read and event creation (plan:
 * calendar-scheduling-interview-intelligence, Phase 3 "Add calendar event APIs").
 *
 * Authorization lives in `lib/calendar/service.ts`; this route only parses, enters tenant
 * context, and maps coded service errors to HTTP. Error bodies carry a stable code and never a
 * provider message, stack, or another user's data.
 */

const rangeQuerySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  title: z.string().max(200).optional(),
  participant: z.string().max(200).optional(),
  eventType: z.enum(['personal', 'interview']).optional(),
})

const createBodySchema = z.object({
  type: z.enum(['personal', 'interview']),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  location: z.string().max(500).optional(),
  meetingUrl: z.string().url().optional(),
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
            // Every user gets a default calendar lazily on their first event, so the UI never has
            // to expose calendar management before there is anything to manage.
            const existing = await findDefaultCalendar(tx, principal.organizationId, principal.userId)
            const calendar = existing ?? await insertCalendar(tx, {
              organizationId: principal.organizationId,
              ownerUserId: principal.userId,
              name: 'My calendar',
              timezone: parsed.data.timezone,
              isDefault: true,
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
