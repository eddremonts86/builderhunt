import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { pageOrganizationDisputes } from '~/shared/lib/billing/disputes'
import { withPlatformOrganization } from '~/shared/lib/repositories/billing-risk'
import { billingDisputesCapability } from '~/shared/lib/table/capabilities/billing-disputes'
import { platformTablePageHandler, TablePageError } from '~/shared/lib/table/handler'

/**
 * Platform-operator read-only view for §8 task 5's chargeback tracking — reuses
 * `repositories/billing-risk.ts`'s `withPlatformOrganization` (same pattern as
 * `api/admin/billing/refunds.ts`). GET only: there is deliberately no operator "decide" mutation
 * here — see `billing/disputes.ts`'s module comment, evidence submission and the won/lost outcome
 * both live in the Stripe Dashboard, not this app. This route exists purely so an operator can see
 * which grants are frozen and why, and when an evidence deadline is coming due.
 */
export const Route = createFileRoute('/api/admin/billing/disputes')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      /**
       * One keyset page of the chargeback view, for one organization.
       *
       * Same shape as the refund queue next door, and for the same reasons: the organization is
       * `filter.organizationId` so it lives in the URL and in the cursor's binding, and it is still
       * required and singular because `builderhunt_platform`'s SELECT policy on `billing_disputes`
       * is org-scoped (drizzle/0036).
       *
       * The read gained an `ORDER BY` on the way. `listDisputes` had none, so the queue's order was
       * whatever Postgres happened to return — the surface looked sorted and was not.
       */
      GET: async ({ request }) => platformTablePageHandler({
        capability: billingDisputesCapability,
        request,
        load: ({ search }) => {
          const selected = search.query.filters.organizationId ?? []
          if (selected.length !== 1) {
            throw new TablePageError(400, 'Exactly one filter.organizationId is required')
          }
          return withPlatformOrganization(selected[0], (tx) =>
            pageOrganizationDisputes(tx, search.query, search.page))
        },
      }),
    },
  },
})
