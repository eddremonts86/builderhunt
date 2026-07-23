import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { can } from '~/shared/lib/authorization/permissions'
import { getOwnershipTransferBillingPreview } from '~/shared/lib/billing/contracts'

/**
 * Read-only billing preview shown before confirming an ownership transfer (plans/stripe-billing-
 * platform/tasks.md §9 task 5) — masked payment method, next charge amount/date, and whether the
 * subscription is already scheduled to cancel. Same authority as the transfer action itself
 * (`organization:transfer`, owner-only) since this is purely informational for the same decision;
 * unlike the transfer POST it is NOT recent-auth-gated — nothing here mutates any state.
 */
export const Route = createFileRoute('/api/organizations/transfer-ownership-preview')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          if (!can(principal, 'organization:transfer')) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          const preview = await getOwnershipTransferBillingPreview(principal)
          return Response.json(preview)
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Ownership transfer preview error:', error)
          return Response.json({ error: 'Failed to load transfer preview' }, { status: 500 })
        }
      },
    },
  },
})
