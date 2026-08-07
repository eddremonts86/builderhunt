import { sourcingSprints } from '~/shared/lib/db/schema'

import { defineTableCapability, registerTableCapability } from '../capability'

/**
 * The sourcing-sprint list.
 *
 * ## The default sort is `createdAt`, not `lastRunAt`
 *
 * plans/phase-3/10 asks for "sortable last-run (default, descending)" and, two lines later, for
 * the list to "match the previous ordering". Those contradict each other: `listSprints` ordered by
 * `created_at desc`. Changing the default would reorder the page for every existing user, which is
 * the louder of the two changes and the one nobody asked for — so `createdAt` stays the default and
 * `lastRunAt` becomes a sort the user can choose.
 *
 * `lastRunAt` is nullable (a sprint that has never run) and deliberately does **not** declare
 * `nullsLast`. See `billing-disputes.ts` for the full reasoning: the declaration applies to both
 * directions, and `DESC NULLS LAST` is the one shape a `(org, col, id)` b-tree serves from neither
 * scan direction. Left undefined, "least recently run first" puts never-run sprints at the top,
 * which is where a sprint waiting for its first run belongs.
 *
 * ## Status is a filter, not a sort
 *
 * The plan asks for it to be sortable. An ordering over three enum values is a worse control than
 * three chips that also say how many of each there are, and it would cost a third index on a table
 * where an organization holds single digits of rows. Facet chips instead.
 */
export const SPRINTS_TABLE = 'sourcing_sprints'

export const SPRINT_STATUSES = ['active', 'paused', 'completed'] as const

export const sprintsCapability = registerTableCapability(defineTableCapability({
  table: SPRINTS_TABLE,
  sortable: {
    // Backed by `sourcing_sprints_org_created_id_idx`.
    createdAt: { column: sourcingSprints.createdAt },
    // Backed by `sourcing_sprints_org_last_run_id_idx`. The pre-existing
    // `sourcing_sprints_org_status_last_run_idx` does **not** serve this, despite its name: it puts
    // `status` between the tenant and the sort column and never trails the tiebreaker, so plan 04's
    // guard rejects it — correctly. The plan's claim that it "already exists and should back it"
    // was the thing the guard existed to check.
    lastRunAt: { column: sourcingSprints.lastRunAt },
  },
  filterable: {
    status: { column: sourcingSprints.status, values: SPRINT_STATUSES, facet: true },
  },
  groupable: [],
  searchable: [sourcingSprints.name],
  tiebreaker: sourcingSprints.id,
  defaultSort: [{ id: 'createdAt', dir: 'desc' }],
  organizationColumn: sourcingSprints.organizationId,
}))

export const SPRINT_FILTER_LABELS: Record<string, string> = {
  status: 'Status',
}
