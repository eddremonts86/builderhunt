import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'

export const Route = createFileRoute('/api/alerts/triggers/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }
          const { listTriggersForUser } = await import('~/shared/lib/alerts')
          const triggers = await listTriggersForUser(session.user.id, 100)
          return Response.json(triggers)
        } catch (err) {
          console.error('alerts/triggers error:', err)
          return Response.json([])
        }
      },
    },
  },
})
