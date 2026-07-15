import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'
import { db } from '~/shared/lib/db/index'
import { builders } from '~/shared/lib/db/schema'
import { and, desc, eq } from 'drizzle-orm'

export const Route = createFileRoute('/api/builders/recent/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }

          const rows = await db
            .select({
              id: builders.id,
              username: builders.username,
              displayName: builders.displayName,
              source: builders.source,
              bio: builders.bio,
              followersCount: builders.followersCount,
              topics: builders.topics,
              lastSeen: builders.lastSeen,
            })
            .from(builders)
            .where(eq(builders.userId, session.user.id))
            .orderBy(desc(builders.lastSeen))
            .limit(6)

          return Response.json(rows)
        } catch (err) {
          console.error('Recent builders error:', err)
          return Response.json([], { status: 200 })
        }
      },
    },
  },
})
