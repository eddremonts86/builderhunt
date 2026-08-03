import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { getOrganizationLifecycle, OrganizationLifecycleError } from '~/shared/lib/auth/organization-lifecycle'

const RoleBody = z.object({
  role: z.enum(['admin', 'member']),
})

export const Route = createFileRoute('/api/organizations/members/$memberId')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['PATCH', 'DELETE']),

      // The target member is `params.memberId` (a user id, matching
      // `OrganizationMemberDto.userId`); the organization itself always comes
      // from the caller's own session via `requireTenantPrincipal` — never
      // from the request body/params/query — so there is nothing here a
      // client could spoof to act against an organization it isn't in.
      PATCH: async ({ request, params }) => {
        try {
          const parsed = RoleBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          const principal = await requireTenantPrincipal(request)
          const lifecycle = await getOrganizationLifecycle()
          await lifecycle.changeMemberRole(request, principal.organizationId, params.memberId, parsed.data.role)
          return Response.json({ ok: true })
        } catch (error) {
          const response = lifecycleErrorResponse(error)
          if (response) return response
          console.error('Member role change error:', error)
          return Response.json({ error: 'Failed to update member role' }, { status: 500 })
        }
      },

      DELETE: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const lifecycle = await getOrganizationLifecycle()
          await lifecycle.removeMember(request, principal.organizationId, params.memberId)
          return Response.json({ ok: true })
        } catch (error) {
          const response = lifecycleErrorResponse(error)
          if (response) return response
          console.error('Member removal error:', error)
          return Response.json({ error: 'Failed to remove member' }, { status: 500 })
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
