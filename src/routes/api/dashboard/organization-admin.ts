import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { readOrgAdminOverview } from '~/shared/lib/repositories/dashboard-organization-admin'
import { adminRanges } from '~/shared/lib/dashboard/admin-contracts'

/**
 * The organization-admin overview (plan 57, Admin track — "Build the Organization Admin widget section").
 *
 * ## Why this route did not exist until now
 *
 * The projection and the component were both written on 2026-08-07 and marked done, with nothing between them. The
 * projection could not run — it read four tables that do not exist and needed privileges the app role does not have
 * — and the component was mounted by nothing. The projection was rewritten against the real schema on 2026-08-11;
 * this is the half that makes it reachable.
 *
 * ## Why the role gate is here and not in the component
 *
 * `OrganizationAdminSection` renders `null` for a null overview, which is the right default but is not a boundary:
 * a component deciding who may see something has already received it. This route refuses a plain member outright, so
 * the section's data never reaches a browser that should not have it — and the component's `null` is then a
 * rendering detail rather than the security model.
 *
 * ## Why `withTenantContext`
 *
 * The projection reads `organization_members` and `organization_entitlements`, both under RLS scoped to
 * `app.organization_id`. Without the context the member count comes back *empty* rather than refused, which is the
 * worst failure shape available: a workspace with members that reports having none. `withTenantContext` sets it
 * inside a transaction, so it cannot leak to the next query on a pooled connection.
 */
export const Route = createFileRoute('/api/dashboard/organization-admin')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)

          /**
           * Owners and admins only, and a plain member gets 403 rather than an empty payload.
           *
           * An empty payload would be indistinguishable from a workspace with nothing in it, so a member would see
           * the same screen as an admin of an empty organization — and neither of them could tell which they were
           * looking at. The refusal is the honest answer, and it never says what they were refused.
           */
          if (principal.role !== 'owner' && principal.role !== 'admin') {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }

          // An unknown range is a 400, not a silent fallback: a window the caller did not ask for produces numbers
          // they will read as the answer to the question they did ask.
          const requested = new URL(request.url).searchParams.get('range') ?? '24h'
          if (!(adminRanges as readonly string[]).includes(requested)) {
            return Response.json({ error: 'Unsupported range' }, { status: 400 })
          }

          const overview = await withTenantContext(principal, (transaction) =>
            readOrgAdminOverview(transaction, {
              organizationId: principal.organizationId,
              range: requested as (typeof adminRanges)[number],
              now: new Date(),
            }),
          )

          return Response.json(overview)
        } catch (err) {
          if (err instanceof TenantAuthorizationError) {
            return Response.json({ error: 'Unauthorized' }, { status: err.status })
          }
          console.error('organization-admin overview failed:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
