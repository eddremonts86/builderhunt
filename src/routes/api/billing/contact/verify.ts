import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { verifyBillingContact } from '~/shared/lib/billing/billing-contact'
import { withTenantContext } from '~/shared/lib/db/tenant-context'

/** Click-through verification for a billing contact set via `PUT /api/billing/contact` — mirrors `api/builders/claim/verify.ts`'s redirect/callback-URL pattern exactly. */
export const Route = createFileRoute('/api/billing/contact/verify')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = new URL(request.url).searchParams.get('token')
        if (!token) return errorResponse('Missing token')
        try {
          const principal = await requireTenantPrincipal(request)
          const contact = await withTenantContext(principal, (tx) => verifyBillingContact(tx, principal, token))
          if (!contact) return errorResponse('This verification link is invalid or has expired.')
          return redirect('/settings/billing?billingContactVerified=1')
        } catch (error) {
          if (error instanceof TenantAuthorizationError && error.status === 401) {
            const callback = `/api/billing/contact/verify?token=${encodeURIComponent(token)}`
            return redirect(`/auth/sign-in?callbackURL=${encodeURIComponent(callback)}`)
          }
          if (error instanceof TenantAuthorizationError) return errorResponse(error.message)
          console.error('Verify billing contact error:', error)
          return errorResponse('Failed to verify billing contact')
        }
      },
    },
  },
})

function errorResponse(message: string) {
  return redirect(`/settings/billing?billingContactError=${encodeURIComponent(message)}`)
}

function redirect(location: string) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' },
  })
}
