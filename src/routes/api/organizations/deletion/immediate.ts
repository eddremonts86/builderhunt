import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { auth } from '~/shared/lib/auth/better-auth'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { getBillingProvider } from '~/shared/lib/billing/stripe-provider'
import { OrganizationDeletionError, requestImmediateDeletion } from '~/shared/lib/organizations/deletion'
import { findOrganizationName } from '~/shared/lib/repositories/account-privacy'

const Body = z.object({
  // The client-side UI must show the org name and the forfeiture warning and
  // gate its own "Delete immediately" button on this matching — mirrors
  // `OrganizationDangerZone.tsx`'s existing type-to-confirm pattern for the
  // scheduled-deletion path. Re-validated here so a scripted call can't skip
  // the confirmation step the UI enforces.
  confirmOrganizationName: z.string().min(1),
}).strict()

/**
 * Immediately (not after a 30-day grace period) cancels the organization's subscription and
 * deletes its product data (plans/phase-1/30-stripe-billing-platform/tasks.md §9 "Integrate subscription-safe
 * organization deletion" — the "immediate path" alongside the existing scheduled
 * `DELETE /api/organizations`). Owner-only, recent-auth-gated (`requestImmediateDeletion` enforces
 * both). Deliberately its own endpoint rather than a body flag on the scheduled route: a
 * fundamentally different, far more destructive action deserves its own audit action name and its
 * own explicit confirmation contract, not a footgun flag on the reversible one.
 */
export const Route = createFileRoute('/api/organizations/deletion/immediate')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const parsed = Body.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          const organizationName = await findOrganizationName(principal.organizationId)
          if (organizationName !== parsed.data.confirmOrganizationName) {
            return Response.json({ error: 'Organization name does not match' }, { status: 400 })
          }

          const authSession = await auth.api.getSession({ headers: request.headers })
          const result = await requestImmediateDeletion(
            principal,
            authSession ? { authenticatedAt: new Date(authSession.session.createdAt) } : undefined,
            { provider: getBillingProvider() },
          )
          return Response.json({ ok: true, requestId: result.requestId })
        } catch (error) {
          if (error instanceof OrganizationDeletionError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Organization immediate delete error:', error)
          return Response.json({ error: 'Failed to delete organization' }, { status: 500 })
        }
      },
    },
  },
})
