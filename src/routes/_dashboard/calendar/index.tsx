import { createFileRoute } from '@tanstack/react-router'
import { CalendarPage } from '~/modules/calendar/components/CalendarPage'

export const Route = createFileRoute('/_dashboard/calendar/')({
  component: CalendarPage,
})
