import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import {
  CANDIDATE_NOTICE,
  guardPublicRequest,
  publicError,
  withCapabilityRequest,
  withPublicHeaders,
} from '~/lib/scheduling/public-route-support'
import {
  LINK_AUTHORIZATION_NOTICE_VERSION,
  decisionPermitsFetch,
  resolveLinkImportPolicy,
} from '~/lib/scheduling/link-import-policy'
import { env } from '~/shared/lib/env'
import { importCandidateLinkRequestSchema } from '~/shared/lib/interview-api'
import {
  findLinkForSubmission,
  recordLinkPolicyDecision,
} from '~/shared/lib/repositories/interview-web-imports'
import { findSubmissionByInvitation } from '~/shared/lib/repositories/scheduling'
import { hasLiveConsent } from '~/lib/scheduling/consent-service'

/**
 * The candidate attests to owning a site and asks for it to be imported (plan:
 * calendar-scheduling-interview-intelligence, Phase 6).
 *
 * ## This route can only ever queue
 *
 * It writes `import_state = 'queued'` and never a terminal state. Letting a client claim `succeeded`
 * would make the evidence a brief later cites rest on the subject's own assertion about what we
 * fetched.
 *
 * ## The attestation is a precondition, and the notice version is the server's
 *
 * The request carries the version the candidate's UI displayed, and it is checked against the server's
 * rather than stored: an attestation recorded against a version the client named would be consent to
 * whatever text that client chose to claim. A mismatch means the page was stale, and the honest
 * response is to ask again.
 *
 * A candidate can attest enthusiastically to owning a LinkedIn profile and the answer is still no —
 * see `link-import-policy.ts`. The policy decision is stored either way, so the portal can explain
 * *why* a link is URL-only instead of showing an import button that does nothing.
 */
export const Route = createFileRoute('/api/public/scheduling/$invitationId/links/$linkId/import')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request, params }) => {
        const refused = await guardPublicRequest(request, true)
        if (refused) return refused

        if (env.CANDIDATE_UPLOADS_ENABLED !== 'true') {
          return withPublicHeaders(publicError('invalid_input', { reason: 'imports_disabled' }))
        }

        const parsed = importCandidateLinkRequestSchema.safeParse(await request.json().catch(() => ({})))
        if (!parsed.success) return withPublicHeaders(publicError('invalid_input'))

        // Checked against the server's constant, not stored from the request.
        if (parsed.data.attestationVersion !== LINK_AUTHORIZATION_NOTICE_VERSION) {
          return withPublicHeaders(publicError('invalid_input', {
            reason: 'attestation_notice_outdated',
            currentVersion: LINK_AUTHORIZATION_NOTICE_VERSION,
          }))
        }

        try {
          const result = await withCapabilityRequest(request, params.invitationId, async ({ transaction, tenant }) => {
            const submission = await findSubmissionByInvitation(transaction, tenant.organizationId, tenant.invitationId)
            if (!submission) return null

            const link = await findLinkForSubmission(transaction, {
              organizationId: tenant.organizationId,
              submissionId: submission.id,
              linkId: params.linkId,
            })
            if (!link) return null

            // See `hasLiveConsent`: the local check this replaces compared against `'granted'`, a
            // decision value that does not exist, so web import was unreachable for every candidate.
            const granted = await hasLiveConsent(transaction, {
              organizationId: tenant.organizationId,
              invitationId: tenant.invitationId,
              purpose: 'public_web_import',
              noticeVersion: CANDIDATE_NOTICE,
            })
            // The separate per-purpose consent, on top of the per-host attestation. Both are required
            // and they answer different questions: whether we may import at all, and whether this
            // particular site is theirs to offer.
            if (!granted) return { kind: 'consent_missing' as const }

            const attestedAt = new Date()
            const policy = resolveLinkImportPolicy({
              normalizedUrl: link.normalizedUrl,
              attested: true,
              attestedNoticeVersion: LINK_AUTHORIZATION_NOTICE_VERSION,
            })

            const permitted = decisionPermitsFetch(policy.decision)
            const [updated] = await recordLinkPolicyDecision(transaction, {
              organizationId: tenant.organizationId,
              linkId: link.id,
              policyDecision: policy.decision,
              importState: permitted ? 'queued' : 'not_importable',
              // Recorded even when the decision refuses the fetch: the candidate did attest, and a
              // later review of why a link was not imported should show that they were asked and
              // answered, not just the outcome.
              attestedNoticeVersion: LINK_AUTHORIZATION_NOTICE_VERSION,
              attestedAt,
            })

            return { kind: 'decided' as const, policy, importState: updated?.importState ?? 'not_requested' }
          })

          if (!result.ok || !result.value) return withPublicHeaders(publicError('invitation_unavailable'))
          if (result.value.kind === 'consent_missing') {
            return withPublicHeaders(publicError('consent_required', { purpose: 'public_web_import' }))
          }

          return withPublicHeaders(Response.json({
            linkId: params.linkId,
            policyDecision: result.value.policy.decision,
            importState: result.value.importState,
            // A stable code the portal turns into a sentence. `platform_terms_forbid_import` is the
            // one candidates most need explained: it is not a rejection of them.
            reason: result.value.policy.reason,
          }))
        } catch (error) {
          console.error('candidate link import error:', (error as Error)?.name)
          return withPublicHeaders(publicError('invalid_input'))
        }
      },
    },
  },
})
