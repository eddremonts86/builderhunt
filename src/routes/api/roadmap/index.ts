import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { auth } from '~/shared/lib/auth/better-auth'
import { listPublicRoadmap, togglePublicRoadmapVote } from '~/shared/lib/repositories/public-content'

export const Route = createFileRoute('/api/roadmap/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST']),

      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          return Response.json(await listPublicRoadmap(session?.user?.id))
        } catch (err) {
          console.error('roadmap list error:', err)
          return Response.json([])
        }
      },
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }
          const body = await request.json().catch(() => ({}))
          const { itemId } = body as { itemId?: string }
          if (!itemId) return Response.json({ error: 'itemId required' }, { status: 400 })

          const voted = await togglePublicRoadmapVote(session.user.id, itemId)
          return Response.json({ ok: true, voted })
        } catch (err) {
          console.error('roadmap vote error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
