import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { builders } from '~/shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'

export const Route = createFileRoute('/api/builders/$builderId')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }
          const userId = session.user.id
          const { builderId } = params

          const [builder] = await db
            .select()
            .from(builders)
            .where(eq(builders.id, builderId))

          if (!builder || builder.userId !== userId) {
            return Response.json({ error: 'Builder not found' }, { status: 404 })
          }

          return Response.json(builder)
        } catch (err) {
          console.error('Builder fetch error:', err)
          return Response.json({ error: 'Failed to fetch builder' }, { status: 500 })
        }
      },
      PATCH: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }
          const userId = session.user.id
          const { builderId } = params

          const [existing] = await db
            .select()
            .from(builders)
            .where(eq(builders.id, builderId))

          if (!existing || existing.userId !== userId) {
            return Response.json({ error: 'Builder not found' }, { status: 404 })
          }

          const body = await request.json()
          const { topics, country, language } = body

          const updated = await db
            .update(builders)
            .set({ topics, country, language, updatedAt: new Date() })
            .where(eq(builders.id, builderId))
            .returning()

          return Response.json(updated[0] ?? { success: true })
        } catch (err) {
          console.error('Builder update error:', err)
          return Response.json({ error: 'Failed to update builder' }, { status: 500 })
        }
      },
    },
  },
})
