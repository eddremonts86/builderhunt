import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { listInterviewsForOwner } from '~/shared/lib/repositories/interviews'

/**
 * The organizer's interview list (plan:
 * calendar-scheduling-interview-intelligence, Phase 10 follow-up).
 *
 * This exists because nothing did. `/interviews/$interviewId` was the only route, so reaching an interview
 * required knowing a calendar event's uuid — and in practice that meant typing one by hand.
 *
 * ## Scoped to the owner, not the organization
 *
 * A colleague granted access to one interview should see that interview, not a roster of everyone's
 * candidates. RLS would already refuse them the rows, but the query is owner-scoped as well so the *shape*
 * of the page cannot change if a policy is ever widened.
 */
export const Route = createFileRoute('/api/interviews/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const interviews = await withTenantContext(principal, (transaction) => listInterviewsForOwner(
            transaction,
            { organizationId: principal.organizationId, ownerUserId: principal.userId },
          ))

          return Response.json({
            interviews: interviews.map((row) => ({
              eventId: row.eventId,
              roleTitle: row.roleTitle,
              // The candidate's name is the point of the row — the organizer is looking for a person, not a
              // uuid. It is already visible to them everywhere else in this feature.
              candidateDisplayName: row.candidateDisplayName,
              startsAt: row.startsAt.toISOString(),
              endsAt: row.endsAt.toISOString(),
              timezone: row.timezone,
              modality: row.modality,
              // The meeting URL, because the organizer's first action five minutes before an interview is
              // to open the call. Nothing generates one — it is whatever they entered on the invitation.
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
          console.error('interview list error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },
    },
  },
})
