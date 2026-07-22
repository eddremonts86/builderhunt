import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { getOrganizationLifecycle, OrganizationLifecycleError } from '~/shared/lib/auth/organization-lifecycle'

const Body = z.object({
  targetUserId: z.string().min(1),
})

export const Route = createFileRoute('/api/organizations/transfer-ownership')({
  component: () => null,
  server: {
    handlers: {
      // The organization being acted on always comes from the caller's own
      // session (`requireTenantPrincipal`), never from the request body —
      // only the target member id is client-supplied, and the lifecycle
      // service itself re-validates that target belongs to that same org.
      POST: async ({ request }) => {
        try {
          const parsed = Body.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          const principal = await requireTenantPrincipal(request)
          const lifecycle = await getOrganizationLifecycle()
          await lifecycle.transferOwnership(request, principal.organizationId, parsed.data.targetUserId)
          return Response.json({ ok: true })
        } catch (error) {
          const response = lifecycleErrorResponse(error)
          if (response) return response
          console.error('Ownership transfer error:', error)
          return Response.json({ error: 'Failed to transfer ownership' }, { status: 500 })
        }
      },
    },
  },
})

function lifecycleErrorResponse(error: unknown) {
  if (error instanceof OrganizationLifecycleError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  if (error instanceof TenantAuthorizationError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  return null
}
