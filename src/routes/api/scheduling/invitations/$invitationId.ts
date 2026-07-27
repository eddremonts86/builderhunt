import { createFileRoute } from '@tanstack/react-router'
import { getInvitation } from '~/lib/scheduling/invitation-service'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { invitationFailureResponse, schedulingDisabledResponse, toInvitationDto } from './index'

/**
 * One invitation, owner-only (plan: calendar-scheduling-interview-intelligence, Phase 5 "Add
 * authenticated invitation APIs").
 *
 * A row belonging to another member of the same organization answers 404, not 403. The service
 * returns `not_found` for both cases on purpose: a 403 would confirm the invitation exists, which
 * turns id enumeration into a way to learn who is interviewing whom inside the org.
 */
export const Route = createFileRoute('/api/scheduling/invitations/$invitationId')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          if (env.SCHEDULING_ENABLED === 'false') return schedulingDisabledResponse()
          const principal = await requireTenantPrincipal(request)
          const result = await withTenantContext(principal, (tx) =>
            getInvitation(tx, principal, params.invitationId))
          if (!result.ok) return invitationFailureResponse(result)
          return Response.json(toInvitationDto(result.value))
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: 'authentication_required' }, { status: 401 })
          }
          console.error('scheduling invitation detail route error:', error)
          return Response.json({ error: 'invalid_input' }, { status: 400 })
        }
      },
    },
  },
})
