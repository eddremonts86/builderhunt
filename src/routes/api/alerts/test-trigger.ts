import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { randomId } from '~/lib/utils'
import { evaluateMatch, recordTrigger, type TriggerConditions } from '~/shared/lib/alerts'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import {
  createOrganizationAlert,
  findOrganizationAlert,
} from '~/shared/lib/repositories/organization-alerts'

const Body = z.object({
  alertId: z.string().optional(),
  alertName: z.string().optional(),
  builderId: z.string().optional(),
  builder: z.object({
    followersCount: z.number().optional(),
    topics: z.array(z.string()).optional(),
    bio: z.string().optional(),
  }).optional(),
  event: z.object({
    type: z.enum(['new_repo', 'new_product', 'keyword_match', 'any_activity']),
    payload: z.record(z.string(), z.unknown()).default({}),
  }),
  conditions: z.object({
    eventType: z.enum(['new_repo', 'new_product', 'keyword_match', 'any_activity']),
    minStars: z.number().optional(),
    minFollowers: z.number().optional(),
    keywords: z.array(z.string()).optional(),
    builderId: z.string().optional(),
  }),
})

export const Route = createFileRoute('/api/alerts/test-trigger')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request }) => {
        try {
          if (env.NODE_ENV === 'production') return Response.json({ error: 'Not found' }, { status: 404 })
          const principal = await requireTenantPrincipal(request)
          const parsed = Body.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })
          const result = await withTenantContext(principal, async (tx) => {
            let alertId = parsed.data.alertId
            if (!alertId) {
              alertId = randomId()
              await createOrganizationAlert(tx, {
                id: alertId,
                organizationId: principal.organizationId,
                userId: principal.userId,
                name: parsed.data.alertName ?? 'Test alert',
                keywords: parsed.data.conditions.keywords ?? [],
                triggerConditions: parsed.data.conditions,
              })
            } else if (!await findOrganizationAlert(tx, principal.organizationId, alertId)) {
              return { status: 'not-found' as const, trigger: null }
            }
            const matches = evaluateMatch(
              parsed.data.conditions as TriggerConditions,
              parsed.data.builder ?? {},
              parsed.data.event,
            )
            if (!matches) return { status: 'no-match' as const, trigger: null }
            const trigger = await recordTrigger(tx, {
              organizationId: principal.organizationId,
              alertId,
              userId: principal.userId,
              builderId: parsed.data.builderId ?? null,
              eventType: parsed.data.event.type,
              payload: parsed.data.event.payload,
            })
            return { status: 'matched' as const, trigger }
          })
          if (result.status === 'not-found') {
            return Response.json({ error: 'Alert not found' }, { status: 404 })
          }
          return Response.json({ ok: true, matched: result.status === 'matched', trigger: result.trigger })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('test trigger error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
