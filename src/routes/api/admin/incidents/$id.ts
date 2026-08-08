import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { updatePlatformIncident } from '~/shared/lib/repositories/platform-content'
import { listConfirmedActive } from '~/shared/lib/repositories/status-subscribers'
import { sendIncidentStatusEmail } from '~/shared/lib/email'
import { drainSweep } from '~/shared/lib/db/read-bounds'

const UpdateBody = z.object({
  status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
})

export const Route = createFileRoute('/api/admin/incidents/$id')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['PATCH']),

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
          // Plan 47 (status-and-trust) Phase 2: if the admin just
          // marked the incident resolved, send the resolution
          // email to the public subscriber list. Best-effort.
          if (parsed.data.status === 'resolved') {
            try {
              const subscribers = await drainSweep((after, limit) => listConfirmedActive(undefined, after, limit), (row) => row.id)
              const appUrl = (process.env.APP_URL ?? 'https://builderhunt.example').replace(/\/$/, '')
              await Promise.allSettled(
                subscribers.map((s) =>
                  sendIncidentStatusEmail({
                    to: s.email,
                    manageSubscriptionUrl: `${appUrl}/status`,
                    incidentId: params.id,
                    incidentTitle: (updated as { title?: string } | null)?.title ?? 'Incident',
                    incidentStatus: 'resolved',
                    incidentSeverity: 'minor',
                    incidentDescription: null,
                    statusPageUrl: `${appUrl}/status`,
                  }),
                ),
              )
            } catch (err) {
              console.error('status subscriber resolve notify failed:', err)
            }
          }
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
