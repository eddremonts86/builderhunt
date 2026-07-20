import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { rateLimit } from '~/shared/lib/rate-limit'
import { SOURCING_SPRINT_LIMITS } from '~/shared/lib/billing-shared'
import { getOrganizationEntitlement } from '~/shared/lib/repositories/entitlements'
import { createSprintSchema } from '~/shared/lib/sprints-shared'
import { countActiveSprints, createSprint, listSprints } from '~/lib/sprints/service'

export const Route = createFileRoute('/api/sprints/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const rows = await withTenantContext(principal, (tx) => listSprints(tx, principal.organizationId))
          return Response.json(rows)
        } catch (error) {
          return sprintErrorResponse(error, 'Failed to fetch sprints')
        }
      },
      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const rl = await rateLimit('sprint-create', `${principal.organizationId}:${principal.userId}`, 10, 24 * 60 * 60)
          if (!rl.allowed) {
            return Response.json(
              { error: 'Too many sprints created today. Try again tomorrow.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.resetMs / 1000)) } },
            )
          }
          const parsed = createSprintSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid sprint', details: parsed.error.flatten() }, { status: 400 })
          }
          const created = await withTenantContext(principal, async (tx) => {
            const entitlement = await getOrganizationEntitlement(tx, principal.organizationId)
            const limit = SOURCING_SPRINT_LIMITS[entitlement.tier]
            const current = await countActiveSprints(tx, principal.organizationId)
            if (current >= limit) return { sprint: null, current, limit, plan: entitlement.tier }
            const sprint = await createSprint(tx, principal.organizationId, principal.userId, parsed.data)
            return { sprint, current, limit, plan: entitlement.tier }
          })
          if (!created.sprint) {
            return Response.json(
              {
                error: 'You have reached the active sourcing sprint limit for your plan.',
                current: created.current,
                limit: created.limit,
                plan: created.plan,
                upgradeUrl: '/pricing',
              },
              { status: 402 },
            )
          }
          return Response.json(created.sprint, { status: 201 })
        } catch (error) {
          return sprintErrorResponse(error, 'Failed to create sprint')
        }
      },
    },
  },
})

export function sprintErrorResponse(error: unknown, message: string) {
  if (error instanceof TenantAuthorizationError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  console.error(message, error)
  return Response.json({ error: message }, { status: 500 })
}
