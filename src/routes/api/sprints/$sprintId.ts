import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { SOURCING_SPRINT_LIMITS } from '~/shared/lib/billing-shared'
import { getOrganizationEntitlement } from '~/shared/lib/repositories/entitlements'
import { updateSprintSchema } from '~/shared/lib/sprints-shared'
import {
  deleteSprint,
  findSprint,
  renameSprint,
  setSprintLifecycle,
  SprintConflictError,
  SprintNotFoundError,
  updateSprintQuota,
} from '~/lib/sprints/service'

export const Route = createFileRoute('/api/sprints/$sprintId')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'PATCH', 'DELETE']),

      GET: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const sprint = await withTenantContext(principal, (tx) => findSprint(tx, principal.organizationId, params.sprintId))
          if (!sprint) return Response.json({ error: 'Sprint not found' }, { status: 404 })
          return Response.json(sprint)
        } catch (error) {
          return sprintDetailErrorResponse(error, 'Failed to fetch sprint')
        }
      },
      PATCH: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const parsed = updateSprintSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid update', details: parsed.error.flatten() }, { status: 400 })
          }
          const sprint = await withTenantContext(principal, async (tx) => {
            if ('action' in parsed.data) {
              const entitlement = await getOrganizationEntitlement(tx, principal.organizationId)
              // Same row the create gate and /pricing read — see sprints/index.ts.
              const limit = SOURCING_SPRINT_LIMITS[entitlement.tier]
              return setSprintLifecycle(tx, principal.organizationId, params.sprintId, parsed.data.action, limit)
            }
            if ('name' in parsed.data) return renameSprint(tx, principal.organizationId, params.sprintId, parsed.data.name)
            return updateSprintQuota(tx, principal.organizationId, params.sprintId, parsed.data.quota)
          })
          return Response.json(sprint)
        } catch (error) {
          return sprintDetailErrorResponse(error, 'Failed to update sprint')
        }
      },
      DELETE: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const deleted = await withTenantContext(principal, (tx) => deleteSprint(tx, principal.organizationId, params.sprintId))
          if (!deleted) return Response.json({ error: 'Sprint not found' }, { status: 404 })
          return Response.json({ success: true })
        } catch (error) {
          return sprintDetailErrorResponse(error, 'Failed to delete sprint')
        }
      },
    },
  },
})

function sprintDetailErrorResponse(error: unknown, message: string) {
  if (error instanceof TenantAuthorizationError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  if (error instanceof SprintNotFoundError) {
    return Response.json({ error: 'Sprint not found' }, { status: 404 })
  }
  if (error instanceof SprintConflictError) {
    return Response.json({ error: error.message }, { status: 409 })
  }
  console.error(message, error)
  return Response.json({ error: message }, { status: 500 })
}
