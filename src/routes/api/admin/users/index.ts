import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { pagePlatformUsersWithBilling } from '~/shared/lib/repositories/platform-billing'
import { platformUsersCapability } from '~/shared/lib/table/capabilities/platform-users'
import { platformTablePageHandler } from '~/shared/lib/table/handler'

export const Route = createFileRoute('/api/admin/users/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      /**
       * One keyset page of users.
       *
       * It used to return every user in the system, and `AdminUsersPage` then filtered them in the
       * browser. That is not only slow: searching fifty loaded rows for an email and finding
       * nothing is a different answer from searching all of them, and the page gave the first while
       * looking like it gave the second. The search is `ILIKE` in Postgres now, over every row.
       *
       * The response no longer carries `pricing`. It was four constants sent on every request, and
       * `AdminUsersPage` already imports them straight from `billing-shared.ts` — the wire copy was
       * never read.
       */
      GET: async ({ request }) => platformTablePageHandler({
        capability: platformUsersCapability,
        request,
        load: ({ search }) => pagePlatformUsersWithBilling(search.query, search.page),
      }),
    },
  },
})
