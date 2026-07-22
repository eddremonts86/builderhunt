import { createFileRoute } from '@tanstack/react-router'
import { platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { listAllUsersWithPlans, PLAN_PRICING } from '~/shared/lib/billing'

export const Route = createFileRoute('/api/admin/users/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)
          const users = await listAllUsersWithPlans()
          return Response.json({ users, pricing: PLAN_PRICING })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin users list error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
