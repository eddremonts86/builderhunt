import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { builders, savedQueries, builderNotes } from '~/shared/lib/db/schema'
import { and, eq, gte, sql } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'

export const Route = createFileRoute('/api/dashboard/stats')({
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

          const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

          const [totalResult] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(builders)
            .where(eq(builders.userId, userId))

          const [activeResult] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(builders)
            .where(and(eq(builders.userId, userId), gte(builders.lastSeen, weekAgo)))

          const [queriesResult] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(savedQueries)
            .where(eq(savedQueries.userId, userId))

          const [notesResult] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(builderNotes)
            .where(eq(builderNotes.userId, userId))

          return Response.json({
            totalBuilders: totalResult?.count ?? 0,
            activeThisWeek: activeResult?.count ?? 0,
            savedQueries: queriesResult?.count ?? 0,
            totalNotes: notesResult?.count ?? 0,
          })
        } catch (err) {
          console.error('Dashboard stats error:', err)
          return Response.json({ error: 'Failed to fetch stats' }, { status: 500 })
        }
      },
    },
  },
})
