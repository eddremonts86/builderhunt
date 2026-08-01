import { createFileRoute } from '@tanstack/react-router'
import { briefContextForEvent } from '~/lib/interviews/brief-context'
import { requireTenantPrincipal } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { listParticipants } from '~/shared/lib/repositories/calendar'
// Outside `src/routes` on purpose — see the sibling `$participantId.ts`'s own note on this import.
import { errorResponse } from '~/lib/interviews/report-http'

/**
 * Lists one interview's participants for the material-access control panel (plans/UI Wave 3 "Add
 * interview participant material-access controls").
 *
 * Owner-only, same as the PATCH on `$participantId` that grants/revokes access — administering who
 * can read a candidate's material is the owner's act alone, not a thing a granted colleague needs to
 * browse. The same 404-vs-403 split as the PATCH route: no relationship to the interview at all is
 * 404 (an interview existing at this id is not confirmed to a stranger); a participant who can
 * already read the material but isn't the owner is 403 (they already know it exists).
 */
export const Route = createFileRoute('/api/interviews/$interviewId/participants/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const outcome = await withTenantContext(principal, async (transaction) => {
            const context = await briefContextForEvent(transaction, principal, params.interviewId)
            if (!context) return { kind: 'not_found' as const }
            if (!context.isOwner) return { kind: 'not_owner' as const }
            const rows = await listParticipants(transaction, principal.organizationId, params.interviewId)
            return { kind: 'ok' as const, rows }
          })

          if (outcome.kind === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 })
          if (outcome.kind === 'not_owner') return Response.json({ error: 'not_owner' }, { status: 403 })

          return Response.json({
            participants: outcome.rows.map((row) => ({
              id: row.id,
              displayName: row.displayName,
              externalEmail: row.externalEmail,
              role: row.role,
              response: row.response,
              accessGranted: row.accessGranted,
              materialAccessGranted: row.materialAccessGranted,
            })),
          })
        } catch (error) {
          return errorResponse(error, 'interview participants list')
        }
      },
    },
  },
})
