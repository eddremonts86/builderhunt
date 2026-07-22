import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'
import { listMyOrganizations, toOrganizationSummaryDtoList } from '~/shared/lib/organizations/contracts'

export const Route = createFileRoute('/api/organizations/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'Authentication required' }, { status: 401 })
          const records = await listMyOrganizations(session.user.id)
          return Response.json(toOrganizationSummaryDtoList(records))
        } catch (error) {
          console.error('Organizations list error:', error)
          return Response.json({ error: 'Failed to list organizations' }, { status: 500 })
        }
      },
    },
  },
})
