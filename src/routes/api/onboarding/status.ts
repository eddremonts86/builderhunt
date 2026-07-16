import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'
import { getOnboardingStatus } from '~/shared/lib/onboarding'

export const Route = createFileRoute('/api/onboarding/status')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }
          const status = await getOnboardingStatus(session.user.id)
          return Response.json(status)
        } catch (err) {
          console.error('Onboarding status error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
