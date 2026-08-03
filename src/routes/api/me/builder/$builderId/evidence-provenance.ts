/**
 * Public Profile Enrichment — verified-subject provenance read (plan: stealth-scraping;
 * plans/UI/tasks.md Wave 4 "Add verified-subject provenance UI" and "Add restrict-processing
 * confirmation and state"). Spec §5.5, §10. Aggregates source (the connector name, never the raw
 * source URL), field categories (payload key names only, never values), observation date, and
 * retention state across every organization's evidence for this identity — never organization,
 * recruiter, job, reviewer, note, or score metadata. Also reports the current processing-restriction
 * state so the UI can render it as durable without a fresh POST on every load.
 */
import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { isVerifiedBuilderClaimant } from '~/shared/lib/repositories/builder-claims'
import { findActiveBuilderProcessingRestriction, listEnrichmentProvenanceForIdentity } from '~/shared/lib/repositories/enrichment-restrictions'

export const Route = createFileRoute('/api/me/builder/$builderId/evidence-provenance')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const isClaimant = await withTenantContext(principal, (tx) =>
            isVerifiedBuilderClaimant(tx, principal.userId, params.builderId))
          if (!isClaimant) return Response.json({ error: 'Not a verified claimant of this profile' }, { status: 403 })

          const [provenance, restriction] = await Promise.all([
            listEnrichmentProvenanceForIdentity(params.builderId),
            findActiveBuilderProcessingRestriction(params.builderId),
          ])
          return Response.json({ provenance, restrictedSince: restriction?.createdAt ?? null })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('evidence-provenance error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
