import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { recordDecisions } from '~/lib/scheduling/consent-service'
import {
  CANDIDATE_NOTICE,
  guardPublicRequest,
  publicError,
  withCapabilityRequest,
  withPublicHeaders,
} from '~/lib/scheduling/public-route-support'
import { putCandidateSubmissionRequestSchema } from '~/shared/lib/interview-api'
import { findInvitationByCapabilityHash, upsertSubmission } from '~/shared/lib/repositories/scheduling'

/**
 * The candidate's own details and consent decisions (plan:
 * calendar-scheduling-interview-intelligence, Phase 5).
 *
 * Details and decisions are written in one transaction because they are one act: the candidate
 * filled in a form that had both on it. Splitting them would allow a state where the identity is
 * stored but the consent that makes storing it lawful is not.
 *
 * The notice version is taken from the server, not the request. A client that could name its own
 * notice version could claim consent against text that never existed.
 */
const RETENTION_DAYS = 180

export const Route = createFileRoute('/api/public/scheduling/$invitationId/submission')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['PUT']),

      PUT: async ({ request, params }) => {
        const refused = await guardPublicRequest(request, true)
        if (refused) return refused

        const parsed = putCandidateSubmissionRequestSchema.safeParse(await request.json().catch(() => ({})))
        if (!parsed.success) return withPublicHeaders(publicError('invalid_input'))

        try {
          const result = await withCapabilityRequest(request, params.invitationId, async ({ transaction, tenant }) => {
            const invitation = await findInvitationByCapabilityHash(transaction, tenant.capabilityHash, new Date())
            if (!invitation) return null

            const submission = await upsertSubmission(transaction, {
              organizationId: tenant.organizationId,
              invitationId: tenant.invitationId,
              displayName: parsed.data.displayName.trim(),
              emailNormalized: parsed.data.email.trim().toLowerCase(),
              notes: parsed.data.notes ?? null,
              retentionExpiresAt: new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60_000),
            })

            const recorded = await recordDecisions(transaction, {
              organizationId: tenant.organizationId,
              invitationId: tenant.invitationId,
              subjectEmail: parsed.data.email,
              noticeVersion: CANDIDATE_NOTICE,
              decisions: parsed.data.consentDecisions,
              // What the transport can attest to. Not the address itself: the ledger already stores a
              // hash of that, and putting it in the evidence hash input would add nothing.
              requestFingerprint: request.headers.get('user-agent') ?? 'unknown',
            })
            if (!recorded.ok) return { kind: 'consent_rejected' as const, reason: recorded.reason }

            return { kind: 'saved' as const, submission, receipts: recorded.receipts }
          })

          if (!result.ok || !result.value) return withPublicHeaders(publicError('invitation_unavailable'))
          if (result.value.kind === 'consent_rejected') {
            return withPublicHeaders(publicError('invalid_input', { reason: result.value.reason }))
          }

          return withPublicHeaders(Response.json({
            submissionVersion: 1,
            // The candidate needs these ids to present with the booking request.
            consentReceipts: result.value.receipts.map((receipt) => ({
              id: receipt.id,
              purpose: receipt.purpose,
              decision: receipt.decision,
              noticeVersion: receipt.noticeVersion,
            })),
          }))
        } catch (error) {
          console.error('public scheduling submission error:', error)
          return withPublicHeaders(publicError('invalid_input'))
        }
      },
    },
  },
})
