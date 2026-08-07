import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { getTeamMembersPage } from '~/shared/lib/organizations/contracts'
import { organizationMembersCapability } from '~/shared/lib/table/capabilities/organization-members'
import { tablePageHandler } from '~/shared/lib/table/handler'

/**
 * One keyset page of the team roster.
 *
 * Split out of `GET /api/organizations/team`, which used to return every member and every pending
 * invitation alongside the seat count. The roster is a grid now, and a grid asks for pages.
 *
 * The read itself does not run inside this handler's tenant transaction: `builderhunt_app` has no
 * grant on `organization_members`/`auth_users` after the auth-broker split (drizzle/0007), so
 * `pageOrganizationMembers` opens its own auth-broker transaction and sets `app.organization_id`
 * there. `tablePageHandler` is still the right wrapper — it is what authorizes the request and
 * resolves the principal whose organization that id comes from.
 */
export const Route = createFileRoute('/api/organizations/team/members')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => tablePageHandler({
        capability: organizationMembersCapability,
        request,
        load: ({ principal, search }) => getTeamMembersPage(principal, search.query, search.page),
      }),
    },
  },
})
