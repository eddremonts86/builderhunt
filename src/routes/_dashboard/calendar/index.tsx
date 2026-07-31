import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { CalendarPage, type CalendarViewKey } from '~/modules/calendar/components/CalendarPage'

// `date` is a plain `YYYY-MM-DD` — never a full ISO instant, so it round-trips through the URL the
// same way regardless of the viewer's own timezone.
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/
const CalendarSearchSchema = z.object({
  view: z.enum(['month', 'week', 'day', 'list']).optional().default('month'),
  date: z.string().regex(isoDatePattern).optional(),
  q: z.string().max(200).optional().default(''),
})

export const Route = createFileRoute('/_dashboard/calendar/')({
  validateSearch: CalendarSearchSchema,
  component: CalendarRoute,
})

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Thin route wrapper: `CalendarPage` itself stays framework-agnostic (no router hooks) so it keeps
 * rendering directly in its own component tests without a `RouterProvider` — this wrapper is the
 * only place `view`/`date`/`q` are read from and written back to the URL.
 */
function CalendarRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <CalendarPage
      view={search.view as CalendarViewKey}
      date={search.date ? new Date(`${search.date}T00:00:00.000Z`) : undefined}
      query={search.q}
      onViewChange={(view) => navigate({ search: (prev) => ({ ...prev, view }), replace: true })}
      onDateChange={(date) => navigate({ search: (prev) => ({ ...prev, date: toIsoDate(date) }), replace: true })}
      onQueryChange={(q) => navigate({ search: (prev) => ({ ...prev, q }), replace: true })}
    />
  )
}
