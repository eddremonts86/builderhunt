import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { roadmapItems, roadmapVotes } from '~/shared/lib/db/schema'
import { eq, sql, asc, and, ne } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'

export const Route = createFileRoute('/api/roadmap/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          // Get items + vote counts
          const items = await db
            .select()
            .from(roadmapItems)
            .orderBy(asc(roadmapItems.sortOrder), asc(roadmapItems.createdAt))

          // Get counts grouped by itemId
          const counts = await db
            .select({
              itemId: roadmapVotes.itemId,
              count: sql<number>`count(*)::int`,
            })
            .from(roadmapVotes)
            .groupBy(roadmapVotes.itemId)
          const countMap = new Map(counts.map((c) => [c.itemId, c.count]))

          // Check if current user has voted on each item
          const session = await auth.api.getSession({ headers: request.headers })
          const userId = session?.user?.id
          let votedSet = new Set<string>()
          if (userId) {
            const votes = await db
              .select({ itemId: roadmapVotes.itemId })
              .from(roadmapVotes)
              .where(eq(roadmapVotes.userId, userId))
            votedSet = new Set(votes.map((v) => v.itemId))
          }

          return Response.json(
            items.map((i) => ({
              ...i,
              voteCount: countMap.get(i.id) ?? 0,
              userHasVoted: votedSet.has(i.id),
            })),
          )
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

          // Check if already voted (idempotent insert)
          const [existing] = await db
            .select()
            .from(roadmapVotes)
            .where(and(eq(roadmapVotes.itemId, itemId), eq(roadmapVotes.userId, session.user.id)))
            .limit(1)

          if (existing) {
            // Remove vote (toggle)
            await db
              .delete(roadmapVotes)
              .where(and(eq(roadmapVotes.itemId, itemId), eq(roadmapVotes.userId, session.user.id)))
            return Response.json({ ok: true, voted: false })
          }

          await db.insert(roadmapVotes).values({
            id: crypto.randomUUID(),
            itemId,
            userId: session.user.id,
          })
          return Response.json({ ok: true, voted: true })
        } catch (err) {
          console.error('roadmap vote error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
