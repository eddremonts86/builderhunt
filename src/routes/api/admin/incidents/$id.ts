import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { updatePlatformIncident } from '~/shared/lib/repositories/platform-content'

const UpdateBody = z.object({
  status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
})

export const Route = createFileRoute('/api/admin/incidents/$id')({
  component: () => null,
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
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

          const updated = await updatePlatformIncident(params.id, update)
          await auditPlatformAdminAction(principal, {
            action: 'admin.incident.update',
            targetType: 'incident',
            targetId: params.id,
            result: 'allowed',
          })
          return Response.json(updated)
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin incident patch error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
