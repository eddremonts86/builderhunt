import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requirePlatformAdminPage } from '~/shared/lib/auth/auth-session'
import { OperationsPage } from '~/modules/admin/operations/OperationsPage'

const OperationsSearchSchema = z.object({
  job: z.string().optional(),
})

export const Route = createFileRoute('/_dashboard/admin/operations')({
  validateSearch: OperationsSearchSchema,
  beforeLoad: async () => {
    await requirePlatformAdminPage()
  },
  component: RouteComponent,
})

function RouteComponent() {
  const { job } = Route.useSearch()
  return <OperationsPage highlightJobKey={job ?? null} />
}
