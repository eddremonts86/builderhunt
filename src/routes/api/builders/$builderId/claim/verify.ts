import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { rateLimit } from '~/shared/lib/rate-limit'
import { isClaimExpired } from '~/shared/lib/claims'
import { getClaimSourceAdapter } from '~/shared/lib/claim-sources'
import {
  findPendingBuilderClaim,
  getBuilderIdentitySourceInfo,
  verifyBuilderClaimBySourceProof,
} from '~/shared/lib/repositories/builder-claims'
import { runEnrichment } from '~/shared/lib/ai/run-enrichment'

/**
 * Checks whether the caller's pending challenge is actually live in their
 * external profile's bio, then atomically flips the claim to verified. This
 * — not the legacy emailed-link GET at `/api/builders/claim/verify` — is the
 * real proof step for new claims; that route can only ever match a
 * pre-existing legacy claim now that nothing issues a secret hash anymore.
 */
export const Route = createFileRoute('/api/builders/$builderId/claim/verify')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)

          // Checking a third-party API is the expensive/abusable step here,
          // not creating the claim — limit attempts independently of the
          // 5/24h claim-start limit.
          const rl = await rateLimit('builder-claim-verify', `${principal.userId}:${params.builderId}`, 10, 60 * 60)
          if (!rl.allowed) {
            return Response.json(
              { error: 'rate_limited' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.resetMs / 1000)) } },
            )
          }

          const pending = await withTenantContext(principal, (tx) =>
            findPendingBuilderClaim(tx, { subjectUserId: principal.userId, builderIdentityId: params.builderId }),
          )
          if (!pending) return Response.json({ error: 'no_pending_claim' }, { status: 404 })
          if (isClaimExpired(pending.expiresAt)) return Response.json({ error: 'expired' }, { status: 410 })

          const identityInfo = await withTenantContext(principal, (tx) =>
            getBuilderIdentitySourceInfo(tx, params.builderId),
          )
          if (!identityInfo) return Response.json({ error: 'not_found' }, { status: 404 })

          const adapter = getClaimSourceAdapter(pending.evidenceSource)
          if (!adapter) return Response.json({ error: 'unsupported' }, { status: 400 })

          const proof = await adapter.verifyChallenge(identityInfo.username, pending.evidenceReference)
          if (!proof.ok) return Response.json({ error: proof.reason }, { status: 422 })

          const claim = await withTenantContext(principal, (tx) =>
            verifyBuilderClaimBySourceProof(tx, { subjectUserId: principal.userId, builderIdentityId: params.builderId }),
          )
          if (!claim) return Response.json({ error: 'expired' }, { status: 410 })

          void runEnrichment(principal, claim.builderIdentityId)
            .catch((err) => console.error('claim enrichment:', err))

          return Response.json({ ok: true, builderId: claim.builderIdentityId })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Claim verify error:', error)
          return Response.json({ error: 'Failed to verify claim' }, { status: 500 })
        }
      },
    },
  },
})
