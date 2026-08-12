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
          /**
           * `activeOrganization: false` is a 200, not an error.
           *
           * The membership committed before the session switch was attempted, so the person is a
           * member either way. A 500 here would tell them their acceptance failed, and the retry
           * would hit an invitation that is no longer pending and answer with the generic invalid
           * error — turning a succeeded join into an apparently permanent failure.
           */
          return Response.json({
            ok: true,
            organizationId: result.organizationId,
            activeOrganization: result.activeOrganization,
            suggestedQuery: result.suggestedQuery,
          })
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
