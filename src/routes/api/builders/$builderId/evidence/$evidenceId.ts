/**
 * Public Profile Enrichment — review endpoint (plan: stealth-scraping).
 * Spec §10. Organization admin/owner only; a subject restriction wins over
 * any review decision (checked before allowing accepted).
 */
import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { EvidenceReviewBody } from '~/lib/enrichment/schemas'
import {
  findEnrichmentEvidence,
  isBuilderProcessingRestricted,
  reviewEnrichmentEvidence,
} from '~/shared/lib/repositories/enrichment'

export const Route = createFileRoute('/api/builders/$builderId/evidence/$evidenceId')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['PATCH']),

      PATCH: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          if (principal.role !== 'owner' && principal.role !== 'admin') {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          const parsed = EvidenceReviewBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          const result = await withTenantContext(principal, async (tx) => {
            const evidence = await findEnrichmentEvidence(tx, principal.organizationId, params.evidenceId)
            if (!evidence || evidence.builderIdentityId !== params.builderId) return { kind: 'not_found' as const }
            if (parsed.data.resolution === 'accepted' && await isBuilderProcessingRestricted(tx, params.builderId)) {
              return { kind: 'restricted' as const }
            }
            const updated = await reviewEnrichmentEvidence(tx, principal.organizationId, params.evidenceId, {
              resolution: parsed.data.resolution,
              reviewerUserId: principal.userId,
            })
            return { kind: 'ok' as const, evidence: updated }
          })

          if (result.kind === 'not_found') return Response.json({ error: 'Evidence not found' }, { status: 404 })
          if (result.kind === 'restricted') return Response.json({ error: 'processing_restricted' }, { status: 409 })
          return Response.json(result.evidence)
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('evidence review error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
