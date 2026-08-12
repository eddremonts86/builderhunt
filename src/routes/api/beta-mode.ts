import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { getCachedBetaModeStatus } from '~/shared/lib/billing/beta-mode'

/**
 * What a signed-in member may know about beta mode (plan 58, task 9): that it is on, and nothing else.
 *
 * ## The response is two fields, and the omissions are the design
 *
 * No actor, no timestamp, no entitlement, no billing state. A member does not need to know which
 * operator enabled it or when — that is operational history, and it belongs behind
 * `/api/admin/billing/beta-mode`, which requires platform admin. `revision` is included because the
 * badge can use it to notice a change without re-reading anything else; it leaks nothing, since it is a
 * counter with no meaning outside this endpoint.
 *
 * ## It reads the cache, and that is correct here
 *
 * This drives a label. Five seconds of staleness on a badge costs nothing, and it must not add a
 * database read to every dashboard load. Authorization never comes through this path —
 * `getBetaModeState(transaction)` is the authoritative read and it is transaction-scoped precisely so a
 * disable takes effect on the next authorization rather than on a cache expiry.
 *
 * ## Authentication, not authorization
 *
 * `requireTenantPrincipal` because an anonymous caller has no business enumerating platform state, and
 * because a badge is a signed-in surface. Any tenant member may read it — there is nothing here to
 * gate by role.
 */
export const Route = createFileRoute('/api/beta-mode')({
  component: () => null,
  server: {
    handlers: {
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          await requireTenantPrincipal(request)
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          throw error
        }
        const status = await getCachedBetaModeStatus()
        // `updatedAt` is deliberately dropped on the way out, even though the cached value carries it.
        return Response.json({ enabled: status.enabled, revision: status.revision })
      },
    },
  },
})
