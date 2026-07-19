import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { builders } from '~/shared/lib/db/schema'
import { desc, eq } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'

export const Route = createFileRoute('/api/me/builders/')({
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
            .where(eq(builders.userId, userId))
            .orderBy(desc(builders.lastSeen))

          return Response.json(
            rows.map((b) => ({
              id: b.id,
              username: b.username,
              displayName: b.displayName,
              avatarUrl: b.avatarUrl,
              source: b.source,
              profileUrl: b.profileUrl,
              topics: b.topics ?? [],
              score: typeof b.metadata?.score === 'number' ? b.metadata.score : null,
              lastSeen: b.lastSeen,
            })),
          )
        } catch (err) {
          console.error('List tracked builders error:', err)
          return Response.json({ error: 'Failed to fetch tracked builders' }, { status: 500 })
        }
      },
    },
  },
})
