import { sql } from 'drizzle-orm'

import { sprintResults } from '~/shared/lib/db/schema'

import { defineTableCapability, registerTableCapability } from '../capability'

/**
 * What a client may ask of one sprint's results.
 *
 * The first real capability, and the one that proved plans 02–06 against something other than a
 * fixture. Two things it revealed are worth reading before writing the next one.
 *
 * ## `country` is filterable, not sortable
 *
 * The location facet this surface has always shown comes from `profile->>'country'` — a key inside
 * a jsonb document, which `PgColumn` cannot name. Plan 07 asks for it as sortable *and* filterable.
 * It is filterable (through `ColumnRef`, added for exactly this) and deliberately not sortable: a
 * sortable expression needs an expression index behind it, and `capability-index.ts` matches
 * indexes by column name, so it would report the sort as backed when nothing backs it. A silently
 * unindexed sort is the failure plan 04 exists to prevent; declaring it here would walk straight
 * into it through the one door the guard cannot watch.
 *
 * ## The default sort's index is not the one the plan named
 *
 * `sprint_results_sprint_created_idx` covers `created_at` but leads with `sprint_id`, and RLS puts
 * `organization_id` in every query — so the planner cannot walk it. Plan 04 added
 * `sprint_results_org_sprint_created_id_idx`, which leads with the tenant and trails the
 * tiebreaker. The old index is still used by the worker's per-sprint scans, which carry no tenant
 * predicate.
 */
export const SPRINT_RESULTS_TABLE = 'sprint_results'

/** `profile->>'country'`, the jsonb key the location facet has always been computed from. */
const country = {
  name: 'profile.country',
  sql: sql`${sprintResults.profile}->>'country'`,
}

export const sprintResultsCapability = registerTableCapability(defineTableCapability({
  table: SPRINT_RESULTS_TABLE,
  sortable: {
    // Backed by `sprint_results_org_sprint_created_id_idx`.
    createdAt: { column: sprintResults.createdAt },
    // Backed by `sprint_results_org_sprint_score_id_idx`.
    score: { column: sprintResults.score },
    // Backed by `sprint_results_org_sprint_source_id_idx`.
    source: { column: sprintResults.source },
  },
  filterable: {
    source: { column: sprintResults.source, facet: true },
    // A facet, because the surface it replaces showed location counts and dropping them would be a
    // feature regression wearing a migration's clothes.
    country: { column: country, facet: true },
    matchedVariant: { column: sprintResults.matchedVariant, facet: true },
  },
  // Grouping by a facet dimension is what lets a group header show the server's total; see plan
  // 05's GroupRow.
  groupable: ['source', 'country'],
  searchable: [sprintResults.sourceId, sprintResults.matchedVariant],
  tiebreaker: sprintResults.id,
  // Newest first, matching what the surface showed before the migration.
  defaultSort: [{ id: 'createdAt', dir: 'desc' }],
  organizationColumn: sprintResults.organizationId,
  // Every read is for one sprint, which is why all three indexes are `(organization_id, sprint_id, …)`.
  scopeColumns: [sprintResults.sprintId],
}))

/** Human labels for the filter ids, used by the chips and the command sheet. */
export const SPRINT_RESULT_FILTER_LABELS: Record<string, string> = {
  source: 'Source',
  country: 'Country',
  matchedVariant: 'Variant',
}
