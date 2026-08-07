import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { rateLimit } from '~/shared/lib/rate-limit'
import { SOURCING_SPRINT_LIMITS } from '~/shared/lib/billing-shared'
import { getOrganizationEntitlement } from '~/shared/lib/repositories/entitlements'
import { createSprintSchema } from '~/shared/lib/sprints-shared'
import { countActiveSprints, createSprint, pageSprints } from '~/lib/sprints/service'
import { sprintsCapability } from '~/shared/lib/table/capabilities/sprints'
import { tablePageHandler } from '~/shared/lib/table/handler'

export const Route = createFileRoute('/api/sprints/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST']),

      /**
       * One keyset page of the organization's sprints.
       *
       * The response is a `PageResult`, not the bare array it used to be. Both callers were
       * updated with it — the sprints page and the dashboard's sprint tile — and the second is the
       * one worth noting: it wrapped the response in an `asArray` helper that turns anything
       * non-array into `[]`, so a shape change there would have blanked the tile with no error
       * anywhere.
       */
      GET: async ({ request }) => tablePageHandler({
        capability: sprintsCapability,
        request,
        load: ({ transaction, search }) => pageSprints(transaction, search.query, search.page),
      }),
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
            // Indexed by the entitlement tier itself — Pro Max has its own row,
            // so this is the same number /pricing advertises.
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
