import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import {
  BOOKING_REQUIRED_PURPOSES,
  CANDIDATE_NOTICE,
  guardPublicRequest,
  publicError,
  withCapabilityRequest,
  withPublicHeaders,
} from '~/lib/scheduling/public-route-support'
import { deriveDocumentStatus } from '~/shared/lib/interviews'
import { LINK_AUTHORIZATION_NOTICE_VERSION } from '~/lib/scheduling/link-import-policy'
import { listSubmissionDocuments } from '~/shared/lib/repositories/interview-documents'
import { listLinksForSubmission } from '~/shared/lib/repositories/interview-web-imports'
import {
  findInvitationByCapabilityHash,
  findSubmissionByInvitation,
  listConsentsForInvitation,
} from '~/shared/lib/repositories/scheduling'

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
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request, params }) => {
        const refused = await guardPublicRequest(request, false)
        if (refused) return refused

        try {
          const result = await withCapabilityRequest(request, params.invitationId, async ({ transaction, tenant }) => {
            const invitation = await findInvitationByCapabilityHash(transaction, tenant.capabilityHash, new Date())
            if (!invitation) return null
            const consents = await listConsentsForInvitation(transaction, tenant.organizationId, tenant.invitationId)

            // Documents and links only exist once the candidate has given their details, so a first
            // visit legitimately has neither. Read on the same connection, so RLS scopes them to this
            // invitation without the query having to say so.
            const submission = await findSubmissionByInvitation(transaction, tenant.organizationId, tenant.invitationId)
            const documents = submission === null ? [] : await listSubmissionDocuments(transaction, {
              organizationId: tenant.organizationId,
              submissionId: submission.id,
            })
            const links = submission === null ? [] : await listLinksForSubmission(transaction, {
              organizationId: tenant.organizationId,
              submissionId: submission.id,
            })
            return { invitation, consents, documents, links }
          })

          if (!result.ok || !result.value) return withPublicHeaders(publicError('invitation_unavailable'))

          const { invitation, consents, documents, links } = result.value
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
            attestationVersion: LINK_AUTHORIZATION_NOTICE_VERSION,
            // Deliberately not the object key, the sha256 or the retention date. The portal needs a
            // name to show, a size for the quota, and a status — anything more is detail a candidate's
            // browser has no use for and a shared screen should not display.
            documents: documents.map((document) => ({
              id: document.id,
              originalName: document.originalName,
              bytes: document.bytes,
              status: deriveDocumentStatus(document),
              rejectionCode: document.rejectionCode,
            })),
            links: links.map((link) => ({
              id: link.id,
              url: link.url,
              policyDecision: link.policyDecision,
              importState: link.importState,
              attested: link.authorizationAttestedAt !== null,
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
