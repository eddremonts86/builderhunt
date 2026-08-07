import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { getTeamInvitationsPage } from '~/shared/lib/organizations/contracts'
import { organizationInvitationsCapability } from '~/shared/lib/table/capabilities/organization-invitations'
import { tablePageHandler } from '~/shared/lib/table/handler'

/**
 * One keyset page of pending invitations.
 *
 * A separate route from the roster rather than one merged people list, for the same reason they
 * are two grids: a member has a role and a seat, an invitation has an expiry and a resend, and
 * the actions do not overlap. `status = 'pending'` is applied by the read, not by a client filter
 * — see `organization-invitations.ts`.
 *
 * No permission check beyond the tenant principal, matching the snapshot this replaced: any member
 * could already see the pending invitations, and Team settings only hides the *section* from
 * someone who cannot manage them.
 */
export const Route = createFileRoute('/api/organizations/team/invitations')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => tablePageHandler({
        capability: organizationInvitationsCapability,
        request,
        load: ({ principal, search }) => getTeamInvitationsPage(principal, search.query, search.page),
      }),
    },
  },
})
