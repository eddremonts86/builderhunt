import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { exportIcsRequestSchema } from '~/shared/lib/interview-api'
import { listRange } from '~/lib/calendar/service'
import { buildCalendarIcs } from '~/lib/calendar/ics'
import { calendarErrorResponse } from './events/index'

/**
 * Bounded private ICS export (plan: calendar-scheduling-interview-intelligence, Phase 3 "Add
 * calendar event APIs").
 *
 * "Private" is the operative word. There is no capability token, no signed feed URL, and no
 * long-lived subscription link — the caller must be an authenticated tenant principal, and
 * `listRange` returns only what that principal may see. A subscribable URL is the usual way to
 * ship this, and the usual way to leak a whole calendar to anyone who forwards the link.
 *
 * The range is required and bounded by `exportIcsRequestSchema`, so "export my calendar" can never
 * become an unbounded scan of every event a tenant has ever had.
 */
export const Route = createFileRoute('/api/calendar/export.ics')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          if (env.CALENDAR_ENABLED === 'false') {
            return Response.json({ error: 'dependency_unavailable' }, { status: 503 })
          }
          const principal = await requireTenantPrincipal(request)
          const url = new URL(request.url)
          const parsed = exportIcsRequestSchema.safeParse(Object.fromEntries(url.searchParams))
          if (!parsed.success) return Response.json({ error: 'invalid_input' }, { status: 400 })

          const events = await withTenantContext(principal, (tx) => listRange(tx, principal, {
            from: new Date(parsed.data.from),
            to: new Date(parsed.data.to),
          }))

          const body = buildCalendarIcs(events.map((event) => ({
            eventId: event.id,
            version: event.version,
            title: event.title,
            description: event.description,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            timezone: event.timezone,
            location: event.location,
            meetingUrl: event.meetingUrl,
          })))

          return new Response(body, {
            status: 200,
            headers: {
              'Content-Type': 'text/calendar; charset=utf-8',
              'Content-Disposition': 'attachment; filename="builderhunt.ics"',
              // Personal data: never let a shared cache or CDN hold a copy.
              'Cache-Control': 'private, no-store',
            },
          })
        } catch (error) {
          return calendarErrorResponse(error)
        }
      },
    },
  },
})
