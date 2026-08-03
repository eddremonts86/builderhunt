import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { calendarFeedRequestSchema } from '~/shared/lib/interview-api'
import { buildCalendarFeed, type CalendarLayer } from '~/lib/calendar/projections'
import { calendarErrorResponse } from './events/index'

/**
 * The unified calendar feed (plan: calendar-scheduling-interview-intelligence, Phase 4).
 *
 * `layers` is a required, bounded array rather than an optional filter, so a client has to state what
 * it wants. An omitted-means-everything default would make the widest, most expensive query the one
 * you get by forgetting a parameter.
 */
export const Route = createFileRoute('/api/calendar/feed')({
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

          const parsed = calendarFeedRequestSchema.safeParse({
            from: url.searchParams.get('from') ?? undefined,
            to: url.searchParams.get('to') ?? undefined,
            timezone: url.searchParams.get('timezone') ?? undefined,
            // Repeated `?layers=` params rather than a comma-joined string: the contract types this
            // as an array, and splitting a string here would quietly accept `layers=events,bogus`.
            layers: url.searchParams.getAll('layers'),
          })
          if (!parsed.success) {
            return Response.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 })
          }

          const response = await withTenantContext(principal, (tx) => buildCalendarFeed(tx, principal, {
            from: new Date(parsed.data.from),
            to: new Date(parsed.data.to),
            layers: parsed.data.layers as CalendarLayer[],
          }))
          return Response.json(response)
        } catch (error) {
          return calendarErrorResponse(error)
        }
      },
    },
  },
})
