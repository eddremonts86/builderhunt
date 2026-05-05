import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { builderNotes } from '~/shared/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'
import { randomId } from '~/lib/utils'

export const Route = createFileRoute('/api/builders/$builderId/notes')({
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

          const notes = await db
            .select()
            .from(builderNotes)
            .where(and(eq(builderNotes.builderId, builderId), eq(builderNotes.userId, userId)))
            .orderBy(builderNotes.createdAt)

          return Response.json(notes)
        } catch (err) {
          console.error('Notes fetch error:', err)
          return Response.json({ error: 'Failed to fetch notes' }, { status: 500 })
        }
      },
      POST: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }
          const userId = session.user.id
          const { builderId } = params

          const body = await request.json()
          const { content } = body

          if (!content?.trim()) {
            return Response.json({ error: 'Content is required' }, { status: 400 })
          }

          const note = await db
            .insert(builderNotes)
            .values({
              id: randomId(),
              userId,
              builderId,
              content: content.trim(),
            })
            .returning()

          return Response.json(note[0])
        } catch (err) {
          console.error('Notes create error:', err)
          return Response.json({ error: 'Failed to create note' }, { status: 500 })
        }
      },
    },
  },
})
