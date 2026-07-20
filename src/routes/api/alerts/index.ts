import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { randomId } from '~/lib/utils'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { rateLimit } from '~/shared/lib/rate-limit'
import { getOrganizationEntitlement } from '~/shared/lib/repositories/entitlements'
import {
  createOrganizationAlert,
  deleteOrganizationAlert,
  listOrganizationAlerts,
} from '~/shared/lib/repositories/organization-alerts'

const CreateBody = z.object({
  name: z.string().min(1).max(100),
  keywords: z.array(z.string()).default([]),
  frequency: z.enum(['hourly', 'daily', 'weekly']).default('daily'),
  deliveryChannel: z.enum(['email', 'dashboard']).default('email'),
  triggerConditions: z.object({
    eventType: z.enum(['new_repo', 'new_product', 'keyword_match', 'any_activity']),
    minStars: z.number().min(0).optional(),
    minFollowers: z.number().min(0).optional(),
    keywords: z.array(z.string()).optional(),
    builderId: z.string().optional(),
  }),
})

export const Route = createFileRoute('/api/alerts/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const rows = await withTenantContext(principal, (tx) =>
            listOrganizationAlerts(tx, principal.organizationId),
          )
          return Response.json(rows)
        } catch (error) {
          return alertErrorResponse(error, 'Failed to fetch alerts')
        }
      },
      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const rl = await rateLimit(
            'alert-create',
            `${principal.organizationId}:${principal.userId}`,
            20,
            24 * 60 * 60,
          )
          if (!rl.allowed) {
            return Response.json(
              { error: 'Too many alerts created today. Try again tomorrow.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.resetMs / 1000)) } },
            )
          }
          const parsed = CreateBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid alert', details: parsed.error.flatten() }, { status: 400 })
          }
          const row = await withTenantContext(principal, async (tx) => {
            const entitlement = await getOrganizationEntitlement(tx, principal.organizationId)
            if (!entitlement.paidActionsAllowed) return null
            return createOrganizationAlert(tx, {
              id: randomId(),
              organizationId: principal.organizationId,
              userId: principal.userId,
              name: parsed.data.name.trim(),
              keywords: parsed.data.keywords,
              frequency: parsed.data.frequency,
              deliveryChannel: parsed.data.deliveryChannel,
              triggerConditions: parsed.data.triggerConditions,
            })
          })
          if (!row) {
            return Response.json(
              { error: 'Smart alerts are a Pro feature. Upgrade to create alerts.', upgradeUrl: '/pricing' },
              { status: 402 },
            )
          }
          return Response.json(row)
        } catch (error) {
          return alertErrorResponse(error, 'Failed to create alert')
        }
      },
      DELETE: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const body = await request.json().catch(() => ({})) as { id?: unknown }
          if (typeof body.id !== 'string' || !body.id) {
            return Response.json({ error: 'id is required' }, { status: 400 })
          }
          const deleted = await withTenantContext(principal, (tx) =>
            deleteOrganizationAlert(tx, principal.organizationId, body.id as string),
          )
          if (!deleted) return Response.json({ error: 'Alert not found' }, { status: 404 })
          return Response.json({ success: true })
        } catch (error) {
          return alertErrorResponse(error, 'Failed to delete alert')
        }
      },
    },
  },
})

function alertErrorResponse(error: unknown, message: string) {
  if (error instanceof TenantAuthorizationError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  console.error(message, error)
  return Response.json({ error: message }, { status: 500 })
}
