import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { builders } from '~/shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'

/**
 * GET /api/me/builder
 * Returns the builder(s) claimed by the current user.
 * Used by /me dashboard.
 */
export const Route = createFileRoute('/api/me/builder/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }
          const userId = session.user.id

          const rows = await db
            .select()
            .from(builders)
            .where(eq(builders.claimedByUserId, userId))

          return Response.json(rows)
        } catch (err) {
          console.error('Get me/builder error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
