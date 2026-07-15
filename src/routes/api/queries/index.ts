import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { savedQueries } from '~/shared/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'
import { randomId } from '~/lib/utils'

export const Route = createFileRoute('/api/queries/')({
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

          const queries = await db
            .select()
            .from(savedQueries)
            .where(eq(savedQueries.userId, userId))
            .orderBy(savedQueries.createdAt)

          return Response.json(queries)
        } catch (err) {
          console.error('Queries list error:', err)
          return Response.json({ error: 'Failed to fetch queries' }, { status: 500 })
        }
      },
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }
          const userId = session.user.id

          const body = await request.json()
          const { name, keywords, sources, language, country } = body

          if (!name?.trim() || !keywords?.length) {
            return Response.json({ error: 'Name and keywords are required' }, { status: 400 })
          }

          const query = await db
            .insert(savedQueries)
            .values({
              id: randomId(),
              userId,
              name: name.trim(),
              keywords,
              sources: sources ?? ['github'],
              language: language ?? null,
              country: country ?? null,
            })
            .returning()

          return Response.json(query[0])
        } catch (err) {
          console.error('Query create error:', err)
          return Response.json({ error: 'Failed to create query' }, { status: 500 })
        }
      },
      DELETE: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }
          const userId = session.user.id

          const body = await request.json()
          const { id } = body

          // Verify ownership: only delete if the query belongs to the current user
          const result = await db
            .delete(savedQueries)
            .where(and(eq(savedQueries.id, id), eq(savedQueries.userId, userId)))
            .returning({ id: savedQueries.id })

          if (result.length === 0) {
            return Response.json({ error: 'Query not found or not yours' }, { status: 404 })
          }
          return Response.json({ success: true })
        } catch (err) {
          console.error('Query delete error:', err)
          return Response.json({ error: 'Failed to delete query' }, { status: 500 })
        }
      },
    },
  },
})
