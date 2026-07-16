import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'
import { skipOnboarding } from '~/shared/lib/onboarding'

export const Route = createFileRoute('/api/onboarding/skip')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }
          const status = await skipOnboarding(session.user.id)
          return Response.json({ ok: true, status })
        } catch (err) {
          console.error('Onboarding skip error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
