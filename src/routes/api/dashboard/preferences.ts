import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { log } from '~/shared/lib/log'
import { dashboardPreferencesWriteSchema } from '~/shared/lib/dashboard/preferences-contract'
import {
  DEFAULT_DASHBOARD_PREFERENCES,
  getDashboardPreferences,
  saveDashboardPreferences,
} from '~/shared/lib/repositories/dashboard-preferences'

/**
 * The user's dashboard layout, read and written (plans/ui-dashboard Wave 6).
 *
 * ## Why the id lists are validated so tightly
 *
 * They are the only user-supplied arrays this product stores and then iterates on every dashboard
 * render. The bound is not about abuse so much as about a bug: a client that appended instead of
 * replacing would grow the row without limit, and nothing downstream would notice until the payload
 * got slow. A cap turns that into a 400 on the request that caused it. Duplicates are refused rather
 * than de-duplicated, because a repeated id in an *order* is an ambiguous instruction and quietly
 * picking one of the two readings is how a layout drifts.
 *
 * Ids are constrained to the shape a widget id can take. Unknown ids are *accepted* — a preference
 * for a widget this build does not have is expected during a rolling deploy, and `mergeWidgetOrder`
 * drops it at render time — but an id shaped like anything else is refused, because the only reason
 * to send one is to find out what happens.
 *
 * ## Critical widgets are not enforced here
 *
 * A user may send `action-queue` in the hidden or pinned list and this route will store it.
 * `orderedWidgets` ignores both on a `criticality: 'critical'` widget, so it changes nothing.
 * Enforcing it at the write would need this route to import the widget registry — a client-side
 * module — and would put the rule in two places, which is how the two eventually disagree. One rule,
 * at the point of use.
 *
 * ## 409 carries the winning document
 *
 * A bare conflict would force the loser to refetch, and it would show its own stale arrangement in the
 * meantime. Returning what won lets the tab adopt it in the same round trip.
 */
export const Route = createFileRoute('/api/dashboard/preferences')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'PUT']),

      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const preferences = await withTenantContext(principal, (transaction) =>
            getDashboardPreferences(transaction, principal.organizationId, principal.userId))
          return Response.json(preferences)
        } catch (error) {
          /*
           * A caller with no tenant gets the **defaults**, not a 403.
           *
           * The response contains no tenant data — a density string and three empty lists — so there
           * is nothing to withhold, and refusing costs something real: the dashboard mounts before the
           * active organization is always settled, and every browser logs a failed subresource to the
           * console. That showed up as two new console errors in the sign-in e2e, which is a strict
           * collector doing exactly its job. The *write* below still refuses, because a write with
           * no tenant has nowhere to go.
           *
           * A failed read is the same answer for the same reason: a layout preference is not worth a
           * broken dashboard, and the default layout is a correct answer to "what should this person
           * see" — just not their preferred one. Both are logged so a persistent failure stays
           * visible to an operator.
           */
          log.error('dashboard_preferences_read_failed', {
            error: error instanceof Error ? error.message : 'unknown',
          })
          return Response.json(DEFAULT_DASHBOARD_PREFERENCES)
        }
      },

      PUT: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const parsed = dashboardPreferencesWriteSchema.safeParse(await request.json().catch(() => null))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid preferences' }, { status: 400 })
          }
          const result = await withTenantContext(principal, (transaction) =>
            saveDashboardPreferences(transaction, principal.organizationId, principal.userId, parsed.data))

          if (!result.ok) {
            return Response.json(
              { error: 'Preferences changed elsewhere', current: result.current },
              { status: 409 },
            )
          }
          return Response.json(result.document)
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          // A failed *write* does get a 500: the user asked for a change and did not get it, and
          // pretending otherwise would have them make it again.
          log.error('dashboard_preferences_write_failed', {
            error: error instanceof Error ? error.message : 'unknown',
          })
          return Response.json({ error: 'Failed to save preferences' }, { status: 500 })
        }
      },
    },
  },
})
