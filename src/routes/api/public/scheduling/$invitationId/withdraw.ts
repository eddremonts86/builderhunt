import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { withdrawPurpose } from '~/lib/scheduling/consent-service'
import {
  guardPublicRequest,
  publicError,
  withCapabilityRequest,
  withPublicHeaders,
} from '~/lib/scheduling/public-route-support'
import { withdrawConsentRequestSchema } from '~/shared/lib/interview-api'

/**
 * The candidate withdraws one processing purpose (plan:
 * calendar-scheduling-interview-intelligence, Phase 5).
 *
 * This deliberately does not cancel the interview. spec.md: "Withdrawing live transcription changes
 * the appointment to manual-only rather than cancelling it." A candidate who is uncomfortable with
 * being transcribed should not have to choose between that and attending.
 *
 * `affectedState` tells the portal what actually changes, so the confirmation the candidate reads is
 * specific rather than a generic acknowledgement. Withdrawing transcription puts the session into
 * manual-only mode; the other purposes stop future processing without changing how the interview is
 * conducted.
 */
export const Route = createFileRoute('/api/public/scheduling/$invitationId/withdraw')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request, params }) => {
        const refused = await guardPublicRequest(request, true)
        if (refused) return refused

        const parsed = withdrawConsentRequestSchema.safeParse(await request.json().catch(() => ({})))
        if (!parsed.success) return withPublicHeaders(publicError('invalid_input'))

        try {
          const result = await withCapabilityRequest(request, params.invitationId, ({ transaction, tenant }) =>
            withdrawPurpose(transaction, {
              organizationId: tenant.organizationId,
              invitationId: tenant.invitationId,
              purpose: parsed.data.purpose,
            }))

          if (!result.ok) return withPublicHeaders(publicError('invitation_unavailable'))

          return withPublicHeaders(Response.json({
            purpose: parsed.data.purpose,
            withdrawn: result.value.withdrawn,
            withdrawnAt: result.value.withdrawnAt?.toISOString() ?? null,
            affectedState: parsed.data.purpose === 'live_audio_transcription' ? 'manual_only' : 'unaffected',
          }))
        } catch (error) {
          console.error('public scheduling withdraw error:', error)
          return withPublicHeaders(publicError('invalid_input'))
        }
      },
    },
  },
})
