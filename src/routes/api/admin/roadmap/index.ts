import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { randomId } from '~/lib/utils'
import { createPlatformRoadmapItem, listPlatformRoadmap } from '~/shared/lib/repositories/platform-content'

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  status: z.enum(['planned', 'in_progress', 'shipped']).default('planned'),
  shipEstimate: z.string().optional(),
  category: z.string().default('general'),
  sortOrder: z.number().int().default(0),
})

export const Route = createFileRoute('/api/admin/roadmap/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)
          const rows = await listPlatformRoadmap()
          return Response.json(rows)
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin roadmap list error:', err)
          return Response.json([])
        }
      },
      POST: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const body = await request.json().catch(() => ({}))
          const parsed = CreateBody.safeParse(body)
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          const id = randomId()
          await createPlatformRoadmapItem({
            id,
            title: parsed.data.title,
            description: parsed.data.description ?? null,
            status: parsed.data.status,
            shipEstimate: parsed.data.shipEstimate ?? null,
            category: parsed.data.category,
            sortOrder: parsed.data.sortOrder,
            shippedAt: parsed.data.status === 'shipped' ? new Date() : null,
          })
          await auditPlatformAdminAction(principal, {
            action: 'admin.roadmap.create',
            targetType: 'roadmap',
            targetId: id,
            result: 'allowed',
          })
          return Response.json({ ok: true, id })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin roadmap create error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
