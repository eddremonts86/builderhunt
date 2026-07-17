import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'
import { PLAN_LIMITS, PLAN_PRICING } from '~/shared/lib/billing-shared'

export const Route = createFileRoute('/api/plans/me')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ plan: null, signedOut: true })
          }
          // Dynamic-import server-only helper to keep db out of the client bundle
          const { getUserPlan, checkLimit } = await import('~/shared/lib/billing')
          const userPlan = await getUserPlan(session.user.id)
          const [savedSearches, savedBuilders] = await Promise.all([
            checkLimit(session.user.id, 'savedSearches'),
            checkLimit(session.user.id, 'savedBuilders'),
          ])
          return Response.json({
            plan: userPlan,
            limits: userPlan ? PLAN_LIMITS[userPlan.plan] : PLAN_LIMITS.free,
            usage: { savedSearches: savedSearches.current, savedBuilders: savedBuilders.current },
            pricing: PLAN_PRICING,
            signedOut: false,
          })
        } catch (err) {
          console.error('plans/me error:', err)
          return Response.json({ plan: null, signedOut: true })
        }
      },
    },
  },
})
