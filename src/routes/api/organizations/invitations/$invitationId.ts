import { createFileRoute } from '@tanstack/react-router'
import { getOrganizationLifecycle, OrganizationLifecycleError } from '~/shared/lib/auth/organization-lifecycle'
import { toInvitationSummaryDto } from '~/shared/lib/organizations/contracts'

export const Route = createFileRoute('/api/organizations/invitations/$invitationId')({
  component: () => null,
  server: {
    handlers: {
      // Resend. Neither handler needs `requireTenantPrincipal` — the
      // lifecycle functions resolve the caller's session themselves and
      // check membership against the INVITATION's own organization (looked
      // up server-side), never the caller's active org, which is exactly
      // what prevents a cross-org resend/cancel.
      POST: async ({ request, params }) => {
        try {
          const lifecycle = await getOrganizationLifecycle()
          const invitation = await lifecycle.resendInvitation(request, params.invitationId)
          return Response.json(toInvitationSummaryDto(invitation))
        } catch (error) {
          const response = lifecycleErrorResponse(error)
          if (response) return response
          console.error('Invitation resend error:', error)
          return Response.json({ error: 'Failed to resend invitation' }, { status: 500 })
        }
      },

      // Cancel.
      DELETE: async ({ request, params }) => {
        try {
          const lifecycle = await getOrganizationLifecycle()
          await lifecycle.cancelInvitation(request, params.invitationId)
          return Response.json({ ok: true })
        } catch (error) {
          const response = lifecycleErrorResponse(error)
          if (response) return response
          console.error('Invitation cancel error:', error)
          return Response.json({ error: 'Failed to cancel invitation' }, { status: 500 })
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
