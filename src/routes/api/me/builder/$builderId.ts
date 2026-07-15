import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { builders } from '~/shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'
import { z } from 'zod'

/**
 * PATCH /api/me/builder/:builderId
 * Update the claimed builder's topics + open-to status.
 */
const Body = z.object({
  claimedTopics: z.array(z.string().min(1).max(40)).max(20).optional(),
  openToStatus: z.array(z.enum(['chats', 'mentoring', 'collaboration', 'hires', 'consulting', 'nothing'])).max(6).optional(),
  bio: z.string().max(500).optional(),
})

export const Route = createFileRoute('/api/me/builder/$builderId')({
  component: () => null,
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }
          const userId = session.user.id
          const { builderId } = params

          const body = await request.json().catch(() => ({}))
          const parsed = Body.safeParse(body)
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body' }, { status: 400 })
          }

          const [existing] = await db
            .select({ id: builders.id, claimedByUserId: builders.claimedByUserId })
            .from(builders)
            .where(eq(builders.id, builderId))
            .limit(1)

          if (!existing || existing.claimedByUserId !== userId) {
            return Response.json({ error: 'Not your profile' }, { status: 403 })
          }

          const update: Record<string, unknown> = { updatedAt: new Date() }
          if (parsed.data.claimedTopics !== undefined) update.claimedTopics = parsed.data.claimedTopics
          if (parsed.data.openToStatus !== undefined) update.openToStatus = parsed.data.openToStatus
          if (parsed.data.bio !== undefined) update.bio = parsed.data.bio

          const [updated] = await db
            .update(builders)
            .set(update)
            .where(eq(builders.id, builderId))
            .returning()

          return Response.json(updated)
        } catch (err) {
          console.error('Patch me/builder error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
