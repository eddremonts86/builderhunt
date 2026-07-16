import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'

export const Route = createFileRoute('/api/alerts/triggers/$id')({
  component: () => null,
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })
          const { markTriggerRead } = await import('~/shared/lib/alerts')
          const ok = await markTriggerRead(params.id, session.user.id)
          return Response.json({ ok })
        } catch (err) {
          console.error('trigger read error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
