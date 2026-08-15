import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { getUserPreferences } from '~/shared/lib/repositories/user-preferences'
import { getOrganizationEntitlement } from '~/shared/lib/repositories/entitlements'
import { env } from '~/shared/lib/env'
import {
  SHIPPED_DASHBOARD_CAPABILITIES,
  resolveDashboardPresetId,
  type DashboardContext,
} from '~/shared/lib/dashboard-api'

/**
 * Which dashboard route this person is on (plan: phase-2/04-dashboard-personalizado).
 *
 * Small on purpose. The spec forbids a per-segment dashboard endpoint, so this answers *which
 * route* and every widget keeps reading the source it already read — a preset changes the order of
 * the page, never what the page fetches.
 *
 * ## The segment comes from the server, never the request
 *
 * `user_preferences` is the only input. There is no field a caller could send to name a segment,
 * a role or an organization, which is what makes the route a property of the person rather than of
 * whatever the client last claimed. A segment personalises and never authorises: nothing here
 * reaches a permission check, and every widget's data source is authorized independently.
 *
 * ## Why it carries the plan
 *
 * So the dashboard can say "that is on another plan" rather than hiding a widget. Hiding would tell
 * somebody the feature does not exist, which is a different message from the true one — and it
 * would make a preset a second entitlement surface, which the widget inventory rules out.
 */
export const Route = createFileRoute('/api/dashboard/context')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)

          const payload = await withTenantContext(principal, async (transaction) => {
            const [preferences, entitlement] = await Promise.all([
              getUserPreferences(transaction, principal.userId),
              getOrganizationEntitlement(transaction, principal.organizationId),
            ])

            /*
             * The kill switch, enforced here and nowhere else.
             *
             * Off answers `general` whatever the stored segment says, so turning the feature off is
             * one environment variable and a restart rather than a deploy — and the client has no
             * branch of its own that could disagree with it.
             *
             * `segment` still travels: it is the person's own answer, it is already readable from
             * their settings, and blanking it here would make the flag look like data loss.
             */
            const presetsEnabled = env.DASHBOARD_PRESETS_ENABLED === 'true'

            const context: DashboardContext = {
              segment: preferences.primarySegment,
              presetId: resolveDashboardPresetId(preferences.primarySegment, presetsEnabled),
              role: principal.role,
              capabilities: [...SHIPPED_DASHBOARD_CAPABILITIES],
              entitlement: {
                tier: entitlement.tier,
                paidActionsAllowed: entitlement.paidActionsAllowed,
              },
            }
            return context
          })

          return Response.json(payload)
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Dashboard context error:', error)
          return Response.json({ error: 'Failed to read dashboard context' }, { status: 500 })
        }
      },
    },
  },
})
