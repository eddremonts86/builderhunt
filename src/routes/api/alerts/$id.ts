import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { updateOrganizationAlert } from '~/shared/lib/repositories/organization-alerts'

const UpdateBody = z.object({
  enabled: z.boolean().optional(),
  name: z.string().min(1).max(100).optional(),
  frequency: z.enum(['hourly', 'daily', 'weekly']).optional(),
  deliveryChannel: z.enum(['email', 'dashboard']).optional(),
  triggerConditions: z.object({
    eventType: z.enum(['new_repo', 'new_product', 'keyword_match', 'any_activity']),
    minStars: z.number().min(0).optional(),
    minFollowers: z.number().min(0).optional(),
    keywords: z.array(z.string()).optional(),
    builderId: z.string().optional(),
  }).optional(),
})

export const Route = createFileRoute('/api/alerts/$id')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['PATCH']),

      PATCH: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const parsed = UpdateBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid alert', details: parsed.error.flatten() }, { status: 400 })
          }
          const { name, ...rest } = parsed.data
          const row = await withTenantContext(principal, (tx) =>
            updateOrganizationAlert(tx, principal.organizationId, params.id, {
              ...rest,
              ...(name !== undefined ? { name: name.trim() } : {}),
            }),
          )
          if (!row) return Response.json({ error: 'Alert not found' }, { status: 404 })
          return Response.json(row)
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Alert update error:', error)
          return Response.json({ error: 'Failed to update alert' }, { status: 500 })
        }
      },
    },
  },
})
