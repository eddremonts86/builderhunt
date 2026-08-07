import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { pageOrganizationTriggers } from '~/shared/lib/repositories/organization-alerts'
import { alertTriggersCapability } from '~/shared/lib/table/capabilities/alert-triggers'
import { tablePageHandler } from '~/shared/lib/table/handler'

export const Route = createFileRoute('/api/alerts/triggers/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      /**
       * One keyset page of the inbox.
       *
       * It used to answer `listOrganizationTriggers(tx, org, 100)` — bounded, but with no cursor, so
       * match 101 was unreachable and the page's group counts described only what came back. The
       * counts come from the server's facet over the whole filtered set now.
       */
      GET: async ({ request }) => tablePageHandler({
        capability: alertTriggersCapability,
        request,
        load: ({ transaction, search }) => pageOrganizationTriggers(transaction, search.query, search.page),
      }),
    },
  },
})
