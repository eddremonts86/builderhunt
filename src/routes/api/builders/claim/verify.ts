/**
 * Legacy token claim verification — retired path, kept only until the last emailed link expires.
 *
 * No claim created by the current code can ever be verified here: `POST /api/builders/:builderId/claim`
 * writes `verificationSecretHash: null`, the flow having moved to a public challenge the claimant
 * publishes on the account itself, and `verifyPendingBuilderClaim` matches the hash with SQL equality,
 * which never matches NULL.
 *
 * It is still reachable because rows from the old flow can still be live. Production ran the token
 * flow from the 2026-07-21 deploy until the 2026-07-27 10:05 UTC deploy — the first one containing the
 * cutover — so a claim minted in that window carries a real hash and a link someone may still have in
 * their inbox. Every version of the old creation path set a 24-hour expiry (unchanged across
 * 2026-07-16, -17 and -20), and `verifyPendingBuilderClaim` enforces `expires_at > now()`, so the last
 * possible unexpired legacy claim dies at **2026-07-28 10:05 UTC**.
 *
 * After that timestamp no row can satisfy the predicate and this route can go. Removing it means four
 * places, not one:
 *   - this file
 *   - `hashClaimSecret` and `verifyPendingBuilderClaim` in repositories/builder-claims.ts — verified
 *     that this route is the only caller of both
 *   - the `surfaces` entry in repositories/builder-claims.test.ts, which `readFile`s this path and
 *     would fail with ENOENT rather than a useful message
 *   - the generated route tree
 * The comment in api/billing/contact/verify.ts citing this file as its redirect/callback pattern goes
 * stale at the same moment and should point somewhere that still exists.
 *
 * The warn below is how to check rather than assume: no `legacy_claim_verify_used` line after the
 * sunset means nobody arrived. That evidence only exists if this commit is deployed before the sunset —
 * absence of the event proves nothing while the event itself is undeployed.
 *
 * Judging this by commit dates rather than deploy dates gives the wrong answer by a full day — the
 * cutover was committed 2026-07-26 but did not reach production until 2026-07-27.
 */
import { createFileRoute } from '@tanstack/react-router'
import { log } from '~/shared/lib/log'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import {
  hashClaimSecret,
  verifyPendingBuilderClaim,
} from '~/shared/lib/repositories/builder-claims'
import { runEnrichment } from '~/shared/lib/ai/run-enrichment'

export const Route = createFileRoute('/api/builders/claim/verify')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = new URL(request.url).searchParams.get('token')
        if (!token) return errorResponse('Missing token')
        // Never the token itself — it is the credential. Whether anyone reached this route at all is
        // the only fact the sunset decision needs.
        log.warn('legacy_claim_verify_used', { hasToken: true })
        try {
          const principal = await requireTenantPrincipal(request)
          const claim = await withTenantContext(principal, (tx) => verifyPendingBuilderClaim(tx, {
            subjectUserId: principal.userId,
            verificationSecretHash: hashClaimSecret(token),
          }))
          if (!claim) return errorResponse('This claim link is invalid or has expired.')

          // Fire-and-forget: this fresh claim shouldn't wait on (or fail because of) an AI call.
          // No-ops safely if the identity isn't tracked in the claimer's active org yet, or if
          // AI is disabled/unconfigured — runEnrichment resolves benignly for both, it never
          // throws for those cases. Only genuine provider/parse failures reach this .catch().
          void runEnrichment(principal, claim.builderIdentityId)
            .catch((err) => console.error('claim enrichment:', err))

          const params = new URLSearchParams({ claimed: '1', builderId: claim.builderIdentityId })
          return redirect(`/me?${params.toString()}`)
        } catch (error) {
          if (error instanceof TenantAuthorizationError && error.status === 401) {
            const callback = `/api/builders/claim/verify?token=${encodeURIComponent(token)}`
            return redirect(`/auth/sign-in?callbackURL=${encodeURIComponent(callback)}`)
          }
          if (error instanceof TenantAuthorizationError) return errorResponse(error.message)
          console.error('Verify claim error:', error)
          return errorResponse('Failed to verify claim')
        }
      },
    },
  },
})

function errorResponse(message: string) {
  return redirect(`/auth/sign-in?${new URLSearchParams({ claimError: message }).toString()}`)
}

function redirect(location: string) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' },
  })
}
