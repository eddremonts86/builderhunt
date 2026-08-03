import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { deletePlatformRoadmapItem, updatePlatformRoadmapItem } from '~/shared/lib/repositories/platform-content'

const UpdateBody = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(['planned', 'in_progress', 'shipped']).optional(),
  shipEstimate: z.string().optional(),
  category: z.string().optional(),
  sortOrder: z.number().int().optional(),
})

export const Route = createFileRoute('/api/admin/roadmap/$id')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['PATCH', 'DELETE']),

      PATCH: async ({ request, params }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const body = await request.json().catch(() => ({}))
          const parsed = UpdateBody.safeParse(body)
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })
          const update: Record<string, unknown> = { ...parsed.data }
          if (parsed.data.status === 'shipped') update.shippedAt = new Date()
          if (parsed.data.status && parsed.data.status !== 'shipped') update.shippedAt = null
          const updated = await updatePlatformRoadmapItem(params.id, update)
          if (!updated) return Response.json({ error: 'Not found' }, { status: 404 })
          await auditPlatformAdminAction(principal, {
            action: 'admin.roadmap.update',
            targetType: 'roadmap',
            targetId: params.id,
            result: 'allowed',
          })
          return Response.json(updated)
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin roadmap patch error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
      DELETE: async ({ request, params }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          await deletePlatformRoadmapItem(params.id)
          await auditPlatformAdminAction(principal, {
            action: 'admin.roadmap.delete',
            targetType: 'roadmap',
            targetId: params.id,
            result: 'allowed',
          })
          return Response.json({ ok: true })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin roadmap delete error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
