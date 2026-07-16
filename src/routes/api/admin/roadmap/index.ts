import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { db } from '~/shared/lib/db/index'
import { roadmapItems } from '~/shared/lib/db/schema'
import { asc, desc } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'
import { randomId } from '~/lib/utils'

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '').split(',').filter(Boolean)

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  status: z.enum(['planned', 'in_progress', 'shipped']).default('planned'),
  shipEstimate: z.string().optional(),
  category: z.string().default('general'),
  sortOrder: z.number().int().default(0),
})

function isAdmin(userId: string): boolean {
  return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(userId)
}

export const Route = createFileRoute('/api/admin/roadmap/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id || !isAdmin(session.user.id)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          const rows = await db
            .select()
            .from(roadmapItems)
            .orderBy(asc(roadmapItems.sortOrder), desc(roadmapItems.createdAt))
          return Response.json(rows)
        } catch (err) {
          console.error('admin roadmap list error:', err)
          return Response.json([])
        }
      },
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id || !isAdmin(session.user.id)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          const body = await request.json().catch(() => ({}))
          const parsed = CreateBody.safeParse(body)
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          const id = randomId()
          await db.insert(roadmapItems).values({
            id,
            title: parsed.data.title,
            description: parsed.data.description ?? null,
            status: parsed.data.status,
            shipEstimate: parsed.data.shipEstimate ?? null,
            category: parsed.data.category,
            sortOrder: parsed.data.sortOrder,
            shippedAt: parsed.data.status === 'shipped' ? new Date() : null,
          })
          return Response.json({ ok: true, id })
        } catch (err) {
          console.error('admin roadmap create error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
