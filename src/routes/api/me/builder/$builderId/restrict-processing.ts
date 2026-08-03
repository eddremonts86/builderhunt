/**
 * Public Profile Enrichment — subject restriction endpoint (plan: stealth-scraping).
 * Spec §5.5, §10. Verified-claimant only. Activating restriction cancels
 * queued/running jobs and purges organization evidence payloads across every
 * organization (bounded), while the restriction record itself persists.
 */
import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { isVerifiedBuilderClaimant } from '~/shared/lib/repositories/builder-claims'
import { activateBuilderProcessingRestriction } from '~/shared/lib/repositories/enrichment-restrictions'
import { cascadeBuilderProcessingRestriction } from '~/lib/enrichment/worker'

export const Route = createFileRoute('/api/me/builder/$builderId/restrict-processing')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const isClaimant = await withTenantContext(principal, (tx) =>
            isVerifiedBuilderClaimant(tx, principal.userId, params.builderId))
          if (!isClaimant) return Response.json({ error: 'Not a verified claimant of this profile' }, { status: 403 })

          const restriction = await activateBuilderProcessingRestriction({
            builderIdentityId: params.builderId,
            reason: 'subject_request',
            actorUserId: principal.userId,
          })
          const cascade = await cascadeBuilderProcessingRestriction(params.builderId)
          return Response.json({ restricted: true, since: restriction.createdAt, ...cascade })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('restrict-processing error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
