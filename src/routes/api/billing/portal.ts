import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { auth } from '~/shared/lib/auth/better-auth'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { BillingAuthorizationError, requireBillingPermission } from '~/shared/lib/billing/permissions'
import { createBillingPortalSession, PortalError, type PortalError as PortalErrorType } from '~/shared/lib/billing/portal'
import { getBillingProvider } from '~/shared/lib/billing/stripe-provider'
import { withTenantContext } from '~/shared/lib/db/tenant-context'

const PortalBody = z.object({
  returnUrl: z.string().url(),
}).strict()

const PORTAL_ERROR_STATUS: Record<PortalErrorType['code'], number> = {
  no_customer: 404,
  invalid_url: 400,
}

/** Owner-only and recent-auth-gated (`'billing:portal'` is in `RECENT_AUTH_REQUIRED_BILLING_ACTIONS`) — a hijacked long-lived session cannot open the Portal without a fresh sign-in. */
export const Route = createFileRoute('/api/billing/portal')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const authSession = await auth.api.getSession({ headers: request.headers })
          requireBillingPermission(
            principal,
            'billing:portal',
            authSession ? { authenticatedAt: new Date(authSession.session.createdAt) } : undefined,
          )

          const parsed = PortalBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }

          const provider = getBillingProvider()
          const result = await withTenantContext(principal, (tx) => createBillingPortalSession(tx, principal, parsed.data, { provider }))
          return Response.json(result)
        } catch (error) {
          if (error instanceof TenantAuthorizationError || error instanceof BillingAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          if (error instanceof PortalError) {
            return Response.json({ error: error.message, code: error.code }, { status: PORTAL_ERROR_STATUS[error.code] })
          }
          console.error('Billing portal session error:', error)
          return Response.json({ error: 'Failed to create portal session' }, { status: 500 })
        }
      },
    },
  },
})
