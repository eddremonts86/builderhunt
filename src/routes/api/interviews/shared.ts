import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { listInterviewsSharedWithMe } from '~/shared/lib/repositories/interviews'

/**
 * "Shared with me": every booked interview where the caller holds an active material grant, but
 * does not own (plans/UI Wave 3 "Add a tenant-safe Shared with me interview list").
 *
 * A sibling of `GET /api/interviews/`, not a parameter on it — that route's own contract is
 * deliberately owner-scoped so its shape cannot change if a policy is ever widened. This one is
 * scoped by `event_participants.material_access_granted` instead, and RLS still enforces the tenant
 * and grant boundary underneath both. Same redacted field set as the owner list: enough to navigate
 * to the brief/report/transcript and show what is available, nothing about how the grant was made or
 * who else might see it.
 */
export const Route = createFileRoute('/api/interviews/shared')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const interviews = await withTenantContext(principal, (transaction) => listInterviewsSharedWithMe(
            transaction,
            { organizationId: principal.organizationId, userId: principal.userId },
          ))

          return Response.json({
            interviews: interviews.map((row) => ({
              eventId: row.eventId,
              roleTitle: row.roleTitle,
              candidateDisplayName: row.candidateDisplayName,
              startsAt: row.startsAt.toISOString(),
              endsAt: row.endsAt.toISOString(),
              timezone: row.timezone,
              modality: row.modality,
              meetingUrl: row.meetingUrl,
              location: row.location,
              eventStatus: row.eventStatus,
              sessionState: row.sessionState,
              hasBrief: row.hasBrief,
              reportStatus: row.reportStatus,
              transcriptSegments: row.transcriptSegments,
            })),
          })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: 'forbidden' }, { status: error.status })
          }
          console.error('shared interview list error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },
    },
  },
})
