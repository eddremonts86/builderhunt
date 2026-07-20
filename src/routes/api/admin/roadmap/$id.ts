import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auth } from '~/shared/lib/auth/better-auth'
import { deletePlatformRoadmapItem, updatePlatformRoadmapItem } from '~/shared/lib/repositories/platform-content'

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '').split(',').filter(Boolean)

const UpdateBody = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(['planned', 'in_progress', 'shipped']).optional(),
  shipEstimate: z.string().optional(),
  category: z.string().optional(),
  sortOrder: z.number().int().optional(),
})

function isAdmin(userId: string): boolean {
  return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(userId)
}

export const Route = createFileRoute('/api/admin/roadmap/$id')({
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
          const update: Record<string, unknown> = { ...parsed.data }
          if (parsed.data.status === 'shipped') update.shippedAt = new Date()
          if (parsed.data.status && parsed.data.status !== 'shipped') update.shippedAt = null
          const updated = await updatePlatformRoadmapItem(params.id, update)
          if (!updated) return Response.json({ error: 'Not found' }, { status: 404 })
          return Response.json(updated)
        } catch (err) {
          console.error('admin roadmap patch error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
      DELETE: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id || !isAdmin(session.user.id)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          await deletePlatformRoadmapItem(params.id)
          return Response.json({ ok: true })
        } catch (err) {
          console.error('admin roadmap delete error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
