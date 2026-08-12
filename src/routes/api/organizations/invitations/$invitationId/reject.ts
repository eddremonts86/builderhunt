import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { getOrganizationLifecycle, OrganizationLifecycleError } from '~/shared/lib/auth/organization-lifecycle'

/**
 * Declining an invitation (plan 59).
 *
 * Same eligibility boundary as review and accept, so declining reveals no more than reading does. It
 * creates no membership and activates no organization — the invitation row is the whole state a
 * decline owns.
 *
 * A decline that races an accept loses: exactly one `pending`-state transition wins, and the loser
 * gets the generic invalid response rather than a confirmation for something already joined.
 */
export const Route = createFileRoute('/api/organizations/invitations/$invitationId/reject')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request, params }) => {
        try {
          const lifecycle = await getOrganizationLifecycle()
          await lifecycle.rejectInvitation(request, params.invitationId)
          return Response.json({ ok: true })
        } catch (error) {
          const response = lifecycleErrorResponse(error)
          if (response) return response
          console.error('Invitation reject error:', error)
          return Response.json({ error: 'Failed to decline invitation' }, { status: 500 })
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
