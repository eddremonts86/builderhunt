import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { db } from '~/shared/lib/db/index'
import { incidents } from '~/shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '').split(',').filter(Boolean)

const UpdateBody = z.object({
  status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
})

function isAdmin(userId: string): boolean {
  return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(userId)
}

export const Route = createFileRoute('/api/admin/incidents/$id')({
  component: () => null,
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id || !isAdmin(session.user.id)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          const body = await request.json().catch(() => ({}))
          const parsed = UpdateBody.safeParse(body)
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          const update: Record<string, unknown> = {}
          if (parsed.data.status !== undefined) {
            update.status = parsed.data.status
            if (parsed.data.status === 'identified') update.identifiedAt = new Date()
            if (parsed.data.status === 'resolved') update.resolvedAt = new Date()
          }
          if (parsed.data.title !== undefined) update.title = parsed.data.title
          if (parsed.data.description !== undefined) update.description = parsed.data.description

          const [updated] = await db
            .update(incidents)
            .set(update)
            .where(eq(incidents.id, params.id))
            .returning()
          return Response.json(updated)
        } catch (err) {
          console.error('admin incident patch error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
