import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { getOrganizationLifecycle, OrganizationLifecycleError } from '~/shared/lib/auth/organization-lifecycle'

export const Route = createFileRoute('/api/organizations/invitations/$invitationId/accept')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request, params }) => {
        try {
          const lifecycle = await getOrganizationLifecycle()
          const result = await lifecycle.acceptInvitation(request, params.invitationId)
          return Response.json({ ok: true, organizationId: result.organizationId })
        } catch (error) {
          const response = lifecycleErrorResponse(error)
          if (response) return response
          console.error('Invitation accept error:', error)
          return Response.json({ error: 'Failed to accept invitation' }, { status: 500 })
        }
      },
    },
  },
})

function lifecycleErrorResponse(error: unknown) {
  return error instanceof OrganizationLifecycleError
    ? Response.json({ error: error.message }, { status: error.status })
    : null
}
