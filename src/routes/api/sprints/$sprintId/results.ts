import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { annotateTrackedResults } from '~/lib/sprints/results'
import { findSprint, pageSprintResults } from '~/lib/sprints/service'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { sprintResultsCapability } from '~/shared/lib/table/capabilities/sprint-results'
import { tablePageHandler, TablePageError } from '~/shared/lib/table/handler'
import { getTrackedKeySet } from '~/shared/lib/tracked-builders'

/**
 * One page of a sprint's results.
 *
 * ## What this used to do
 *
 * Read every result for the sprint, then filter, sort and slice them in Node behind a base64
 * *offset* it called a cursor. Three problems, in increasing order of how long they take to notice:
 * it costs O(all results) per request; the offset shifts under concurrent inserts, so a row
 * inserted mid-paging is served twice or skipped; and "sorted by score" meant sorted within
 * whatever slice happened to be loaded.
 *
 * Filtering, sorting, grouping, counting and faceting now all happen in Postgres, through the one
 * keyset builder.
 *
 * ## The two cursors in this feature
 *
 * `sprint.cursor` is **sourcing progress** — which variant and page the worker has reached. It
 * feeds a progress bar and is untouched here. `PageRequest.cursor` is pagination. They are
 * unrelated, and the names are kept distinct so a later reader does not conflate them.
 */

/**
 * The one filter the shared table contract cannot express.
 *
 * `TableQuery.filters` models set membership. A minimum-followers threshold is a range, and growing
 * the shared contract a range operator for one surface is how a contract ends up shaped by its
 * first caller. So the surface owns this parameter: validated here, bound as a parameter there.
 */
const SurfaceParams = z.object({
  minFollowers: z.coerce.number().int().min(0).max(100_000_000).optional(),
})

export const Route = createFileRoute('/api/sprints/$sprintId/results')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request, params }) => tablePageHandler({
        capability: sprintResultsCapability,
        request,
        load: async ({ principal, transaction, search }) => {
          const sprint = await findSprint(transaction, principal.organizationId, params.sprintId)
          if (!sprint) throw new TablePageError(404, 'Sprint not found')

          const surface = SurfaceParams.safeParse(
            Object.fromEntries(new URL(request.url).searchParams),
          )
          if (!surface.success) throw new TablePageError(400, 'Invalid minFollowers')

          const page = await pageSprintResults(transaction, {
            sprintId: params.sprintId,
            query: search.query,
            page: search.page,
            minFollowers: surface.data.minFollowers,
          })

          // `tracked` is the viewer's own state, never a persisted per-row column — the same
          // convention `/api/search/builders` uses. It annotates the page, so it costs one read
          // per request rather than one per row.
          const trackedKeySet = await getTrackedKeySet(transaction, principal.organizationId)
          return { ...page, rows: annotateTrackedResults(page.rows, trackedKeySet) }
        },
      }),
    },
  },
})
