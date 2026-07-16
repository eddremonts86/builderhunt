import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'
import { listAllUsersWithPlans, PLAN_PRICING } from '~/shared/lib/billing'

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '').split(',').filter(Boolean)
function isAdmin(userId: string) {
  return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(userId)
}

export const Route = createFileRoute('/api/admin/users/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id || !isAdmin(session.user.id)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          const users = await listAllUsersWithPlans()
          return Response.json({ users, pricing: PLAN_PRICING })
        } catch (err) {
          console.error('admin users list error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
