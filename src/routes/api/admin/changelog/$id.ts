import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { db } from '~/shared/lib/db/index'
import { changelog } from '~/shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '').split(',').filter(Boolean)

const UpdateBody = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  slug: z.string().optional(),
})

function isAdmin(userId: string): boolean {
  return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(userId)
}

export const Route = createFileRoute('/api/admin/changelog/$id')({
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
          const [updated] = await db
            .update(changelog)
            .set(parsed.data)
            .where(eq(changelog.id, params.id))
            .returning()
          if (!updated) return Response.json({ error: 'Not found' }, { status: 404 })
          return Response.json(updated)
        } catch (err) {
          console.error('admin changelog patch error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
      DELETE: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id || !isAdmin(session.user.id)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          await db.delete(changelog).where(eq(changelog.id, params.id))
          return Response.json({ ok: true })
        } catch (err) {
          console.error('admin changelog delete error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
