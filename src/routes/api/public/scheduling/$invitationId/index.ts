import { createFileRoute } from '@tanstack/react-router'
import {
  BOOKING_REQUIRED_PURPOSES,
  CANDIDATE_NOTICE,
  guardPublicRequest,
  publicError,
  withCapabilityRequest,
  withPublicHeaders,
} from '~/lib/scheduling/public-route-support'
import { findInvitationByCapabilityHash, listConsentsForInvitation } from '~/shared/lib/repositories/scheduling'

/**
 * The candidate's view of their own invitation (plan:
 * calendar-scheduling-interview-intelligence, Phase 5).
 *
 * The response is the repository's `PublicInvitationDto` plus the consent state, and nothing else:
 * no organizer identity, no organization id, no candidate list, no other invitations. What the
 * candidate can see here is the union of what they were told in the email and what they themselves
 * decided.
 *
 * The consent summary is included so a returning candidate sees which purposes they already granted
 * and can withdraw one without re-reading the whole notice.
 */
export const Route = createFileRoute('/api/public/scheduling/$invitationId/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const refused = await guardPublicRequest(request, false)
        if (refused) return refused

        try {
          const result = await withCapabilityRequest(request, params.invitationId, async ({ transaction, tenant }) => {
            const invitation = await findInvitationByCapabilityHash(transaction, tenant.capabilityHash, new Date())
            if (!invitation) return null
            const consents = await listConsentsForInvitation(transaction, tenant.organizationId, tenant.invitationId)
            return { invitation, consents }
          })

          if (!result.ok || !result.value) return withPublicHeaders(publicError('invitation_unavailable'))

          const { invitation, consents } = result.value
          return withPublicHeaders(Response.json({
            ...invitation,
            noticeVersion: CANDIDATE_NOTICE,
            requiredPurposes: BOOKING_REQUIRED_PURPOSES,
            consents: consents.map((consent) => ({
              id: consent.id,
              purpose: consent.purpose,
              decision: consent.decision,
              noticeVersion: consent.noticeVersion,
              decidedAt: consent.decidedAt.toISOString(),
              withdrawnAt: consent.withdrawnAt?.toISOString() ?? null,
            })),
          }))
        } catch (error) {
          console.error('public scheduling invitation error:', error)
          return withPublicHeaders(publicError('invalid_input'))
        }
      },
    },
  },
})
