import { createFileRoute } from '@tanstack/react-router'
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
