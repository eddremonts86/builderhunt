/**
 * Public Profile Enrichment — evidence read endpoint (plan: stealth-scraping).
 * Spec §10. Returns latest job summary + non-expired accepted/review
 * evidence for the caller's active organization only.
 */
import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { findLatestEnrichmentJob, listEnrichmentEvidence } from '~/shared/lib/repositories/enrichment'

export const Route = createFileRoute('/api/builders/$builderId/evidence/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const [job, evidence] = await withTenantContext(principal, async (tx) => [
            await findLatestEnrichmentJob(tx, principal.organizationId, params.builderId),
            await listEnrichmentEvidence(tx, principal.organizationId, params.builderId),
          ])
          return Response.json({ job, evidence })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('evidence read error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
