import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { getOrganizationLifecycle, OrganizationLifecycleError } from '~/shared/lib/auth/organization-lifecycle'
import { readInvitationPreviewBuilders } from '~/shared/lib/organizations/invitation-preview-builders'

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
          /**
           * Eligibility first, and the ordering is the security property.
           *
           * `reviewInvitation` throws for a signed-out, wrong-account, unverified, expired or
           * fabricated request. Reading the builders before it would let anyone holding a guessed
           * invitation id spend a database query — cheap here, but it is the shape of the mistake that
           * matters: the preview is a reward for passing the check, not something computed alongside it.
           */
          const review = await lifecycle.reviewInvitation(request, params.invitationId)
          /**
           * A failed preview must not fail the invitation.
           *
           * The three builders are decoration on a decision the recipient came here to make. If this
           * read throws, they still get the organization, the role and the buttons — an empty array,
           * which the page renders as no section at all rather than as an error.
           */
          const builders = await readInvitationPreviewBuilders(review.intent).catch((error) => {
            console.error('Invitation preview builders failed:', error)
            return []
          })
          return Response.json({ ...review, expiresAt: review.expiresAt.toISOString(), builders })
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
