import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { getOrganizationLifecycle, OrganizationLifecycleError } from '~/shared/lib/auth/organization-lifecycle'

/**
 * What a verified recipient may read before deciding (plan 59).
 *
 * Every rejection is the same `403 { error: 'This invitation is no longer valid' }` that accept and
 * reject answer with, because the eligibility check is literally the same function. A distinguishable
 * 404 would make this an existence oracle for invitation ids.
 *
 * The DTO is built inside the lifecycle, not here, so a route cannot widen it: this handler only
 * serializes `expiresAt`.
 */
export const Route = createFileRoute('/api/organizations/invitations/$invitationId/review')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request, params }) => {
        try {
          const lifecycle = await getOrganizationLifecycle()
          const review = await lifecycle.reviewInvitation(request, params.invitationId)
          return Response.json({ ...review, expiresAt: review.expiresAt.toISOString() })
        } catch (error) {
          const response = lifecycleErrorResponse(error)
          if (response) return response
          // Deliberately not echoed to the caller: an internal failure must not become a different
          // answer for a valid recipient than for an invalid one.
          console.error('Invitation review error:', error)
          return Response.json({ error: 'Failed to load invitation' }, { status: 500 })
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
