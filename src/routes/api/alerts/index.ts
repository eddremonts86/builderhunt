import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { randomId } from '~/lib/utils'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { rateLimit } from '~/shared/lib/rate-limit'
import { getOrganizationEntitlement } from '~/shared/lib/repositories/entitlements'
import {
  createOrganizationAlert,
  createOrganizationAlertFromQueryForPrincipal,
  deleteOrganizationAlert,
  pageOrganizationAlerts,
} from '~/shared/lib/repositories/organization-alerts'
import { alertsCapability } from '~/shared/lib/table/capabilities/alerts'
import { tablePageHandler } from '~/shared/lib/table/handler'
import { SharedResourceError, stripOrganizationAuthority } from '~/shared/lib/shared-resources/contracts'

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
  /**
   * Optional saved-query id this alert is being created from. When
   * present, the principal-scoped repository:
   *  - validates the query is visible to the caller
   *  - copies the query's keywords into the alert
   *  - sets the alert.queryId so the alert is tied to the source
   * Sharing the query does NOT create an alert — the recipient must
   * opt in explicitly via this body field.
   */
  queryId: z.string().min(1).max(128).optional(),
})

export const Route = createFileRoute('/api/alerts/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST', 'DELETE']),

      /**
       * One keyset page of the organization's radars.
       *
       * A `PageResult` now, not the bare array it was. The only consumer is the alerts page, which
       * reads it as a grid.
       */
      GET: async ({ request }) => tablePageHandler({
        capability: alertsCapability,
        request,
        load: ({ transaction, search }) => pageOrganizationAlerts(transaction, search.query, search.page),
      }),
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
          const raw = await request.json().catch(() => ({}))
          // stripOrganizationAuthority is the same guard every
          // shared-resources route uses: a client-supplied
          // organizationId is data, never authority, and is dropped
          // before the principal-scoped repository decides anything.
          const body = stripOrganizationAuthority(
            (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>,
          )
          const parsed = CreateBody.safeParse(body)
          if (!parsed.success) {
            return Response.json({ error: 'Invalid alert', details: parsed.error.flatten() }, { status: 400 })
          }
          const row = await withTenantContext(principal, async (tx) => {
            const entitlement = await getOrganizationEntitlement(tx, principal.organizationId)
            if (!entitlement.paidActionsAllowed) return null
            // When queryId is provided, take the principal-scoped
            // path: it validates visibility, copies the source
            // query's keywords, and threads queryId through the
            // composite FK. Sharing a query alone creates no alert
            // — only an explicit opt-in here does.
            if (parsed.data.queryId) {
              return createOrganizationAlertFromQueryForPrincipal(tx, principal, {
                name: parsed.data.name,
                queryId: parsed.data.queryId,
                frequency: parsed.data.frequency,
                deliveryChannel: parsed.data.deliveryChannel,
                triggerConditions: parsed.data.triggerConditions,
              })
            }
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
  if (error instanceof SharedResourceError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status })
  }
  if (error instanceof TenantAuthorizationError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  console.error(message, error)
  return Response.json({ error: message }, { status: 500 })
}
