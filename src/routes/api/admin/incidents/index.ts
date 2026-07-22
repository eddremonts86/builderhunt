import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { randomId } from '~/lib/utils'
import { createPlatformIncident, listPlatformIncidents } from '~/shared/lib/repositories/platform-content'

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  severity: z.enum(['minor', 'major', 'critical']).default('minor'),
  affectedComponents: z.array(z.string()).default([]),
})

export const Route = createFileRoute('/api/admin/incidents/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)
          const rows = await listPlatformIncidents()
          return Response.json(rows)
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin incidents list error:', err)
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
          await createPlatformIncident({
            id,
            title: parsed.data.title,
            description: parsed.data.description ?? null,
            severity: parsed.data.severity,
            affectedComponents: parsed.data.affectedComponents,
          })
          await auditPlatformAdminAction(principal, {
            action: 'admin.incident.create',
            targetType: 'incident',
            targetId: id,
            result: 'allowed',
          })
          return Response.json({ ok: true, id })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin incident create error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
